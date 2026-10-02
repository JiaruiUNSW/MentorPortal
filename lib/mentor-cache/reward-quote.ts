import type { OperationPayloads, OperationResults } from '../contracts';
import type { Principal } from '../runtime';
import { callFlow, type FlowCallContext } from '../flow-bridge';
import { fail, MentorError, safeError } from '../mentor-data/errors';
import { cacheConfig, DEFAULT_LIMITS } from './config';
import { ensureState, requireCacheAccount, snapshotFor, stateFor } from './store';
import type { CacheBindings, CatalogSnapshot, SnapshotRow, SyncState } from './types';

type RewardDetail = OperationResults['rewards.get'];
export type RewardQuoteBase = { row: SnapshotRow; state: SyncState };

/** A safe pre-dispatch refusal; its catalog correction must not invalidate private data. */
export class RewardQuoteConflict extends MentorError {
  constructor() { super('VERSION_CONFLICT', 'The reward price or availability has changed. Review the updated reward before submitting again.', 409, false); }
}

export async function captureRewardQuoteBase(bindings: CacheBindings, principal: Principal): Promise<RewardQuoteBase | null> {
  if (bindings.MENTOR_CACHE_ENABLED !== 'true') return null;
  await requireCacheAccount(bindings, principal, cacheConfig(bindings));
  const [row, state] = await Promise.all([snapshotFor(bindings.DB, principal, 'catalog'), stateFor(bindings.DB, principal)]);
  return row && state ? { row, state } : null;
}

/** Fence older collection work but retain both namespaces and all source-age columns. */
export async function queueRewardCatalogRefresh(bindings: CacheBindings, principal: Principal): Promise<void> {
  if (bindings.MENTOR_CACHE_ENABLED !== 'true') return;
  await requireCacheAccount(bindings, principal, cacheConfig(bindings));
  const now = Date.now();
  await ensureState(bindings.DB, principal, now);
  await bindings.DB.prepare("UPDATE mentor_cache_sync_state SET next_catalog_sync_at=min(next_catalog_sync_at,?),lease_token=NULL,lease_expires_at=0,commit_token=NULL,updated_at=? WHERE account_id=? AND mentor_user_id=? AND authorization_state<>'denied' AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active')")
    .bind(now, now, principal.accountId, principal.mentorUserId, principal.accountId, principal.mentorUserId).run();
}

/**
 * The baseline precedes the fresh source read. A concurrent generation, invalidation,
 * authorization change or newly claimed sync lease prevents this older result from
 * replacing newer cache data. This replaces one existing reward, never freshness.
 */
export async function mergeRewardQuote(bindings: CacheBindings, principal: Principal, base: RewardQuoteBase | null, detail: RewardDetail): Promise<boolean> {
  if (!base || bindings.MENTOR_CACHE_ENABLED !== 'true') return false;
  const config = cacheConfig(bindings);
  await requireCacheAccount(bindings, principal, config);
  if (base.row.account_id !== principal.accountId || base.row.mentor_user_id !== principal.mentorUserId || base.row.namespace !== 'catalog' || base.state.authorization_state !== 'authorized') return false;
  if (Date.now() >= Math.min(base.row.hard_expires_at, base.row.synced_at + config.hardAgeMs)) return false;
  const snapshot = JSON.parse(base.row.snapshot_json) as CatalogSnapshot;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rewards)) return false;
  const matches = snapshot.rewards.map((item, index) => item.reward.id === detail.reward.id ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) return false;
  snapshot.rewards[matches[0]] = detail;
  const json = JSON.stringify(snapshot);
  if (new TextEncoder().encode(json).byteLength > DEFAULT_LIMITS.maxSnapshotBytes) return false;
  const token = crypto.randomUUID(), generation = crypto.randomUUID().replaceAll('-', ''), now = Date.now();
  const result = await bindings.DB.batch([
    bindings.DB.prepare("UPDATE mentor_cache_sync_state SET lease_token=NULL,lease_expires_at=0,commit_token=?,updated_at=? WHERE account_id=? AND mentor_user_id=? AND invalidation_version=? AND lease_token IS ? AND authorization_state='authorized' AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active') AND EXISTS (SELECT 1 FROM mentor_cache_snapshots WHERE account_id=? AND mentor_user_id=? AND namespace='catalog' AND generation=?)")
      .bind(token, now, principal.accountId, principal.mentorUserId, base.state.invalidation_version, base.state.lease_token, principal.accountId, principal.mentorUserId, principal.accountId, principal.mentorUserId, base.row.generation),
    bindings.DB.prepare("UPDATE mentor_cache_snapshots SET snapshot_json=?,generation=? WHERE account_id=? AND mentor_user_id=? AND namespace='catalog' AND generation=? AND EXISTS (SELECT 1 FROM mentor_cache_sync_state WHERE account_id=? AND mentor_user_id=? AND commit_token=? AND authorization_state='authorized') AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active')")
      .bind(json, generation, principal.accountId, principal.mentorUserId, base.row.generation, principal.accountId, principal.mentorUserId, token, principal.accountId, principal.mentorUserId),
    bindings.DB.prepare("UPDATE mentor_cache_sync_state SET commit_token=NULL WHERE account_id=? AND mentor_user_id=? AND commit_token=?")
      .bind(principal.accountId, principal.mentorUserId, token),
  ]);
  return result[0].meta.changes === 1 && result[1].meta.changes === 1;
}

/** The source price is a consent check only; the final source adapter computes the charge. */
export async function requireCurrentRewardQuote(bindings: CacheBindings, principal: Principal, payload: OperationPayloads['redemptions.create'], context: FlowCallContext): Promise<void> {
  if (!Number.isFinite(payload.expectedPoints) || payload.expectedPoints < 0) fail('VALIDATION_ERROR', 'Review the reward points before submitting.');
  let base: RewardQuoteBase | null = null;
  try { base = await captureRewardQuoteBase(bindings, principal); }
  catch (error) { console.error(JSON.stringify({ event: 'mentor_reward_quote_cache_unavailable', code: safeError(error).code })); }
  const response = await callFlow(bindings, principal, { operation: 'rewards.get', payload: { rewardId: payload.rewardId } }, crypto.randomUUID(), undefined, undefined, context);
  if (!response.ok) fail('UPSTREAM_UNAVAILABLE', 'The current reward could not be checked.', 503, true);
  const detail = response.data as RewardDetail;
  if (detail.reward.id !== payload.rewardId || detail.options.some(option => option.rewardId !== payload.rewardId) || new Set(detail.options.map(option => option.id)).size !== detail.options.length) fail('OWNERSHIP_DENIED', 'The returned reward does not match this request.', 403);
  if (!Number.isFinite(detail.reward.effectivePoints) || detail.reward.effectivePoints < 0) fail('UPSTREAM_UNAVAILABLE', 'The current reward points could not be checked.', 503, false);
  const selected = payload.optionIds.map(id => detail.options.find(option => option.id === id));
  const optionTypes = new Set(detail.options.map(option => option.type));
  const unavailable = !detail.reward.inStock || selected.some(option => !option || !option.inStock || option.extraCost !== 0)
    || [...optionTypes].some(type => selected.filter(option => option?.type === type).length !== 1);
  if (detail.reward.effectivePoints === payload.expectedPoints && !unavailable) return;
  if (bindings.MENTOR_CACHE_ENABLED === 'true') {
    let merged = false;
    try { merged = await mergeRewardQuote(bindings, principal, base, detail); }
    catch (error) { console.error(JSON.stringify({ event: 'mentor_reward_quote_cache_update_failed', code: safeError(error).code })); }
    if (!merged) {
      try { await queueRewardCatalogRefresh(bindings, principal); }
      catch (error) { console.error(JSON.stringify({ event: 'mentor_reward_quote_refresh_queue_failed', code: safeError(error).code })); }
    }
  }
  throw new RewardQuoteConflict();
}

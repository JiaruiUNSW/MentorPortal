import type { Principal } from '../runtime';
import { MentorError, fail, safeError } from '../mentor-data/errors';
import { requireMentor } from '../mentor-data/validation';
import { cacheConfig, duration, SOURCE_AUTH_DENIALS, syncLimits } from './config';
import { collectCatalog, collectPrivate, sourceReader } from './source';
import { activeAccount, claimLease, denyAccountCache, LostLease, publishSnapshots, recordSyncFailure, releaseLease, stateFor } from './store';
import type { CacheBindings, CacheNamespace, CatalogSnapshot, PrivateSnapshot, SyncOptions, SyncResult } from './types';
import { refreshRedemptionStatus } from './redemption-refresh';

export async function syncMentorAccount(bindings: CacheBindings, principal: Principal, options: SyncOptions = {}): Promise<SyncResult> {
  const result = (status: SyncResult['status'], namespaces: CacheNamespace[] = [], errorCode?: string): SyncResult => ({ accountId: principal.accountId, mentorUserId: principal.mentorUserId, status, namespaces, ...(errorCode ? { errorCode } : {}) });
  requireMentor(principal, 'live');
  const config = cacheConfig(bindings), now = options.now ?? Date.now;
  if (!config.enabled) return result('disabled');
  if (bindings.PORTAL_MODE === 'demo' || !config.allowedUserIds.has(principal.mentorUserId)) return result('not_allowed');
  if (!await activeAccount(bindings, principal)) {
    await denyAccountCache(bindings.DB, principal, now(), now() + config.privateTtlMs, 'MENTOR_FORBIDDEN');
    return result('denied', [], 'MENTOR_FORBIDDEN');
  }
  const limits = syncLimits(options);
  const leaseMs = duration(options.leaseMs, 120_000, 1000, 3_600_000);
  const spacing = duration(options.minimumRequestIntervalMs, 1100, 0, 60_000);
  const retryDelay = duration(options.retryDelayMs, 15 * 60_000, 1000, 3_600_000);
  const requested = [...new Set(options.namespaces ?? ['private', 'catalog'])] as CacheNamespace[];
  if (!requested.length || requested.some(value => value !== 'private' && value !== 'catalog')) fail('VALIDATION_ERROR', 'Choose a supported cache namespace.');
  const previous = await stateFor(bindings.DB, principal);
  const due = (state: typeof previous, time: number) => requested.filter(namespace => options.force || !state || (namespace === 'private' ? state.next_private_sync_at : state.next_catalog_sync_at) <= time);
  if (!due(previous, now()).length) return result('not_due');
  const lease = await claimLease(bindings.DB, principal, now(), leaseMs);
  if (!lease) return result('busy');
  const namespaces = due(lease.state, now());
  if (!namespaces.length) { await releaseLease(bindings.DB, principal, lease, now()); return result('not_due'); }
  try {
    const source = sourceReader(bindings, principal, lease, options, limits, leaseMs, spacing);
    const snapshots: Partial<Record<CacheNamespace, PrivateSnapshot | CatalogSnapshot>> = {};
    if (namespaces.includes('private')) snapshots.private = await collectPrivate(bindings, principal, source, limits);
    if (namespaces.includes('catalog')) snapshots.catalog = await collectCatalog(source, limits);
    const publishedAt = now();
    const committed = await publishSnapshots(bindings.DB, principal, lease, snapshots, config, publishedAt);
    if (!committed) { await releaseLease(bindings.DB, principal, lease, now()); return result('superseded', namespaces); }
    return { ...result('synced', namespaces), syncedAt: new Date(publishedAt).toISOString() };
  } catch (error) {
    if (error instanceof LostLease) { await releaseLease(bindings.DB, principal, lease, now()); return result('superseded', namespaces); }
    const safe = safeError(error);
    if (error instanceof MentorError && SOURCE_AUTH_DENIALS.has(error.code)) {
      // A definitive source denial revokes even last-good data and fences any overlapping sync.
      await denyAccountCache(bindings.DB, principal, now(), now() + config.privateTtlMs, safe.code);
      return result('denied', namespaces, safe.code);
    }
    await recordSyncFailure(bindings.DB, principal, lease, namespaces, now(), now() + retryDelay, safe.code);
    return result('failed', namespaces, safe.code);
  }
}
export interface DueSyncResult { status: 'ok' | 'partial' | 'disabled'; accountsChecked: number; results: SyncResult[] }
export async function runDueSync(bindings: CacheBindings, options: SyncOptions = {}): Promise<DueSyncResult> {
  const config = cacheConfig(bindings);
  if (!config.enabled || bindings.PORTAL_MODE === 'demo') return { status: 'disabled', accountsChecked: 0, results: [] };
  if (!config.allowedUserIds.size) return { status: 'ok', accountsChecked: 0, results: [] };
  const namespaces = [...new Set(options.namespaces ?? ['private', 'catalog'])] as CacheNamespace[];
  if (!namespaces.length || namespaces.some(value => value !== 'private' && value !== 'catalog')) fail('VALIDATION_ERROR', 'Choose a supported cache namespace.');
  const now = (options.now ?? Date.now)();
  const maximum = duration(options.maxAccounts, 20, 1, 100);
  const ids = [...config.allowedUserIds];
  const rows = await bindings.DB.prepare(`SELECT a.id,a.email,a.display_name,a.mentor_user_id FROM auth_accounts a LEFT JOIN mentor_cache_sync_state s ON s.account_id=a.id AND s.mentor_user_id=a.mentor_user_id WHERE a.mode='live' AND a.role='mentor' AND a.status='active' AND a.mentor_user_id IN (${ids.map(() => '?').join(',')}) AND (? OR s.account_id IS NULL OR (? AND (s.next_private_sync_at<=? OR s.next_redemption_sync_at<=?)) OR (? AND s.next_catalog_sync_at<=?)) AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=?) ORDER BY min(coalesce(s.next_private_sync_at,0),coalesce(s.next_catalog_sync_at,0),coalesce(s.next_redemption_sync_at,9007199254740991)),a.id LIMIT ?`).bind(...ids, options.force ? 1 : 0, namespaces.includes('private') ? 1 : 0, now, now, namespaces.includes('catalog') ? 1 : 0, now, now, maximum).all<{ id: string; email: string; display_name: string; mentor_user_id: number }>();
  const results: SyncResult[] = [];
  for (const row of rows.results) {
    const principal: Principal = { accountId: row.id, email: row.email, displayName: row.display_name, mentorUserId: row.mentor_user_id, role: 'mentor', mode: 'live' };
    // A catalog outage must not hold a complete private snapshot hostage. Each
    // namespace commits independently; a definitive identity denial still clears both.
    for (const namespace of ['private', 'catalog'] as const) {
      if (!namespaces.includes(namespace)) continue;
      const result = await syncMentorAccount(bindings, principal, { ...options, namespaces: [namespace] });
      results.push({ ...result, namespaces: [namespace] });
      if (['denied', 'not_allowed', 'disabled', 'busy'].includes(result.status)) break;
      if(namespace==='private'&&result.status==='not_due') {
        const status=await refreshRedemptionStatus(bindings,principal,options);
        if(status.needsFullSync) {
          const full=await syncMentorAccount(bindings,principal,{...options,namespaces:['private'],force:true});
          results.push(full);
          if(['denied','not_allowed','disabled','busy'].includes(full.status))break;
        } else if(status.status!=='not_due') {
          results.push(status);
          if(['denied','not_allowed','disabled','busy'].includes(status.status))break;
        }
      }
    }
  }
  return { status: results.some(result => result.status === 'failed' || result.status === 'denied') ? 'partial' : 'ok', accountsChecked: rows.results.length, results };
}

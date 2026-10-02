import type { Principal } from '../runtime';
import { fail } from '../mentor-data/errors';
import { requireMentor } from '../mentor-data/validation';
import type { CacheBindings, CacheConfig, CacheNamespace, CatalogSnapshot, Lease, PrivateSnapshot, SnapshotRow, SyncState } from './types';

export class LostLease extends Error { constructor() { super('The synchronization lease is no longer current.'); } }
export async function activeAccount(bindings: CacheBindings, principal: Principal): Promise<boolean> {
  return !!await bindings.DB.prepare("SELECT id FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active'").bind(principal.accountId, principal.mentorUserId).first();
}
export async function requireCacheAccount(bindings: CacheBindings, principal: Principal, config: CacheConfig): Promise<void> {
  requireMentor(principal, 'live');
  if (bindings.PORTAL_MODE === 'demo') fail('MENTOR_FORBIDDEN', 'Preview accounts cannot read a live snapshot.', 403);
  if (!config.enabled) fail('DRAFT_NOT_CONFIGURED', 'Background data caching is not enabled.', 503);
  if (!config.allowedUserIds.has(principal.mentorUserId) || !await activeAccount(bindings, principal)) fail('MENTOR_FORBIDDEN', 'This account is not authorized to read synchronized mentor data.', 403);
}
export async function stateFor(db: D1Database, principal: Principal): Promise<SyncState | null> {
  return db.prepare('SELECT * FROM mentor_cache_sync_state WHERE account_id=? AND mentor_user_id=?').bind(principal.accountId, principal.mentorUserId).first<SyncState>();
}
export async function snapshotFor(db: D1Database, principal: Principal, namespace: CacheNamespace): Promise<SnapshotRow | null> {
  return db.prepare('SELECT * FROM mentor_cache_snapshots WHERE account_id=? AND mentor_user_id=? AND namespace=?').bind(principal.accountId, principal.mentorUserId, namespace).first<SnapshotRow>();
}
export async function ensureState(db: D1Database, principal: Principal, now: number): Promise<void> {
  await db.prepare("INSERT INTO mentor_cache_sync_state (account_id,mentor_user_id,lease_expires_at,invalidation_version,next_private_sync_at,next_catalog_sync_at,authorization_state,failure_count,updated_at) VALUES (?,?,0,0,0,0,'unknown',0,?) ON CONFLICT(account_id,mentor_user_id) DO NOTHING").bind(principal.accountId, principal.mentorUserId, now).run();
}
export async function claimLease(db: D1Database, principal: Principal, now: number, leaseMs: number): Promise<Lease | null> {
  await ensureState(db, principal, now);
  const token = crypto.randomUUID();
  const result = await db.prepare("UPDATE mentor_cache_sync_state SET lease_token=?,lease_expires_at=?,commit_token=NULL,last_attempt_at=?,updated_at=? WHERE account_id=? AND mentor_user_id=? AND lease_expires_at<=? AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active')").bind(token, now + leaseMs, now, now, principal.accountId, principal.mentorUserId, now, principal.accountId, principal.mentorUserId).run();
  if (result.meta.changes !== 1) return null;
  const state = await stateFor(db, principal);
  if (!state || state.lease_token !== token) return null;
  return { token, version: state.invalidation_version, state };
}
export async function renewLease(db: D1Database, principal: Principal, lease: Lease, now: number, leaseMs: number): Promise<void> {
  const result = await db.prepare("UPDATE mentor_cache_sync_state SET lease_expires_at=?,updated_at=? WHERE account_id=? AND mentor_user_id=? AND lease_token=? AND lease_expires_at>? AND invalidation_version=? AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active')").bind(now + leaseMs, now, principal.accountId, principal.mentorUserId, lease.token, now, lease.version, principal.accountId, principal.mentorUserId).run();
  if (result.meta.changes !== 1) throw new LostLease();
}
export async function releaseLease(db: D1Database, principal: Principal, lease: Lease, now: number): Promise<void> {
  await db.prepare('UPDATE mentor_cache_sync_state SET lease_token=NULL,lease_expires_at=0,updated_at=? WHERE account_id=? AND mentor_user_id=? AND lease_token=?').bind(now, principal.accountId, principal.mentorUserId, lease.token).run();
}
export async function publishSnapshots(db: D1Database, principal: Principal, lease: Lease, snapshots: Partial<Record<CacheNamespace, PrivateSnapshot | CatalogSnapshot>>, config: CacheConfig, now: number): Promise<boolean> {
  const commit = crypto.randomUUID();
  const statements = [db.prepare("UPDATE mentor_cache_sync_state SET commit_token=? WHERE account_id=? AND mentor_user_id=? AND lease_token=? AND lease_expires_at>? AND invalidation_version=? AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active')").bind(commit, principal.accountId, principal.mentorUserId, lease.token, now, lease.version, principal.accountId, principal.mentorUserId)];
  for (const namespace of ['private', 'catalog'] as const) {
    const snapshot = snapshots[namespace]; if (!snapshot) continue;
    const ttl = namespace === 'private' ? config.privateTtlMs : config.catalogTtlMs;
    statements.push(db.prepare(`INSERT INTO mentor_cache_snapshots (account_id,mentor_user_id,namespace,generation,snapshot_json,synced_at,refresh_after,hard_expires_at,invalidation_version) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM mentor_cache_sync_state WHERE account_id=? AND mentor_user_id=? AND lease_token=? AND commit_token=?) ON CONFLICT(account_id,mentor_user_id,namespace) DO UPDATE SET generation=excluded.generation,snapshot_json=excluded.snapshot_json,synced_at=excluded.synced_at,refresh_after=excluded.refresh_after,hard_expires_at=excluded.hard_expires_at,invalidation_version=excluded.invalidation_version`).bind(principal.accountId, principal.mentorUserId, namespace, crypto.randomUUID().replaceAll('-', ''), JSON.stringify(snapshot), now, now + ttl, now + config.hardAgeMs, lease.version, principal.accountId, principal.mentorUserId, lease.token, commit));
  }
  statements.push(db.prepare("UPDATE mentor_cache_sync_state SET lease_token=NULL,lease_expires_at=0,commit_token=NULL,next_private_sync_at=CASE WHEN ? THEN ? ELSE next_private_sync_at END,next_catalog_sync_at=CASE WHEN ? THEN ? ELSE next_catalog_sync_at END,authorization_state='authorized',failure_count=0,last_error_code=NULL,updated_at=? WHERE account_id=? AND mentor_user_id=? AND lease_token=? AND commit_token=?").bind(snapshots.private ? 1 : 0, now + config.privateTtlMs, snapshots.catalog ? 1 : 0, now + config.catalogTtlMs, now, principal.accountId, principal.mentorUserId, lease.token, commit));
  const results = await db.batch(statements);
  return results[0].meta.changes === 1;
}
export async function denyAccountCache(db: D1Database, principal: Principal, now: number, retryAt: number, code: string): Promise<void> {
  await ensureState(db, principal, now);
  await db.batch([
    db.prepare('DELETE FROM mentor_cache_snapshots WHERE account_id=? AND mentor_user_id=?').bind(principal.accountId, principal.mentorUserId),
    db.prepare("UPDATE mentor_cache_sync_state SET authorization_state='denied',lease_token=NULL,lease_expires_at=0,commit_token=NULL,invalidation_version=invalidation_version+1,next_private_sync_at=?,next_catalog_sync_at=?,failure_count=failure_count+1,last_error_code=?,updated_at=? WHERE account_id=? AND mentor_user_id=?").bind(retryAt, retryAt, code, now, principal.accountId, principal.mentorUserId),
  ]);
}
export async function recordSyncFailure(db: D1Database, principal: Principal, lease: Lease, namespaces: CacheNamespace[], now: number, retryAt: number, code: string): Promise<void> {
  await db.prepare('UPDATE mentor_cache_sync_state SET lease_token=NULL,lease_expires_at=0,commit_token=NULL,next_private_sync_at=CASE WHEN ? THEN ? ELSE next_private_sync_at END,next_catalog_sync_at=CASE WHEN ? THEN ? ELSE next_catalog_sync_at END,failure_count=failure_count+1,last_error_code=?,updated_at=? WHERE account_id=? AND mentor_user_id=? AND lease_token=?').bind(namespaces.includes('private') ? 1 : 0, retryAt, namespaces.includes('catalog') ? 1 : 0, retryAt, code, now, principal.accountId, principal.mentorUserId, lease.token).run();
}
export async function invalidateMentorCache(bindings: CacheBindings, principal: Principal): Promise<void> {
  const now = Date.now(); requireMentor(principal, 'live');
  await ensureState(bindings.DB, principal, now);
  // Fence in-flight work, retain last-good, and let only the background runner refresh it.
  await bindings.DB.prepare('UPDATE mentor_cache_sync_state SET invalidation_version=invalidation_version+1,next_private_sync_at=?,next_catalog_sync_at=?,lease_token=NULL,lease_expires_at=0,commit_token=NULL,updated_at=? WHERE account_id=? AND mentor_user_id=?').bind(now, now, now, principal.accountId, principal.mentorUserId).run();
}

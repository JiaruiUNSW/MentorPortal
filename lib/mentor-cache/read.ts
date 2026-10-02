import type { BridgeResponse, ClientRequest, GroupDto, OperationPayloads } from '../contracts';
import type { Principal } from '../runtime';
import { fail } from '../mentor-data/errors';
import { canonicalJson, sha256 } from '../mentor-data/store';
import { cacheConfig } from './config';
import { requireCacheAccount, stateFor } from './store';
import type { CacheBindings, CacheNamespace, CatalogSnapshot, PrivateSnapshot, SnapshotRow } from './types';

const catalogOperations = new Set(['rewards.list', 'rewards.get']);
const readOperations = new Set(['bootstrap','groups.list','groups.get','reports.list','reports.get','balance.get','transactions.list','rewards.list','rewards.get','profile.get','tickets.list','tickets.get','redemptions.list']);
interface ReadRow extends SnapshotRow {
  authorization_state: string;
  current_invalidation_version: number;
  next_private_sync_at: number;
  next_catalog_sync_at: number;
}
function groupPeriod(group: GroupDto, period: string | undefined, now: number): boolean {
  if (!period || period === 'all') return true;
  if (!group.startDate) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const cutoff = new Date(`${today}T00:00:00.000Z`); cutoff.setUTCDate(cutoff.getUTCDate() - 26);
  return period === 'past' ? group.startDate < cutoff.toISOString().slice(0,10) : period === 'future' ? group.startDate > today : group.startDate >= cutoff.toISOString().slice(0,10) && group.startDate <= today;
}
async function page<T>(items: T[], principal: Principal, request: ClientRequest, row: SnapshotRow): Promise<{ items: T[]; nextCursor: string | null }> {
  const payload = request.payload as { cursor?: string; limit?: number } & Record<string, unknown>;
  const limit = payload.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('VALIDATION_ERROR', 'Choose a page size between one and 50.');
  const fields = { ...payload, cursor: undefined, limit };
  const signature = (await sha256(canonicalJson({ accountId: principal.accountId, mentorUserId: principal.mentorUserId, operation: request.operation, fields }))).slice(0,16);
  let offset = 0;
  if (payload.cursor) {
    const match = /^mc1\.([a-f0-9]{32})\.([a-f0-9]{16})\.(0|[1-9]\d{0,5})$/.exec(payload.cursor);
    if (!match || match[1] !== row.generation || match[2] !== signature) fail('VERSION_CONFLICT', 'The cached collection changed. Reload its first page.', 409);
    offset = Number(match[3]);
    if (offset >= items.length) fail('VALIDATION_ERROR', 'The continuation cursor is outside this collection.');
  }
  const next = offset + limit;
  return { items: items.slice(offset,next), nextCursor: next < items.length ? `mc1.${row.generation}.${signature}.${next}` : null };
}
export async function readCachedMentor(bindings: CacheBindings, principal: Principal, request: ClientRequest, requestId = crypto.randomUUID()): Promise<BridgeResponse> {
  const config = cacheConfig(bindings); await requireCacheAccount(bindings, principal, config);
  if (!readOperations.has(request.operation)) fail('VALIDATION_ERROR', 'This operation must use the live authorization and write path.');
  const namespace: CacheNamespace = catalogOperations.has(request.operation) ? 'catalog' : 'private';
  // One read joins the active account, authorization tombstone and complete snapshot.
  const row = await bindings.DB.prepare("SELECT s.*,c.authorization_state,c.invalidation_version AS current_invalidation_version,c.next_private_sync_at,c.next_catalog_sync_at FROM mentor_cache_snapshots s JOIN mentor_cache_sync_state c ON c.account_id=s.account_id AND c.mentor_user_id=s.mentor_user_id JOIN auth_accounts a ON a.id=s.account_id AND a.mentor_user_id=s.mentor_user_id WHERE s.account_id=? AND s.mentor_user_id=? AND s.namespace=? AND a.mode='live' AND a.role='mentor' AND a.status='active'").bind(principal.accountId, principal.mentorUserId, namespace).first<ReadRow>();
  if (!row) {
    const state = await stateFor(bindings.DB, principal);
    if (state?.authorization_state === 'denied') fail('MENTOR_FORBIDDEN', 'Source access is not currently authorized for this account.', 403, false, requestId);
    fail('CACHE_PENDING', 'Your data is waiting for background synchronization. Please check again shortly.', 503, true, requestId);
  }
  if (row.authorization_state !== 'authorized') fail('MENTOR_FORBIDDEN', 'Source access is not currently authorized for this account.', 403, false, requestId);
  const now = Date.now();
  if (now >= Math.min(row.hard_expires_at, row.synced_at + config.hardAgeMs)) fail('CACHE_EXPIRED', 'The last successful snapshot is too old to display. Background synchronization must finish first.', 503, true, requestId);
  const configuredTtl = namespace === 'private' ? config.privateTtlMs : config.catalogTtlMs;
  const stale = now >= Math.min(row.refresh_after, row.synced_at + configuredTtl) || row.current_invalidation_version !== row.invalidation_version;
  const next = namespace === 'private' ? row.next_private_sync_at : row.next_catalog_sync_at;
  const dataSync = { lastSyncedAt: new Date(row.synced_at).toISOString(), nextSyncAt: new Date(next || row.refresh_after).toISOString(), stale };
  let data: unknown;
  if (namespace === 'catalog') {
    const snapshot = JSON.parse(row.snapshot_json) as CatalogSnapshot;
    if (snapshot.schemaVersion !== 1) fail('UPSTREAM_UNAVAILABLE', 'The stored catalog snapshot cannot be read.', 503);
    if (request.operation === 'rewards.list') data = await page(snapshot.rewards.map(item => item.reward), principal, request, row);
    else { data = snapshot.rewards.find(item => item.reward.id === (request.payload as OperationPayloads['rewards.get']).rewardId); if (!data) fail('RECORD_NOT_FOUND', 'This reward is not present in the current authorized snapshot.', 404); }
  } else {
    const snapshot = JSON.parse(row.snapshot_json) as PrivateSnapshot;
    if (snapshot.schemaVersion !== 1) fail('UPSTREAM_UNAVAILABLE', 'The stored private snapshot cannot be read.', 503);
    const groups = snapshot.groups;
    const group = (id: string) => { const item = groups.find(item => item.group.id === id); if (!item) fail('RECORD_NOT_FOUND', 'This group is not present in your current authorized snapshot.', 404); return item; };
    switch (request.operation) {
      case 'bootstrap': {
        const current = groups.filter(item => groupPeriod(item.group, 'current', now));
        data = { ...snapshot.bootstrap, balance: snapshot.balance, groups: current.map(item => item.group), tasks: current.flatMap(item => item.tasks.map(task => ({ ...task, groupId: item.group.id }))), dataSync }; break;
      }
      case 'groups.list': data = await page(groups.map(item => item.group).filter(item => groupPeriod(item, (request.payload as OperationPayloads['groups.list']).period, now)), principal, request, row); break;
      case 'groups.get': data = group((request.payload as OperationPayloads['groups.get']).groupId); break;
      case 'reports.list': {
        const p = request.payload as OperationPayloads['reports.list']; const source = p.groupId ? [group(p.groupId)] : groups;
        data = await page(source.flatMap(item => item.reports).filter(report => !p.kind || report.kind === p.kind), principal, request, row); break;
      }
      case 'reports.get': {
        const p = request.payload as OperationPayloads['reports.get']; const report = groups.flatMap(item => item.reports).find(item => item.id === p.reportId && item.kind === p.kind);
        if (!report) fail('RECORD_NOT_FOUND', 'This report is not present in your current authorized snapshot.', 404); data = { report }; break;
      }
      case 'balance.get': data = snapshot.balance; break;
      case 'profile.get': data = snapshot.profile; break;
      case 'transactions.list': data = await page(snapshot.transactions, principal, request, row); break;
      case 'redemptions.list': data = await page(snapshot.redemptions, principal, request, row); break;
      case 'tickets.list': {
        const search = (request.payload as OperationPayloads['tickets.list']).search?.toLowerCase();
        data = await page(snapshot.tickets.filter(ticket => !search || `${ticket.title} ${ticket.description}`.toLowerCase().includes(search)), principal, request, row); break;
      }
      case 'tickets.get': {
        const ticket = snapshot.tickets.find(item => item.id === (request.payload as OperationPayloads['tickets.get']).ticketId); if (!ticket) fail('RECORD_NOT_FOUND', 'This ticket is not present in your current authorized snapshot.', 404); data = { ticket }; break;
      }
      default: fail('VALIDATION_ERROR', 'This operation is not available from the cache.');
    }
  }
  return { schemaVersion: '1.0', requestId, ok: true, data } as BridgeResponse;
}

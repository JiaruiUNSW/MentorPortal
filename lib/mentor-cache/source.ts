import type { BridgeResponse, ClientRequest, Operation, OperationPayloads, OperationResults, Page } from '../contracts';
import type { Principal } from '../runtime';
import { callFlow } from '../flow-bridge';
import { fail, safeError } from '../mentor-data/errors';
import { projectLiveAttachments } from '../mentor-data/files';
import { CREDIT_CRITERIA } from '../mentor-data/credit-criteria';
import type { CacheBindings, CatalogSnapshot, Lease, PrivateSnapshot, RedemptionStatusSnapshot, SyncLimits, SyncOptions } from './types';
import { renewLease } from './store';

export interface SourceReader {
  read<O extends Operation>(operation: O, payload: OperationPayloads[O]): Promise<OperationResults[O]>;
  page<O extends 'groups.list' | 'transactions.list' | 'tickets.list' | 'redemptions.list' | 'rewards.list'>(operation: O, base: Record<string, unknown>, maximum: number): Promise<OperationResults[O]['items']>;
}
function sourceNumber(id: string): number {
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647) fail('UPSTREAM_UNAVAILABLE', 'A source collection contains an invalid record identifier.', 502);
  return Number(id);
}
export function boundedSnapshot(value: unknown, maximum: number): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) fail('UPSTREAM_UNAVAILABLE', 'The complete snapshot exceeds its configured storage bound.', 502);
}
export function sourceReader(bindings: CacheBindings, principal: Principal, lease: Lease, options: SyncOptions, limits: SyncLimits, leaseMs: number, spacingMs: number): SourceReader {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastStarted = Number.NEGATIVE_INFINITY, requests = 0;
  async function read<O extends Operation>(operation: O, payload: OperationPayloads[O]): Promise<OperationResults[O]> {
    if (++requests > limits.maxRequests) fail('UPSTREAM_UNAVAILABLE', 'The synchronization request budget was exceeded.', 502);
    const wait = spacingMs - (now() - lastStarted);
    if (wait > 0) await sleep(wait);
    await renewLease(bindings.DB, principal, lease, now(), leaseMs);
    lastStarted = now();
    const requestId = crypto.randomUUID();
    let response: BridgeResponse;
    try {
      response = await callFlow(bindings, principal, { operation, payload } as ClientRequest, requestId, undefined, options.fetcher);
    } catch (error) {
      const safe = safeError(error);
      console.error(JSON.stringify({ event: 'mentor_cache_source_read_failed', operation, requestId, code: safe.code, status: safe.status }));
      throw safe;
    }
    await renewLease(bindings.DB, principal, lease, now(), leaseMs);
    if (!response.ok) fail(response.error.code, response.error.message, 503, response.error.retryable);
    return response.data as OperationResults[O];
  }
  async function page<O extends 'groups.list' | 'transactions.list' | 'tickets.list' | 'redemptions.list' | 'rewards.list'>(operation: O, base: Record<string, unknown>, maximum: number): Promise<OperationResults[O]['items']> {
    const items: { id: string }[] = []; let cursor: string | undefined, previous = 0;
    const seen = new Set<string>();
    for (let index = 0; index < limits.maxPages; index++) {
      const result = await read(operation, { ...base, limit: 50, ...(cursor ? { cursor } : {}) } as OperationPayloads[O]) as Page<{ id: string }>;
      let last = previous;
      for (const item of result.items) {
        const number = sourceNumber(item.id);
        if (number <= last || seen.has(item.id)) fail('UPSTREAM_UNAVAILABLE', 'Source pagination repeated or reordered a record.', 502);
        last = number; seen.add(item.id); items.push(item);
      }
      if (items.length > Math.min(maximum, limits.maxListItems)) fail('UPSTREAM_UNAVAILABLE', 'The complete source collection exceeds its configured bound.', 502);
      if (result.nextCursor === null) return items as OperationResults[O]['items'];
      const next = sourceNumber(result.nextCursor);
      if (!result.items.length || next !== last || next <= previous) fail('UPSTREAM_UNAVAILABLE', 'The source returned an invalid continuation cursor.', 502);
      cursor = result.nextCursor; previous = next;
    }
    fail('UPSTREAM_UNAVAILABLE', 'The complete source collection exceeded its page limit.', 502);
  }
  return { read, page };
}
export async function collectPrivate(bindings: CacheBindings, principal: Principal, source: SourceReader, limits: SyncLimits): Promise<PrivateSnapshot> {
  const bootstrap = await source.read('bootstrap', {});
  const profile = await source.read('profile.get', {});
  const sourceBalance = await source.read('balance.get', {});
  // These are the existing Canvas presentation rules, never an award/debit authority.
  const balance = { ...sourceBalance, creditCriteria: sourceBalance.creditCriteria ?? CREDIT_CRITERIA };
  if (bootstrap.mentor.id !== String(principal.mentorUserId) || profile.profile.id !== String(principal.mentorUserId)) fail('OWNERSHIP_DENIED', 'Source identity does not match the authenticated Mentor mapping.', 403);
  const groups = await source.page('groups.list', { period: 'all' }, limits.maxGroups);
  const detail: OperationResults['groups.get'][] = [];
  const reportKeys = new Set<string>(), expenseIds = new Set<string>(), menteeIds = new Set<string>();
  for (const group of groups) {
    const item = await source.read('groups.get', { groupId: group.id });
    if (item.group.id !== group.id) fail('OWNERSHIP_DENIED', 'The source returned a different group.', 403);
    const meetups = new Set(item.reports.filter(r => r.kind === 'meetup').map(r => r.id));
    for (const report of item.reports) {
      const key = `${report.kind}:${report.id}`;
      if (report.groupId !== group.id || reportKeys.has(key)) fail('OWNERSHIP_DENIED', 'A report does not belong exclusively to its cached group.', 403);
      reportKeys.add(key);
      if (report.attachments.some(file => file.parentKind !== 'meetupReport' || file.parentId !== report.id)) fail('OWNERSHIP_DENIED', 'A report attachment has an inconsistent parent.', 403);
    }
    for (const expense of item.expenses) {
      if (expense.groupId !== group.id || !meetups.has(expense.meetupReportId) || expenseIds.has(expense.id)) fail('OWNERSHIP_DENIED', 'An expense has an inconsistent group or meet-up parent.', 403);
      expenseIds.add(expense.id);
      if (expense.attachments.some(file => file.parentKind !== 'expense' || file.parentId !== expense.id)) fail('OWNERSHIP_DENIED', 'A receipt has an inconsistent parent.', 403);
    }
    for (const mentee of item.mentees) {
      if (menteeIds.has(mentee.id)) fail('OWNERSHIP_DENIED', 'A mentee appears in more than one cached group.', 403);
      menteeIds.add(mentee.id);
    }
    detail.push(item); boundedSnapshot(detail, limits.maxSnapshotBytes);
  }
  const transactions = await source.page('transactions.list', {}, limits.maxListItems);
  const tickets = await source.page('tickets.list', {}, limits.maxTickets);
  const ticketDetails: OperationResults['tickets.get']['ticket'][] = [];
  for (const ticket of tickets) {
    const response = await source.read('tickets.get', { ticketId: ticket.id });
    if (response.ticket.id !== ticket.id || response.ticket.attachments.some(file => file.parentKind !== 'ticket' || file.parentId !== ticket.id)) fail('OWNERSHIP_DENIED', 'A ticket or its attachment has an inconsistent owner target.', 403);
    ticketDetails.push(response.ticket); boundedSnapshot(ticketDetails, limits.maxSnapshotBytes);
  }
  const redemptions = await source.page('redemptions.list', {}, limits.maxListItems);
  // Store no obsolete bootstrap group/report graph: all details below were fetched together.
  const snapshot: PrivateSnapshot = {
    schemaVersion: 1,
    bootstrap: { ...bootstrap, mentor: { id: profile.profile.id, displayName: profile.profile.displayName, preferredName: profile.profile.preferredName, communicationEmail: profile.profile.communicationEmail }, balance, groups: [], tasks: [], mode: 'live', previewLabel: null },
    profile, balance, groups: detail, transactions, tickets: ticketDetails, redemptions,
  };
  boundedSnapshot(snapshot, limits.maxSnapshotBytes);
  // This only persists opaque metadata handles. It performs no HTTP and stores no attachment bytes.
  const projected = await projectLiveAttachments(bindings, principal, snapshot, crypto.randomUUID()) as PrivateSnapshot;
  boundedSnapshot(projected, limits.maxSnapshotBytes);
  return projected;
}
export async function collectCatalog(source: SourceReader, limits: SyncLimits): Promise<CatalogSnapshot> {
  const rows = await source.page('rewards.list', {}, limits.maxRewards);
  const rewards: OperationResults['rewards.get'][] = [];
  for (const reward of rows) {
    const item = await source.read('rewards.get', { rewardId: reward.id });
    if (item.reward.id !== reward.id || item.options.some(option => option.rewardId !== reward.id)) fail('OWNERSHIP_DENIED', 'A reward option does not belong to its source reward.', 403);
    rewards.push(item); boundedSnapshot(rewards, limits.maxSnapshotBytes);
  }
  const snapshot: CatalogSnapshot = { schemaVersion: 1, rewards };
  boundedSnapshot(snapshot, limits.maxSnapshotBytes);
  return snapshot;
}
/** Existing actor-authorized read RPCs only; no profile/group/catalog or attachment reads. */
export async function collectRedemptionStatus(source: SourceReader, limits: SyncLimits): Promise<RedemptionStatusSnapshot> {
  const redemptions = await source.page('redemptions.list', {}, limits.maxListItems);
  const sourceBalance = await source.read('balance.get', {});
  const transactions = await source.page('transactions.list', {}, limits.maxListItems);
  const result = { redemptions, transactions, balance: { ...sourceBalance, creditCriteria: sourceBalance.creditCriteria ?? CREDIT_CRITERIA } };
  boundedSnapshot(result, limits.maxSnapshotBytes);
  return result;
}

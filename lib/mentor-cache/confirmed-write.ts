import type { AttachmentDto, BridgeResponse, ClientRequest, GroupDto, OperationResults, ReportDto, TicketDto, ExpenseDto } from '../contracts';
import type { Principal } from '../runtime';
import { fail } from '../mentor-data/errors';
import { ownFile } from '../mentor-data/files';
import { isWrite } from '../mentor-data/validation';
import { cacheConfig, DEFAULT_LIMITS } from './config';
import { invalidateMentorCache, requireCacheAccount, snapshotFor, stateFor } from './store';
import type { CacheBindings, PrivateSnapshot } from './types';

export interface ConfirmationOptions { completedAt: number; replayed?: boolean }
type Versioned = { version?: string; modifiedAt?: string | null };
function numericVersion(version: string | undefined): bigint | undefined {
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(version ?? '');
  return match ? BigInt(match[1]) : undefined;
}
function upsert<T>(items: T[], value: T, same: (item: T) => boolean) {
  const index = items.findIndex(same);
  if (index < 0) items.unshift(value); else items[index] = value;
}
function refreshConfirmedTasks(detail: OperationResults['groups.get']) {
  const group = detail.group;
  const confirmed: Record<string, string | null> = {
    'attendance.first': group.firstAttendanceUpdatedAt, 'attendance.final': group.attendanceUpdatedAt,
    'report.week1': group.week1ReportedAt, 'report.meetup1': group.firstMeetupReportedAt,
    'report.meetup2': group.secondMeetupReportedAt, 'report.completion': group.completedAt,
  };
  detail.tasks = detail.tasks.map(task => confirmed[task.key] ? { ...task, status: 'Completed', ...(task.key.startsWith('report.') ? { submissionState: 'submitted' as const } : {}) } : task);
}
function mergeConfirmed(snapshot: PrivateSnapshot, principal: Principal, request: ClientRequest, response: BridgeResponse, options: ConfirmationOptions) {
  if (!response.ok) return;
  const payload = request.payload as Record<string, unknown>;
  const receipts = snapshot.confirmedWrites ??= {};
  const allow = (key: string, current?: Versioned, incoming?: Versioned) => {
    const previous = numericVersion(current?.version), next = numericVersion(incoming?.version);
    if (previous !== undefined && next !== undefined && previous > next) return false;
    const newerVersion = previous !== undefined && next !== undefined && next > previous;
    if (!newerVersion && receipts[key]?.completedAt > options.completedAt) return false;
    if (current?.modifiedAt && incoming?.modifiedAt && current.modifiedAt > incoming.modifiedAt) return false;
    receipts[key] = { requestId: response.requestId, completedAt: options.completedAt };
    return true;
  };
  const groupDetail = (groupId: string) => {
    if (payload.groupId !== groupId) fail('OWNERSHIP_DENIED', 'The confirmed group does not match this request.', 403);
    return snapshot.groups.find(item => item.group.id === groupId);
  };
  const applyGroup = (detail: OperationResults['groups.get'], group: GroupDto) => {
    if (allow(`group:${group.id}`, detail.group, group)) { detail.group = group; refreshConfirmedTasks(detail); }
  };
  switch (request.operation) {
    case 'profile.update': {
      const { profile } = response.data as OperationResults['profile.update'];
      if (profile.id !== String(principal.mentorUserId)) fail('OWNERSHIP_DENIED', 'The confirmed profile does not match this account.', 403);
      if (allow('profile', snapshot.profile.profile, profile)) {
        snapshot.profile.profile = profile;
        snapshot.bootstrap.mentor = { id: profile.id, displayName: profile.displayName, preferredName: profile.preferredName, communicationEmail: profile.communicationEmail };
      }
      break;
    }
    case 'attendance.save': {
      const data = response.data as OperationResults['attendance.save'], detail = groupDetail(data.group.id);
      if (!detail) break; // A write response cannot construct or reauthorize a missing group snapshot.
      applyGroup(detail, data.group);
      for (const mentee of data.mentees) {
        const current = detail.mentees.find(item => item.id === mentee.id);
        if (allow(`mentee:${mentee.id}`, current, mentee)) upsert(detail.mentees, mentee, item => item.id === mentee.id);
      }
      break;
    }
    case 'reports.week1.save': case 'reports.meetup.save': case 'reports.completion.save': {
      const { group, report } = response.data as OperationResults['reports.meetup.save'];
      if (report.groupId !== group.id || report.kind !== request.operation.split('.')[1] || (payload.reportId && payload.reportId !== report.id)) fail('OWNERSHIP_DENIED', 'The confirmed report does not match this request.', 403);
      const detail = groupDetail(group.id); if (!detail) break;
      applyGroup(detail, group);
      const same = (item: ReportDto) => item.id === report.id && item.kind === report.kind;
      if (allow(`report:${report.kind}:${report.id}`, detail.reports.find(same), report)) upsert(detail.reports, report, same);
      detail.group.meetupCount = detail.reports.filter(item => item.kind === 'meetup').length;
      break;
    }
    case 'expenses.save': {
      const { expense } = response.data as OperationResults['expenses.save'];
      if (expense.meetupReportId !== payload.meetupReportId || (payload.expenseId && expense.id !== payload.expenseId)) fail('OWNERSHIP_DENIED', 'The confirmed expense does not match this request.', 403);
      const detail = groupDetail(expense.groupId); if (!detail) break;
      if (allow(`expense:${expense.id}`, detail.expenses.find(item => item.id === expense.id), expense)) upsert(detail.expenses, expense, item => item.id === expense.id);
      break;
    }
    case 'tickets.create': case 'tickets.update': {
      const { ticket } = response.data as OperationResults['tickets.create'];
      if (payload.ticketId && payload.ticketId !== ticket.id) fail('OWNERSHIP_DENIED', 'The confirmed ticket does not match this request.', 403);
      if (allow(`ticket:${ticket.id}`, snapshot.tickets.find(item => item.id === ticket.id), ticket)) upsert(snapshot.tickets, ticket, item => item.id === ticket.id);
      break;
    }
    case 'redemptions.create': {
      const { redemption } = response.data as OperationResults['redemptions.create'];
      if (redemption.rewardId !== payload.rewardId) fail('OWNERSHIP_DENIED', 'The confirmed redemption does not match this request.', 403);
      if (allow(`redemption:${redemption.id}`)) upsert(snapshot.redemptions, redemption, item => item.id === redemption.id);
      // The response acknowledges a request, not the resulting balance, stock or approval.
      break;
    }
    case 'attachments.upload': case 'attachments.delete': {
      const data = response.data as OperationResults['attachments.upload'] & OperationResults['attachments.delete'];
      if (!data.parentVersion || !payload.parentId) break;
      let parent: ReportDto | TicketDto | ExpenseDto | undefined;
      if (payload.parentKind === 'ticket') parent = snapshot.tickets.find(item => item.id === payload.parentId);
      else {
        const detail = groupDetail(String(payload.groupId));
        parent = payload.parentKind === 'expense' ? detail?.expenses.find(item => item.id === payload.parentId) : detail?.reports.find(item => item.kind === 'meetup' && item.id === payload.parentId);
      }
      if (!parent || !allow(`${payload.parentKind}:${payload.parentId}`, parent, { version: data.parentVersion })) break;
      parent.version = data.parentVersion;
      if (request.operation === 'attachments.upload') {
        if (data.attachment.parentId !== parent.id || data.attachment.parentKind !== payload.parentKind) fail('OWNERSHIP_DENIED', 'The confirmed file does not match its parent.', 403);
        upsert(parent.attachments, data.attachment, item => item.id === data.attachment.id);
      } else parent.attachments = parent.attachments.filter(item => item.id !== payload.attachmentId);
      break;
    }
  }
  // These acknowledgements are local ordering guards, not a second source snapshot.
  snapshot.confirmedWrites = Object.fromEntries(Object.entries(receipts).sort((a,b) => b[1].completedAt - a[1].completedAt).slice(0,256));
}
async function checkAttachmentOwnership(bindings: CacheBindings, principal: Principal, value: unknown): Promise<void> {
  if (Array.isArray(value)) { for (const item of value) await checkAttachmentOwnership(bindings, principal, item); return; }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (typeof object.fileName === 'string' && typeof object.parentKind === 'string' && typeof object.id === 'string') {
    const attachment = object as unknown as AttachmentDto;
    const file = await ownFile(bindings.DB, principal, attachment.id);
    if (file.parent_id !== attachment.parentId || file.parent_kind !== attachment.parentKind || (file.group_id ?? undefined) !== attachment.groupId) fail('OWNERSHIP_DENIED', 'The confirmed file belongs to another record.', 403);
    return;
  }
  for (const item of Object.values(object)) await checkAttachmentOwnership(bindings, principal, item);
}

/**
 * Merge only a known, authorized write result. The complete base snapshot keeps its
 * original source timestamp/expiry and becomes stale until a full sync replaces it.
 * CAS + the sync fence make simultaneous saves and background publication atomic.
 */
export async function applyConfirmedWriteToCache(bindings: CacheBindings, principal: Principal, request: ClientRequest, response: BridgeResponse, options: ConfirmationOptions): Promise<void> {
  if (!response.ok || !isWrite(request.operation)) return;
  await requireCacheAccount(bindings, principal, cacheConfig(bindings));
  if (!Number.isFinite(options.completedAt)) fail('VALIDATION_ERROR', 'A confirmed write timestamp is required.');
  if (request.operation.startsWith('attachments.') && !(response.data as { parentVersion?: string | null }).parentVersion) return; // Local staging does not change SharePoint.
  if (request.operation === 'attachments.upload' || request.operation === 'attachments.delete') {
    const payload = request.payload as OperationResults['attachments.upload']['attachment'] & { attachmentId?: string };
    if (payload.parentKind !== 'ticket' && !payload.groupId) {
      const id = request.operation === 'attachments.upload' ? (response.data as OperationResults['attachments.upload']).attachment.id : payload.attachmentId!;
      const file = await ownFile(bindings.DB, principal, id, true);
      if (file.parent_id !== payload.parentId || file.parent_kind !== payload.parentKind || !file.group_id) fail('OWNERSHIP_DENIED', 'The confirmed file parent is unavailable.', 403);
      request = { ...request, payload: { ...request.payload, groupId: file.group_id } } as ClientRequest;
    }
  }
  await checkAttachmentOwnership(bindings, principal, response.data);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row, state] = await Promise.all([snapshotFor(bindings.DB, principal, 'private'), stateFor(bindings.DB, principal)]);
    if (!row || !state) { await invalidateMentorCache(bindings, principal); return; }
    if (state.authorization_state !== 'authorized') fail('MENTOR_FORBIDDEN', 'Source access is not currently authorized for this account.', 403);
    const snapshot = JSON.parse(row.snapshot_json) as PrivateSnapshot;
    if (snapshot.schemaVersion !== 1) fail('UPSTREAM_UNAVAILABLE', 'The stored snapshot cannot be updated.', 503);
    // A replay must not roll back a complete source snapshot published after that save.
    if (!options.replayed || row.synced_at < options.completedAt) mergeConfirmed(snapshot, principal, request, response, options);
    const json = JSON.stringify(snapshot);
    if (new TextEncoder().encode(json).byteLength > DEFAULT_LIMITS.maxSnapshotBytes) fail('UPSTREAM_UNAVAILABLE', 'The updated snapshot exceeds its supported bound.', 503);
    const token = crypto.randomUUID(), now = Date.now(), generation = crypto.randomUUID().replaceAll('-', '');
    const results = await bindings.DB.batch([
      bindings.DB.prepare("UPDATE mentor_cache_sync_state SET invalidation_version=invalidation_version+1,next_private_sync_at=?,next_catalog_sync_at=?,lease_token=NULL,lease_expires_at=0,commit_token=?,updated_at=? WHERE account_id=? AND mentor_user_id=? AND invalidation_version=? AND authorization_state='authorized' AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active') AND EXISTS (SELECT 1 FROM mentor_cache_snapshots WHERE account_id=? AND mentor_user_id=? AND namespace='private' AND generation=?)").bind(now,now,token,now,principal.accountId,principal.mentorUserId,state.invalidation_version,principal.accountId,principal.mentorUserId,principal.accountId,principal.mentorUserId,row.generation),
      bindings.DB.prepare("UPDATE mentor_cache_snapshots SET snapshot_json=?,generation=? WHERE account_id=? AND mentor_user_id=? AND namespace='private' AND generation=? AND EXISTS (SELECT 1 FROM mentor_cache_sync_state WHERE account_id=? AND mentor_user_id=? AND commit_token=?)").bind(json,generation,principal.accountId,principal.mentorUserId,row.generation,principal.accountId,principal.mentorUserId,token),
    ]);
    if (results[0].meta.changes === 1 && results[1].meta.changes === 1) return;
  }
  fail('UPSTREAM_UNAVAILABLE', 'The saved change is waiting for cache reconciliation.', 503, true);
}

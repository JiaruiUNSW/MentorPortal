import type { ClientRequest, Operation } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { fail } from './errors';
import { canonicalJson, sha256 } from './store';

/** Only the trusted queue executor constructs this value; it is never accepted in JSON. */
export interface AsyncExecution { jobId: string; leaseToken: string }
export const ASYNC_LEASE_MS = 120_000;
export const ASYNC_ACTIVE_STATES = "('queued','running','needs_review')";
export const ASYNC_OPERATIONS = new Set<Operation>(['attendance.save','reports.week1.save','reports.meetup.save','reports.completion.save']);

export async function checkAsyncExecution(bindings: PortalBindings, principal: Principal, request: ClientRequest, execution: AsyncExecution): Promise<void> {
  const hash = await sha256(canonicalJson({ operation: request.operation, payload: request.payload }));
  const row = await bindings.DB.prepare("SELECT id FROM mentor_async_jobs WHERE id=? AND account_id=? AND mentor_user_id=? AND idempotency_key=? AND operation=? AND payload_hash=? AND status='running' AND lease_token=? AND lease_expires_at>?")
    .bind(execution.jobId,principal.accountId,principal.mentorUserId,request.idempotencyKey,request.operation,hash,execution.leaseToken,Date.now()).first();
  if (!row) fail('PARTIAL_WRITE','The background write lease is no longer current. Keep the request reference for reconciliation.',409);
  await renewAsyncExecution(bindings.DB, execution);
}

/** Check the active account and current cached group on every executor checkpoint. */
export async function renewAsyncExecution(db: D1Database, execution: AsyncExecution, dispatch = false): Promise<void> {
  const now=Date.now();
  const result=await db.prepare(`UPDATE mentor_async_jobs SET lease_expires_at=?,updated_at=?,dispatch_started_at=CASE WHEN ? THEN COALESCE(dispatch_started_at,?) ELSE dispatch_started_at END
    WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?
    AND EXISTS (SELECT 1 FROM auth_accounts a WHERE a.id=mentor_async_jobs.account_id AND a.mentor_user_id=mentor_async_jobs.mentor_user_id AND a.mode='live' AND a.role='mentor' AND a.status='active')
    AND EXISTS (SELECT 1 FROM mentor_cache_snapshots s JOIN mentor_cache_sync_state c ON c.account_id=s.account_id AND c.mentor_user_id=s.mentor_user_id
      WHERE s.account_id=mentor_async_jobs.account_id AND s.mentor_user_id=mentor_async_jobs.mentor_user_id AND s.namespace='private' AND c.authorization_state='authorized' AND s.hard_expires_at>?
      AND EXISTS (SELECT 1 FROM json_each(s.snapshot_json,'$.groups') g WHERE json_extract(g.value,'$.group.id')=mentor_async_jobs.group_id))`)
    .bind(now+ASYNC_LEASE_MS,now,dispatch?1:0,now,execution.jobId,execution.leaseToken,now,now).run();
  if (result.meta.changes!==1) fail('PARTIAL_WRITE','The background write is no longer authorized to continue. Keep its request reference for reconciliation.',409);
}

/** Fast synchronous admission check; atomic resource acquisition checks the lane again. */
export async function requireAsyncLane(bindings: PortalBindings, principal: Principal, request: ClientRequest, execution?: AsyncExecution): Promise<void> {
  if (principal.mode!=='live') return;
  if (execution) { await checkAsyncExecution(bindings,principal,request,execution); return; }
  if(request.idempotencyKey){
    const job=await bindings.DB.prepare("SELECT request_id FROM mentor_async_jobs WHERE account_id=? AND idempotency_key=? AND status<>'succeeded'").bind(principal.accountId,request.idempotencyKey).first<{request_id:string}>();
    if(job)fail('REQUEST_IN_PROGRESS','This intent belongs to a background change. Use its status and permitted retry action.',409,false,job.request_id);
  }
  const payload=request.payload as Record<string,unknown>;
  // A new staged upload creates only an independent local blob; no source parent is mutated.
  if (request.operation==='attachments.upload'&&!payload.parentId) return;
  let groupId=typeof payload.groupId==='string'?payload.groupId:undefined;
  if (request.operation==='attachments.delete'&&typeof payload.attachmentId==='string') {
    const file=await bindings.DB.prepare("SELECT group_id FROM mentor_files WHERE id=? AND account_id=? AND mode='live'").bind(payload.attachmentId,principal.accountId).first<{group_id:string|null}>();
    groupId??=file?.group_id??undefined;
    const pinned=await bindings.DB.prepare(`SELECT p.file_id FROM mentor_async_files p JOIN mentor_async_jobs j ON j.id=p.job_id WHERE p.file_id=? AND j.status IN ${ASYNC_ACTIVE_STATES}`).bind(payload.attachmentId).first();
    if (pinned) fail('REQUEST_IN_PROGRESS','This attachment is reserved by a submitted background change.',409,true);
  }
  if (groupId&&await bindings.DB.prepare(`SELECT id FROM mentor_async_jobs WHERE group_id=? AND status IN ${ASYNC_ACTIVE_STATES} LIMIT 1`).bind(groupId).first()) {
    fail('REQUEST_IN_PROGRESS','A background change for this group is still unresolved. Check its status before saving another change.',409,true);
  }
}

/** Later queued jobs do not block their predecessor; ordinary writes cannot pass any queue lane. */
export function asyncResourceGuard(execution?: AsyncExecution): { sql: string; args: (string|null)[] } {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM mentor_async_jobs j WHERE 'group:'||j.group_id=? AND j.status IN ${ASYNC_ACTIVE_STATES}
      AND (? IS NULL OR (j.id<>? AND (j.sequence<(SELECT sequence FROM mentor_async_jobs WHERE id=?) OR j.status='running'))))`,
    args: [execution?.jobId??null,execution?.jobId??null,execution?.jobId??null],
  };
}

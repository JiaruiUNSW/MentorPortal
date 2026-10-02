import type { BridgeResponse, ClientRequest } from '../contracts';
import type { Principal } from '../runtime';
import { createDemoState, type DemoChange, type DemoState } from './demo';
import { errorEnvelope, fail } from './errors';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export interface RequestRow {
  account_id: string; mode: string; idempotency_key: string; request_id: string; operation: string; payload_hash: string; state: string; lease_token: string; lease_expires_at: number; response_json: string | null; updated_at: number;
}
export interface Claim { row: RequestRow; lease: string; replay?: BridgeResponse; resumingUpstreamPending?: boolean }
export async function claimRequest(db: D1Database, principal: Principal, request: ClientRequest, requestId: string): Promise<Claim> {
  if (!request.idempotencyKey) fail('VALIDATION_ERROR', 'A change requires an idempotency key.');
  const hash = await sha256(canonicalJson({ operation: request.operation, payload: request.payload }));
  const now = Date.now(), lease = crypto.randomUUID();
  const result = await db.prepare('INSERT INTO mentor_requests (account_id,mode,idempotency_key,request_id,operation,payload_hash,state,lease_token,lease_expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,\'pending\',?,?,?,? WHERE (SELECT COUNT(*) FROM mentor_requests WHERE account_id=? AND mode=? AND created_at>?)<30 ON CONFLICT(account_id,mode,idempotency_key) DO NOTHING').bind(principal.accountId, principal.mode, request.idempotencyKey, requestId, request.operation, hash, lease, now + 45000, now, now, principal.accountId, principal.mode, now - 60000).run();
  const row = await db.prepare('SELECT * FROM mentor_requests WHERE account_id=? AND mode=? AND idempotency_key=?').bind(principal.accountId, principal.mode, request.idempotencyKey).first<RequestRow>();
  if (!row) fail('RATE_LIMITED', 'Too many changes. Please wait a minute before trying again.', 429, true);
  if (row.payload_hash !== hash || row.operation !== request.operation) fail('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different change.', 409, false, row.request_id);
  if (result.meta.changes === 1) return { row, lease };
  if (row.response_json && ['succeeded', 'failed'].includes(row.state)) return { row, lease: row.lease_token, replay: { ...JSON.parse(row.response_json), replayed: true } };
  if (row.state === 'uncertain' || (principal.mode === 'live' && row.state === 'pending' && row.lease_expires_at <= now)) fail('PARTIAL_WRITE', 'The previous attempt needs reconciliation. Keep this request reference and contact staff before repeating the change.', 409, false, row.request_id);
  if (row.lease_expires_at > now) fail('REQUEST_IN_PROGRESS', 'This request is still being processed. Retry with the same key.', 409, true, row.request_id);
  if (principal.mode === 'live' && ['upstream_pending', 'preflight_retry'].includes(row.state)) {
    // A previous explicit adapter acknowledgement permits a user-initiated status recheck with the same key.
    // Transport timeouts remain uncertain and never enter this branch.
    const checked = await db.prepare("UPDATE mentor_requests SET state='pending',lease_token=?,lease_expires_at=?,updated_at=? WHERE account_id=? AND mode='live' AND idempotency_key=? AND state=? AND lease_expires_at<=?").bind(lease,now+45000,now,principal.accountId,request.idempotencyKey,row.state,now).run();
    if (checked.meta.changes !== 1) fail('REQUEST_IN_PROGRESS','This request is still being processed. Retry with the same key.',409,true,row.request_id);
    return {row:{...row,state:'pending',lease_token:lease,lease_expires_at:now+45000},lease,resumingUpstreamPending:row.state==='upstream_pending'};
  }
  // Only demo computation may be retried. Every commit also verifies this lease, so an old worker cannot commit afterward.
  const reclaimed = await db.prepare('UPDATE mentor_requests SET lease_token=?,lease_expires_at=?,updated_at=? WHERE account_id=? AND mode=? AND idempotency_key=? AND state=\'pending\' AND lease_expires_at<=?').bind(lease, now + 45000, now, principal.accountId, principal.mode, request.idempotencyKey, now).run();
  if (reclaimed.meta.changes !== 1) fail('REQUEST_IN_PROGRESS', 'This request is still being processed. Retry with the same key.', 409, true, row.request_id);
  return { row: { ...row, lease_token: lease, lease_expires_at: now + 45000 }, lease };
}
export async function loadDemo(db: D1Database, principal: Principal): Promise<{ state: DemoState; revision: number }> {
  let row = await db.prepare('SELECT state_json,revision FROM mentor_demo_state WHERE account_id=?').bind(principal.accountId).first<{ state_json: string; revision: number }>();
  if (!row) {
    await db.prepare('INSERT INTO mentor_demo_state (account_id,state_json,revision,updated_at) VALUES (?,?,0,?) ON CONFLICT(account_id) DO NOTHING').bind(principal.accountId, JSON.stringify(createDemoState(principal)), Date.now()).run();
    row = await db.prepare('SELECT state_json,revision FROM mentor_demo_state WHERE account_id=?').bind(principal.accountId).first<{ state_json: string; revision: number }>();
  }
  if (!row) fail('UPSTREAM_UNAVAILABLE', 'Preview storage is unavailable.', 503, true);
  return { state: JSON.parse(row.state_json) as DemoState, revision: row.revision };
}
export async function completeDemo(db: D1Database, claim: Claim, revision: number, change: DemoChange): Promise<BridgeResponse | null> {
  const r = claim.row, token = crypto.randomUUID(), now = Date.now();
  const response = { schemaVersion: '1.0', requestId: r.request_id, ok: true, data: change.data } as BridgeResponse;
  const fileGuards = change.bindings.map(() => ' AND EXISTS (SELECT 1 FROM mentor_files WHERE id=? AND account_id=? AND mode=\'demo\' AND state IN (\'ready\',\'attached\') AND (parent_id IS NULL OR parent_id=?))').join('');
  const guardArgs = change.bindings.flatMap(f => [f.id, r.account_id, f.parentId]);
  const statements = [db.prepare(`UPDATE mentor_demo_state SET state_json=?,revision=revision+1,mutation_token=?,updated_at=? WHERE account_id=? AND revision=? AND EXISTS (SELECT 1 FROM mentor_requests WHERE account_id=? AND mode='demo' AND idempotency_key=? AND lease_token=? AND state='pending')${fileGuards}`).bind(JSON.stringify(change.state), token, now, r.account_id, revision, r.account_id, r.idempotency_key, claim.lease, ...guardArgs)];
  const committed = 'EXISTS (SELECT 1 FROM mentor_demo_state WHERE account_id=? AND mutation_token=?)';
  for (const f of change.bindings) statements.push(db.prepare(`UPDATE mentor_files SET parent_id=?,group_id=?,state='attached',updated_at=? WHERE id=? AND account_id=? AND mode='demo' AND ${committed}`).bind(f.parentId, f.groupId ?? null, now, f.id, r.account_id, r.account_id, token));
  if (change.deletedFileId) statements.push(db.prepare(`UPDATE mentor_files SET state='deleting',updated_at=? WHERE id=? AND account_id=? AND mode='demo' AND ${committed}`).bind(now, change.deletedFileId, r.account_id, r.account_id, token));
  statements.push(db.prepare(`UPDATE mentor_requests SET state='succeeded',response_json=?,updated_at=? WHERE account_id=? AND mode='demo' AND idempotency_key=? AND lease_token=? AND state='pending' AND ${committed}`).bind(JSON.stringify(response), now, r.account_id, r.idempotency_key, claim.lease, r.account_id, token));
  statements.push(db.prepare(`INSERT INTO mentor_audit (id,account_id,mode,request_id,operation,outcome,created_at) SELECT ?,?,'demo',?,?,'succeeded',? WHERE ${committed}`).bind(crypto.randomUUID(), r.account_id, r.request_id, r.operation, now, r.account_id, token));
  const results = await db.batch(statements);
  return results[0].meta.changes === 1 ? response : null;
}
export async function completeLive(db: D1Database, claim: Claim, response: BridgeResponse): Promise<void> {
  const r = claim.row, now = Date.now();
  const results = await db.batch([
    db.prepare('UPDATE mentor_requests SET state=\'succeeded\',response_json=?,updated_at=? WHERE account_id=? AND mode=\'live\' AND idempotency_key=? AND lease_token=? AND state=\'pending\' AND lease_expires_at>?').bind(JSON.stringify(response), now, r.account_id, r.idempotency_key, claim.lease, now),
    db.prepare('INSERT INTO mentor_audit (id,account_id,mode,request_id,operation,outcome,created_at) SELECT ?,?,\'live\',?,?,\'succeeded\',? WHERE EXISTS (SELECT 1 FROM mentor_requests WHERE account_id=? AND mode=\'live\' AND idempotency_key=? AND lease_token=? AND state=\'succeeded\')').bind(crypto.randomUUID(), r.account_id, r.request_id, r.operation, now, r.account_id, r.idempotency_key, claim.lease),
  ]);
  if (results[0].meta.changes !== 1) fail('PARTIAL_WRITE', 'The write claim changed before completion. Keep this request reference for reconciliation.', 409, false, r.request_id);
  r.updated_at = now;
}
export async function renewLiveClaim(db: D1Database, claim: Claim, expiresAt: number): Promise<void> {
  const r = claim.row, now = Date.now();
  const result = await db.prepare("UPDATE mentor_requests SET lease_expires_at=? WHERE account_id=? AND mode='live' AND idempotency_key=? AND lease_token=? AND state='pending' AND lease_expires_at>?").bind(expiresAt,r.account_id,r.idempotency_key,claim.lease,now).run();
  if (result.meta.changes !== 1) fail('PARTIAL_WRITE', 'The write claim is no longer current. Keep this request reference for reconciliation.', 409, false, r.request_id);
}
/** Only a failure before any local mutation or upstream business dispatch may enter this state. */
export async function recordPreflightRetry(db: D1Database, claim: Claim): Promise<void> {
  const r=claim.row,now=Date.now();
  await db.prepare("UPDATE mentor_requests SET state='preflight_retry',response_json=NULL,lease_expires_at=?,updated_at=? WHERE account_id=? AND mode='live' AND idempotency_key=? AND lease_token=? AND state='pending'").bind(now+3000,now,r.account_id,r.idempotency_key,claim.lease).run();
}
export async function recordFailure(db: D1Database, claim: Claim, error: unknown, uncertain = false): Promise<void> {
  const r = claim.row, now = Date.now();
  const response = errorEnvelope(r.request_id, error);
  await db.batch([
    db.prepare('UPDATE mentor_requests SET state=?,response_json=?,updated_at=? WHERE account_id=? AND mode=? AND idempotency_key=? AND lease_token=? AND state=\'pending\'').bind(uncertain ? 'uncertain' : 'failed', JSON.stringify(response), now, r.account_id, r.mode, r.idempotency_key, claim.lease),
    db.prepare('INSERT INTO mentor_audit (id,account_id,mode,request_id,operation,outcome,created_at) VALUES (?,?,?,?,?,?,?)').bind(crypto.randomUUID(), r.account_id, r.mode, r.request_id, r.operation, uncertain ? 'uncertain' : 'failed', now),
  ]);
}
export async function recordUpstreamPending(db:D1Database,claim:Claim):Promise<void> {
  const r=claim.row,now=Date.now();
  await db.prepare("UPDATE mentor_requests SET state='upstream_pending',response_json=NULL,lease_expires_at=?,updated_at=? WHERE account_id=? AND mode='live' AND idempotency_key=? AND lease_token=? AND state='pending'").bind(now+3000,now,r.account_id,r.idempotency_key,claim.lease).run();
}

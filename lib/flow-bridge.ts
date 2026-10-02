import type { BridgeResponse, ClientRequest, ErrorCode, Operation } from './contracts';
import type { PortalBindings, Principal } from './runtime';
import { MentorError, fail } from './mentor-data/errors';
import { isWrite, parseForwardedUpload, requireLiveWriteAccess, requireMentor } from './mentor-data/validation';
import { validateFlowData } from './mentor-data/response-validation';
import { canonicalJson, sha256 } from './mentor-data/store';

const read = new Set(['bootstrap','groups.list','groups.get','reports.list','reports.get','balance.get','transactions.list','rewards.list','rewards.get','profile.get','tickets.list','tickets.get','redemptions.list']);
export function bindingForOperation(operation: Operation): keyof PortalBindings {
  if (read.has(operation)) return 'MENTOR_READ_URL';
  if (operation === 'attendance.save') return 'MENTOR_ATTENDANCE_URL';
  if (operation.startsWith('reports.')) return 'MENTOR_REPORT_URL';
  if (operation === 'expenses.save') return 'MENTOR_EXPENSE_URL';
  if (operation.startsWith('attachments.')) return 'MENTOR_ATTACHMENT_URL';
  if (operation === 'profile.update') return 'MENTOR_PROFILE_URL';
  if (operation === 'redemptions.create') return 'MENTOR_REDEEM_URL';
  return 'MENTOR_TICKET_URL';
}
export function configuredEndpoint(bindings: PortalBindings, operation: Operation): string {
  const target = bindings[bindingForOperation(operation)];
  if (typeof bindings.MENTOR_BRIDGE_KEY !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(bindings.MENTOR_BRIDGE_KEY) || typeof target !== 'string' || !target) fail('DRAFT_NOT_CONFIGURED', 'The live data adapter is not configured. Contact the portal administrator.', 503, false);
  let url: URL;
  try { url = new URL(target); } catch { fail('DRAFT_NOT_CONFIGURED', 'The live data adapter is not configured.', 503, false); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !['.logic.azure.com','.environment.api.powerplatform.com','.api.powerplatform.com'].some(suffix => host.endsWith(suffix))) fail('DRAFT_NOT_CONFIGURED', 'The live data adapter is not configured.', 503, false);
  return url.toString();
}
export function sourceId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('VALIDATION_ERROR', 'This is not a persisted live record ID.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 2147483647) fail('VALIDATION_ERROR', 'This is not a valid live record ID.');
  return number;
}
export function normalizeLivePayload(request: ClientRequest, resolved?: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...(resolved ?? request.payload) } as Record<string, unknown>;
  if (request.operation === 'reports.list' && !payload.groupId) fail('VALIDATION_ERROR', 'Choose a group before loading live reports.');
  if (request.operation === 'reports.list') {
    if (payload.cursor) fail('VALIDATION_ERROR', 'Live reports are loaded as a bounded group aggregate.');
    delete payload.limit;
    delete payload.cursor;
  }
  if (payload.submit === false) fail('DRAFT_NOT_CONFIGURED', 'Live draft storage is not enabled. Save a final report only after completing the required fields.', 503, false);
  delete payload.submit;
  if ('attachmentIds' in payload) fail('ATTACHMENT_REJECTED', 'Staged attachments must be resolved by the server.');
  const keys = ['groupId','reportId','meetupReportId','expenseId','ticketId','rewardId','parentId'];
  for (const key of keys) if (payload[key] !== undefined) payload[key] = sourceId(payload[key]);
  if (Array.isArray(payload.optionIds)) payload.optionIds = payload.optionIds.map(sourceId);
  if (Array.isArray(payload.entries)) payload.entries = payload.entries.map(v => ({ ...(v as Record<string, unknown>), menteeId: sourceId((v as Record<string, unknown>).menteeId) }));
  return payload;
}
const safeMessages: Partial<Record<ErrorCode, [string, number]>> = {
  VALIDATION_ERROR:['Please check the required fields and values.',400], BRIDGE_UNAUTHORIZED:['The live data adapter could not authenticate this request.',503], MENTOR_FORBIDDEN:['Your mentor access could not be verified.',403], RECORD_NOT_FOUND:['This record is unavailable or does not belong to your account.',404], OWNERSHIP_DENIED:['This record is unavailable or does not belong to your account.',403], EDIT_NOT_ALLOWED:['This record cannot be edited in its current state.',403], VERSION_CONFLICT:['This record changed. Reload it before saving.',409], IDEMPOTENCY_CONFLICT:['This idempotency key was already used for another change.',409], REQUEST_IN_PROGRESS:['This request is still being processed. Reuse the same request key.',409], RATE_LIMITED:['The data service is busy. Please wait and try again.',429], INSUFFICIENT_CREDIT:['Your available credit is too low for this reward.',409], REWARD_UNAVAILABLE:['This reward or option is unavailable.',409], UNSUPPORTED_OPTION_COST:['This option requires a staff review.',409], ATTACHMENT_REJECTED:['The attachment was rejected. Check its type and size.',400], PARTIAL_WRITE:['The previous attempt needs reconciliation. Contact staff before repeating it.',409], DRAFT_NOT_CONFIGURED:['The live adapter is not configured.',503], UPSTREAM_UNAVAILABLE:['The live data service is temporarily unavailable.',503],
};
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) fail('UPSTREAM_UNAVAILABLE', 'The data service returned an empty response.',502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {value,done} = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); fail('UPSTREAM_UNAVAILABLE', 'The data service response is too large.',502); } chunks.push(value); }
  const all = new Uint8Array(size); let offset=0; for (const chunk of chunks) {all.set(chunk,offset);offset+=chunk.length;}
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { fail('UPSTREAM_UNAVAILABLE','The data service returned an invalid response.',502); }
}
export async function callFlow(bindings: PortalBindings, principal: Principal, request: ClientRequest, requestId: string, resolvedPayload?: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<BridgeResponse> {
  // This guard is independent of routing. Demo data can never be forwarded accidentally.
  if (bindings.PORTAL_MODE === 'demo') fail('MENTOR_FORBIDDEN','Preview requests cannot use the live data bridge.',403);
  requireMentor(principal,'live');
  requireLiveWriteAccess(bindings,request.operation);
  const endpoint = configuredEndpoint(bindings,request.operation), payload = normalizeLivePayload(request,resolvedPayload);
  const now = Date.now();
  const rate = await bindings.DB.prepare("INSERT INTO mentor_audit (id,account_id,mode,request_id,operation,outcome,created_at) SELECT ?,?,'live',?,?,'live_dispatch',? WHERE (SELECT COUNT(*) FROM mentor_audit WHERE account_id=? AND mode='live' AND outcome='live_dispatch' AND created_at>?)<60").bind(crypto.randomUUID(),principal.accountId,requestId,request.operation,now,principal.accountId,now-60000).run();
  if (rate.meta.changes !== 1) fail('RATE_LIMITED','Too many data requests. Please wait a minute before trying again.',429,true);
  const envelope = { schemaVersion:'1.0',requestId,operation:request.operation,actor:{userId:principal.mentorUserId,portalAccountId:principal.accountId},payload,...(request.idempotencyKey ? {idempotencyKey:request.idempotencyKey}: {}) };
  const headers: Record<string,string> = {'Content-Type':'application/json','Accept':'application/json','X-Mentor-Bridge-Key':bindings.MENTOR_BRIDGE_KEY!,'X-Mentor-Request-Id':requestId};
  if (isWrite(request.operation)) {
    const digest = await sha256(canonicalJson(payload));
    headers['X-Mentor-Payload-SHA256'] = digest;
    const files = payload.file ? [payload.file] : Array.isArray(payload.attachments) ? payload.attachments : [];
    if (files.length) {
      if (files.length > 5) fail('ATTACHMENT_REJECTED', 'A submission can contain at most five new attachments.');
      let bytes = 0;
      for (const file of files) bytes += parseForwardedUpload(file).byteLength;
      if (bytes > 10 * 1024 * 1024) fail('ATTACHMENT_REJECTED', 'Attach no more than 10 MiB of new files to one submission.');
      headers['X-Mentor-Files-Validated-SHA256'] = digest;
    }
  }
  const controller = new AbortController(); const deadline = setTimeout(()=>controller.abort(), isWrite(request.operation) ? 20000:45000);
  let response: Response;
  try {
    response = await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(envelope),redirect:'error',signal:controller.signal});
    const body = await readBoundedJson(response,request.operation === 'attachments.download' ? 8*1024*1024 : 1024*1024) as Record<string,unknown>;
    if (!body || body.schemaVersion !== '1.0' || body.requestId !== requestId || typeof body.ok !== 'boolean') throw new Error('invalid envelope');
    if (!body.ok) {
      const error = body.error as Record<string,unknown> | undefined; const safe = typeof error?.code === 'string' ? safeMessages[error.code as ErrorCode] : undefined;
      if (!safe) throw new Error('invalid error envelope');
      throw new MentorError(error!.code as ErrorCode,safe[0],safe[1],error?.retryable === true && error.code !== 'PARTIAL_WRITE');
    }
    if (!response.ok) throw new Error('invalid success status');
    const data = validateFlowData(request.operation,body.data);
    return {schemaVersion:'1.0',requestId,ok:true,data,...(body.replayed === true ? {replayed:true}: {})} as BridgeResponse;
  } catch (error) {
    if (error instanceof MentorError && error.code !== 'UPSTREAM_UNAVAILABLE') throw error;
    if (isWrite(request.operation)) fail('PARTIAL_WRITE','The request outcome is unknown. Keep this request reference and contact staff before repeating the change.',409,false);
    fail('UPSTREAM_UNAVAILABLE','The live data service is temporarily unavailable.',503,true);
  } finally { clearTimeout(deadline); }
}

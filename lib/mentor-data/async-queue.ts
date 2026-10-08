import type { AttachmentDto, BridgeResponse, ClientRequest, OperationPayloads, OperationResults } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { configuredEndpoint } from '../flow-bridge';
import { cacheConfig } from '../mentor-cache/config';
import { requireCacheAccount, stateFor } from '../mentor-cache/store';
import type { PrivateSnapshot, SnapshotRow } from '../mentor-cache/types';
import { ASYNC_ACTIVE_STATES, ASYNC_OPERATIONS } from './async-guards';
import type { AsyncAcceptedResponse, AsyncJob, AsyncJobError, AsyncJobStatus, AsyncOperation } from './async-contract';
import { fail } from './errors';
import { fileDto, ownFiles, type FileRow } from './files';
import { canonicalJson, sha256, type RequestRow } from './store';
import { expectVersion, parseClientRequest, requireLiveWriteAccess, requireMentor } from './validation';

export const MAX_JOB_ATTEMPTS=3;
export const JOB_RETENTION_MS=30*86_400_000;
export const MAX_QUEUED_AGE_MS=86_400_000;
export interface AsyncJobRow {
  sequence:number; id:string; account_id:string; mentor_user_id:number; idempotency_key:string;
  request_id:string; operation:AsyncOperation; group_id:string; payload_hash:string; request_json:string;
  attachments_json:string; status:AsyncJobStatus; attempts:number; can_retry:number; retry_after:number;
  lease_token:string|null; lease_expires_at:number; dispatch_started_at:number|null;
  response_json:string|null; error_json:string|null; created_at:number; updated_at:number;
}
interface CachedScope { row:SnapshotRow & {current_invalidation_version:number}; snapshot:PrivateSnapshot }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sourceId(value:string):void {
  if(!/^[1-9]\d{0,9}$/.test(value)||Number(value)>2_147_483_647)fail('VALIDATION_ERROR','Choose a saved source record. Pending report IDs cannot be submitted.');
}
export function shouldEnqueueAsync(bindings:PortalBindings,request:ClientRequest):boolean {
  return bindings.PORTAL_MODE!=='demo'&&bindings.MENTOR_ASYNC_WRITES_ENABLED==='true'&&ASYNC_OPERATIONS.has(request.operation);
}
/** One coherent, account-bound snapshot supplies both ownership and the admission CAS. */
export async function cachedAsyncScope(bindings:PortalBindings,principal:Principal,fresh=false):Promise<CachedScope> {
  const config=cacheConfig(bindings);await requireCacheAccount(bindings,principal,config);
  const row=await bindings.DB.prepare(`SELECT s.*,c.invalidation_version AS current_invalidation_version FROM mentor_cache_snapshots s
    JOIN mentor_cache_sync_state c ON c.account_id=s.account_id AND c.mentor_user_id=s.mentor_user_id
    JOIN auth_accounts a ON a.id=s.account_id AND a.mentor_user_id=s.mentor_user_id
    WHERE s.account_id=? AND s.mentor_user_id=? AND s.namespace='private' AND c.authorization_state='authorized'
    AND a.mode='live' AND a.role='mentor' AND a.status='active'`).bind(principal.accountId,principal.mentorUserId).first<CachedScope['row']>();
  if(!row){if((await stateFor(bindings.DB,principal))?.authorization_state==='denied')fail('MENTOR_FORBIDDEN','Source access is no longer authorized for this account.',403);fail('CACHE_PENDING','Your current group access needs background synchronization before this change can be accepted.',503,true);}
  const now=Date.now();
  if(now>=Math.min(row.hard_expires_at,row.synced_at+config.hardAgeMs)||(fresh&&now>=Math.min(row.refresh_after,row.synced_at+config.privateTtlMs))) {
    fail('CACHE_EXPIRED','Your group snapshot needs a background refresh. Try again after synchronization completes.',503,true);
  }
  const snapshot=JSON.parse(row.snapshot_json) as PrivateSnapshot;
  if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.groups))fail('UPSTREAM_UNAVAILABLE','The current group snapshot cannot be read.',503);
  return {row,snapshot};
}
export function ownedCachedGroup(scope:CachedScope,groupId:string):OperationResults['groups.get'] {
  const detail=scope.snapshot.groups.find(item=>item.group.id===groupId);
  if(!detail)fail('RECORD_NOT_FOUND','This group is unavailable in your current authorized snapshot.',404);
  return detail;
}
export function fileFingerprint(file:FileRow):string {
  return canonicalJson({id:file.id,parentId:file.parent_id,groupId:file.group_id,parentKind:file.parent_kind,fileName:file.file_name,mimeType:file.mime_type,size:file.size_bytes,sha256:file.sha256,sourceAttachmentId:file.source_attachment_id,objectKey:file.object_key});
}
async function validateIntent(bindings:PortalBindings,principal:Principal,request:ClientRequest,scope:CachedScope):Promise<FileRow[]> {
  if(!ASYNC_OPERATIONS.has(request.operation))fail('VALIDATION_ERROR','This operation is not supported by the background writer.');
  const p=request.payload as OperationPayloads[AsyncOperation];sourceId(p.groupId);
  const detail=ownedCachedGroup(scope,p.groupId);
  if(!detail.group.reportEnabled)fail('EDIT_NOT_ALLOWED','Changes are closed for this group.',403);
  if(request.operation==='attendance.save') {
    const value=p as OperationPayloads['attendance.save'];expectVersion(detail.group.version,value.expectedVersion);
    for(const entry of value.entries){sourceId(entry.menteeId);const mentee=detail.mentees.find(item=>item.id===entry.menteeId);if(!mentee)fail('OWNERSHIP_DENIED','A selected mentee is unavailable in this group.',403);expectVersion(mentee.version,entry.expectedVersion);}
    return [];
  }
  const value=p as OperationPayloads['reports.meetup.save'];
  if(value.submit===false)fail('DRAFT_NOT_CONFIGURED','Live drafts are not configured. Submit a complete report instead.',503);
  const kind=request.operation.split('.')[1];
  const current=value.reportId?detail.reports.find(item=>item.id===value.reportId&&item.kind===kind):undefined;
  if(value.reportId){sourceId(value.reportId);if(!current)fail('OWNERSHIP_DENIED','The selected report is unavailable in this group.',403);if(current.reviewStatus==='accepted')fail('EDIT_NOT_ALLOWED','Accepted reports cannot be edited.',403);expectVersion(current.version,value.expectedVersion);}
  const files=await ownFiles(bindings.DB,principal,value.attachmentIds??[]);
  for(const file of files)if(file.parent_kind!=='meetupReport'||file.group_id!==value.groupId||(file.parent_id!==null&&file.parent_id!==(value.reportId??null)))fail('OWNERSHIP_DENIED','An attachment belongs to a different report.',403);
  if(request.operation==='reports.meetup.save') {
    if(!files.some(file=>file.mime_type.startsWith('image/'))&&!current?.attachments.some(file=>file.mimeType.startsWith('image/')))fail('ATTACHMENT_REJECTED','Attach a photograph before submitting the meet-up report.');
    const staged=files.filter(file=>!file.source_attachment_id),names=staged.map(file=>file.file_name.toLowerCase());
    if(new Set(names).size!==names.length||staged.reduce((sum,file)=>sum+file.size_bytes,0)>10*1024*1024)fail('ATTACHMENT_REJECTED','Use distinct photo filenames and at most 10 MiB of new attachments.');
  }
  return files;
}
export function asyncJobDto(row:AsyncJobRow):AsyncJob {
  const request=JSON.parse(row.request_json) as ClientRequest<AsyncOperation>;
  const response=row.response_json?JSON.parse(row.response_json) as BridgeResponse:undefined;
  const p=request.payload as {reportId?:string};
  return {id:row.id,operation:row.operation,groupId:row.group_id,status:row.status,requestId:row.request_id,
    createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),
    ...(row.operation.startsWith('reports.')&&!p.reportId?{clientRecordId:`pending_${row.id}`} : {}),
    intent:{operation:request.operation,payload:request.payload},attachments:JSON.parse(row.attachments_json) as AttachmentDto[],
    ...(row.status==='succeeded'&&response?.ok?{result:response.data}:{}),
    ...(row.error_json?{error:JSON.parse(row.error_json) as AsyncJobError}:{}),
    canRetry:row.can_retry===1&&row.attempts<MAX_JOB_ATTEMPTS&&Date.now()>=row.retry_after,
  } as AsyncJob;
}
function accepted(row:AsyncJobRow,replayed=false):AsyncAcceptedResponse {return {schemaVersion:'1.0',requestId:row.request_id,ok:true,accepted:true,data:{job:asyncJobDto(row)},...(replayed?{replayed:true}:{})};}
export async function asyncJobRow(db:D1Database,id:string):Promise<AsyncJobRow|null> {return db.prepare('SELECT * FROM mentor_async_jobs WHERE id=?').bind(id).first<AsyncJobRow>();}
export async function requestForJob(db:D1Database,job:AsyncJobRow):Promise<RequestRow|null> {return db.prepare("SELECT * FROM mentor_requests WHERE account_id=? AND mode='live' AND idempotency_key=?").bind(job.account_id,job.idempotency_key).first<RequestRow>();}
function scopeGuard():string {return `EXISTS (SELECT 1 FROM mentor_cache_snapshots s JOIN mentor_cache_sync_state c ON c.account_id=s.account_id AND c.mentor_user_id=s.mentor_user_id JOIN auth_accounts a ON a.id=s.account_id AND a.mentor_user_id=s.mentor_user_id WHERE s.account_id=? AND s.mentor_user_id=? AND s.namespace='private' AND s.generation=? AND c.invalidation_version=? AND c.authorization_state='authorized' AND a.mode='live' AND a.role='mentor' AND a.status='active')`;}
function fileGuards(files:FileRow[]):{sql:string;args:unknown[]} {
  return {sql:files.map(()=>" AND EXISTS (SELECT 1 FROM mentor_files f WHERE f.id=? AND f.account_id=? AND f.mode='live' AND f.state IN ('ready','attached') AND f.parent_id IS ? AND f.group_id IS ? AND f.sha256=? AND f.file_name=? AND f.mime_type=? AND f.size_bytes=? AND f.source_attachment_id IS ?) AND NOT EXISTS (SELECT 1 FROM mentor_async_files p WHERE p.file_id=?)").join(''),
    args:files.flatMap(file=>[file.id,file.account_id,file.parent_id,file.group_id,file.sha256,file.file_name,file.mime_type,file.size_bytes,file.source_attachment_id,file.id])};
}
function pinStatements(db:D1Database,jobId:string,files:FileRow[],retryToken?:string):D1PreparedStatement[] {
  return files.map(file=>db.prepare(`INSERT INTO mentor_async_files (file_id,job_id,snapshot_json) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM mentor_async_jobs WHERE id=? AND status='queued'${retryToken?' AND lease_token=?':''})`).bind(file.id,jobId,fileFingerprint(file),jobId,...(retryToken?[retryToken]:[])));
}
export async function enqueueMentorWrite(bindings:PortalBindings,principal:Principal,input:ClientRequest,requestId:string):Promise<AsyncAcceptedResponse|BridgeResponse> {
  requireMentor(principal,'live');requireLiveWriteAccess(bindings,input.operation);
  if(!shouldEnqueueAsync(bindings,input))fail('DRAFT_NOT_CONFIGURED','Background acceptance is not enabled for this operation.',503);
  const request=parseClientRequest(input);configuredEndpoint(bindings,request.operation);
  if(!request.idempotencyKey)fail('VALIDATION_ERROR','A background change requires an idempotency key.');
  const hash=await sha256(canonicalJson({operation:request.operation,payload:request.payload}));
  const old=await bindings.DB.prepare('SELECT * FROM mentor_async_jobs WHERE account_id=? AND idempotency_key=?').bind(principal.accountId,request.idempotencyKey).first<AsyncJobRow>();
  const scope=await cachedAsyncScope(bindings,principal,!old);
  ownedCachedGroup(scope,(request.payload as {groupId:string}).groupId);
  if(old){if(old.mentor_user_id!==principal.mentorUserId)fail('MENTOR_FORBIDDEN','This request is unavailable to the current account mapping.',403);if(old.payload_hash!==hash)fail('IDEMPOTENCY_CONFLICT','This key already identifies a different change.',409,false,old.request_id);return accepted(old,true);}
  const previous=await bindings.DB.prepare("SELECT * FROM mentor_requests WHERE account_id=? AND mode='live' AND idempotency_key=?").bind(principal.accountId,request.idempotencyKey).first<RequestRow>();
  if(previous){
    if(previous.payload_hash!==hash||previous.operation!==request.operation)fail('IDEMPOTENCY_CONFLICT','This key already identifies a different change.',409,false,previous.request_id);
    if(previous.response_json&&['succeeded','failed'].includes(previous.state))return {...JSON.parse(previous.response_json),replayed:true} as BridgeResponse;
    fail(previous.state==='uncertain'||(previous.state==='pending'&&previous.lease_expires_at<=Date.now())?'PARTIAL_WRITE':'REQUEST_IN_PROGRESS','This intent already has a synchronous request. Keep its original reference and check that request before repeating it.',409,false,previous.request_id);
  }
  const files=await validateIntent(bindings,principal,request,scope),id=crypto.randomUUID(),now=Date.now();
  const groupId=(request.payload as {groupId:string}).groupId,guards=fileGuards(files);
  const insert=bindings.DB.prepare(`INSERT INTO mentor_async_jobs (id,account_id,mentor_user_id,idempotency_key,request_id,operation,group_id,payload_hash,request_json,attachments_json,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'queued',?,? WHERE ${scopeGuard()}
    AND (SELECT COUNT(*) FROM mentor_async_jobs WHERE account_id=? AND status IN ${ASYNC_ACTIVE_STATES})<20
    AND (SELECT COUNT(*) FROM mentor_async_jobs WHERE account_id=? AND created_at>?)<30
    AND (SELECT COUNT(*) FROM mentor_async_jobs WHERE account_id=?)<1000
    AND NOT EXISTS (SELECT 1 FROM mentor_requests WHERE account_id=? AND mode='live' AND idempotency_key=?)
    AND NOT EXISTS (SELECT 1 FROM mentor_resource_locks WHERE resource_key=? AND (state<>'pending' OR lease_expires_at>?))${guards.sql}
    ON CONFLICT(account_id,idempotency_key) DO NOTHING`).bind(id,principal.accountId,principal.mentorUserId,request.idempotencyKey,requestId,request.operation,groupId,hash,JSON.stringify(request),JSON.stringify(files.map(fileDto)),now,now,principal.accountId,principal.mentorUserId,scope.row.generation,scope.row.current_invalidation_version,principal.accountId,principal.accountId,now-60_000,principal.accountId,principal.accountId,request.idempotencyKey,`group:${groupId}`,now,...guards.args);
  await bindings.DB.batch([insert,...pinStatements(bindings.DB,id,files),bindings.DB.prepare("INSERT INTO mentor_audit (id,account_id,mode,request_id,operation,entity_id,outcome,created_at) SELECT ?,?,'live',?,?,?,'queued',? WHERE EXISTS (SELECT 1 FROM mentor_async_jobs WHERE id=?)").bind(crypto.randomUUID(),principal.accountId,requestId,request.operation,id,now,id)]);
  const row=await bindings.DB.prepare('SELECT * FROM mentor_async_jobs WHERE account_id=? AND idempotency_key=?').bind(principal.accountId,request.idempotencyKey).first<AsyncJobRow>();
  if(!row)fail('REQUEST_IN_PROGRESS','The group or one of its attachments changed, or the background queue is full. Refresh its status before retrying with the same key.',409,true);
  if(row.mentor_user_id!==principal.mentorUserId||row.payload_hash!==hash)fail('IDEMPOTENCY_CONFLICT','This key already identifies a different change.',409,false,row.request_id);
  return accepted(row,row.id!==id);
}
export async function getAsyncJob(bindings:PortalBindings,principal:Principal,id:string):Promise<AsyncJob> {
  requireMentor(principal,principal.mode);if(!uuid.test(id)||principal.mode!=='live')fail('RECORD_NOT_FOUND','This background change is unavailable.',404);
  const scope=await cachedAsyncScope(bindings,principal),row=await bindings.DB.prepare('SELECT * FROM mentor_async_jobs WHERE id=? AND account_id=? AND mentor_user_id=?').bind(id,principal.accountId,principal.mentorUserId).first<AsyncJobRow>();
  if(!row)fail('RECORD_NOT_FOUND','This background change is unavailable.',404);ownedCachedGroup(scope,row.group_id);return asyncJobDto(row);
}
export async function listAsyncJobs(bindings:PortalBindings,principal:Principal,options:{groupId?:string;cursor?:string;limit?:number}={}):Promise<{items:AsyncJob[];nextCursor:string|null}> {
  requireMentor(principal,principal.mode);if(principal.mode==='demo')return {items:[],nextCursor:null};
  const scope=await cachedAsyncScope(bindings,principal),limit=options.limit??25;
  if(!Number.isInteger(limit)||limit<1||limit>50)fail('VALIDATION_ERROR','Choose a page size between one and 50.');
  if(options.groupId){sourceId(options.groupId);ownedCachedGroup(scope,options.groupId);}
  const ids=options.groupId?[options.groupId]:scope.snapshot.groups.map(item=>item.group.id);
  if(!ids.length)return {items:[],nextCursor:null};
  const signature=(await sha256(canonicalJson({accountId:principal.accountId,mentorUserId:principal.mentorUserId,groupId:options.groupId??null,limit}))).slice(0,16);
  let before=Number.MAX_SAFE_INTEGER;
  if(options.cursor){const match=/^aj1\.([1-9]\d{0,15})\.([a-f0-9]{16})$/.exec(options.cursor);if(!match||match[2]!==signature||!Number.isSafeInteger(Number(match[1])))fail('VALIDATION_ERROR','The background-change cursor is invalid.');before=Number(match[1]);}
  const rows=(await bindings.DB.prepare(`SELECT * FROM mentor_async_jobs WHERE account_id=? AND mentor_user_id=? AND sequence<? AND group_id IN (${ids.map(()=>'?').join(',')}) ORDER BY sequence DESC LIMIT ?`).bind(principal.accountId,principal.mentorUserId,before,...ids,limit+1).all<AsyncJobRow>()).results;
  const page=rows.slice(0,limit);return {items:page.map(asyncJobDto),nextCursor:rows.length>limit?`aj1.${page[page.length-1].sequence}.${signature}`:null};
}
export async function retryAsyncJob(bindings:PortalBindings,principal:Principal,id:string):Promise<AsyncAcceptedResponse> {
  await getAsyncJob(bindings,principal,id);const row=(await asyncJobRow(bindings.DB,id))!;
  requireLiveWriteAccess(bindings,row.operation);
  if(['queued','running','succeeded'].includes(row.status))return accepted(row,true);
  if(!['failed','needs_review'].includes(row.status)||!asyncJobDto(row).canRetry)fail('EDIT_NOT_ALLOWED','This change cannot be retried safely. Keep its reference for staff review.',409,false,row.request_id);
  const request=JSON.parse(row.request_json) as ClientRequest,source=await requestForJob(bindings.DB,row);
  if(source&&!['preflight_retry','upstream_pending','succeeded'].includes(source.state))fail('EDIT_NOT_ALLOWED','The recorded source outcome does not permit a retry.',409,false,row.request_id);
  const scope=await cachedAsyncScope(bindings,principal,true);ownedCachedGroup(scope,row.group_id);
  const uncertain=source?.state==='upstream_pending'||source?.state==='succeeded';
  // A status-only replay keeps the original ETags/files. The native ledger resolves them.
  const files=uncertain?await ownFiles(bindings.DB,principal,((request.payload as {attachmentIds?:string[]}).attachmentIds??[])):await validateIntent(bindings,principal,request,scope);
  const now=Date.now(),retryToken=crypto.randomUUID(),guards=uncertain?{sql:'',args:[]}:fileGuards(files);
  const update=bindings.DB.prepare(`UPDATE mentor_async_jobs SET status='queued',can_retry=0,error_json=NULL,lease_token=?,lease_expires_at=0,updated_at=? WHERE id=? AND account_id=? AND mentor_user_id=? AND status=? AND can_retry=1 AND attempts<? AND retry_after<=? AND ${scopeGuard()}
    AND NOT EXISTS (SELECT 1 FROM mentor_async_jobs other WHERE other.group_id=mentor_async_jobs.group_id AND other.id<>mentor_async_jobs.id AND other.status IN ${ASYNC_ACTIVE_STATES})
    AND NOT EXISTS (SELECT 1 FROM mentor_resource_locks WHERE resource_key=? AND request_id<>? AND (state<>'pending' OR lease_expires_at>?))${guards.sql}`)
    .bind(retryToken,now,id,principal.accountId,principal.mentorUserId,row.status,MAX_JOB_ATTEMPTS,now,principal.accountId,principal.mentorUserId,scope.row.generation,scope.row.current_invalidation_version,`group:${row.group_id}`,row.request_id,now,...guards.args);
  const results=await bindings.DB.batch([update,...(uncertain?[]:pinStatements(bindings.DB,id,files,retryToken))]);
  const next=(await asyncJobRow(bindings.DB,id))!;if(results[0].meta.changes!==1&&!['queued','running','succeeded'].includes(next.status))fail('REQUEST_IN_PROGRESS','Another change or a newer group snapshot prevents this retry. Refresh the status first.',409,true,row.request_id);
  return accepted(next);
}

import type { BridgeResponse, ClientRequest } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { applyConfirmedWriteToCache, invalidateMentorCache } from '../mentor-cache';
import { SOURCE_AUTH_DENIALS } from '../mentor-cache/config';
import { denyAccountCache } from '../mentor-cache/store';
import { ASYNC_ACTIVE_STATES, ASYNC_LEASE_MS } from './async-guards';
import type { AsyncJobError, AsyncJobStatus } from './async-contract';
import { asyncJobRow, cachedAsyncScope, fileFingerprint, JOB_RETENTION_MS, MAX_JOB_ATTEMPTS, MAX_QUEUED_AGE_MS, ownedCachedGroup, requestForJob, type AsyncJobRow } from './async-queue';
import { fail, MentorError, safeError } from './errors';
import { ownFile } from './files';
import { finishResourceLocks } from './resource-locks';
import { executeMentor, type LiveExecutionOptions } from './service';
import type { RequestRow } from './store';

export interface AsyncWorkerOptions extends LiveExecutionOptions { maxJobs?:number }
async function currentPrincipal(bindings:PortalBindings,job:AsyncJobRow):Promise<Principal> {
  const row=await bindings.DB.prepare("SELECT email,display_name FROM auth_accounts WHERE id=? AND mentor_user_id=? AND mode='live' AND role='mentor' AND status='active'").bind(job.account_id,job.mentor_user_id).first<{email:string;display_name:string}>();
  if(!row)fail('MENTOR_FORBIDDEN','The account or Mentor mapping is no longer active.',403);
  return {accountId:job.account_id,mentorUserId:job.mentor_user_id,mode:'live',role:'mentor',email:row.email,displayName:row.display_name};
}
async function settle(bindings:PortalBindings,job:AsyncJobRow,status:AsyncJobStatus,response?:BridgeResponse,error?:AsyncJobError,canRetry=false,retryAfter=0):Promise<boolean> {
  const now=Date.now();
  const results=await bindings.DB.batch([
    bindings.DB.prepare("UPDATE mentor_async_jobs SET status=?,response_json=?,error_json=?,can_retry=?,retry_after=?,lease_expires_at=0,updated_at=? WHERE id=? AND status='running' AND lease_token=?")
      .bind(status,response?JSON.stringify(response):null,error?JSON.stringify(error):null,canRetry&&job.attempts<MAX_JOB_ATTEMPTS?1:0,retryAfter,now,job.id,job.lease_token),
    bindings.DB.prepare("DELETE FROM mentor_async_files WHERE job_id=? AND EXISTS (SELECT 1 FROM mentor_async_jobs WHERE id=? AND lease_token=? AND status IN ('succeeded','failed'))").bind(job.id,job.id,job.lease_token),
  ]);
  return results[0].meta.changes===1;
}
function uncertainty():AsyncJobError {return {code:'PARTIAL_WRITE',message:'The source outcome needs reconciliation. Keep this request reference and contact staff before repeating the change.',retryable:false};}
function pendingError():AsyncJobError {return {code:'REQUEST_IN_PROGRESS',message:'The source still has an unresolved request. A permitted retry checks the same request; it does not create a new change.',retryable:false};}
async function repairKnownSuccess(bindings:PortalBindings,job:AsyncJobRow,source:RequestRow):Promise<void> {
  const response=JSON.parse(source.response_json!) as BridgeResponse;
  if(!response.ok)throw new Error('A recorded successful write lacks its success envelope');
  // A durable successful request is proof of the original source-authorized result, not
  // permission for another business dispatch. Cache writes and job reads recheck ownership.
  try {
    const principal=await currentPrincipal(bindings,job),scope=await cachedAsyncScope(bindings,principal);
    ownedCachedGroup(scope,job.group_id);
    await applyConfirmedWriteToCache(bindings,principal,JSON.parse(job.request_json) as ClientRequest,response,{completedAt:source.updated_at,replayed:true});
  } catch { console.error(JSON.stringify({event:'mentor_async_cache_repair_deferred',operation:job.operation,requestId:job.request_id})); }
  await finishResourceLocks(bindings.DB,{row:source,lease:source.lease_token},'complete');
  await settle(bindings,job,'succeeded',response);
}
/** Restart recovery never treats queue lease expiry as permission to repeat an HTTP write. */
async function recoverExpired(bindings:PortalBindings):Promise<void> {
  const now=Date.now();
  const rows=(await bindings.DB.prepare("SELECT * FROM mentor_async_jobs WHERE status='running' AND lease_expires_at<=? ORDER BY sequence LIMIT 20").bind(now).all<AsyncJobRow>()).results;
  for(const previous of rows){
    const token=crypto.randomUUID();
    const claimed=await bindings.DB.prepare("UPDATE mentor_async_jobs SET lease_token=?,lease_expires_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at<=?").bind(token,now+ASYNC_LEASE_MS,previous.id,previous.lease_token,now).run();
    if(claimed.meta.changes!==1)continue;
    const job={...previous,lease_token:token},source=await requestForJob(bindings.DB,job);
    if(!source){
      // No executor claim means no source call could start. The old worker is fenced
      // both at claim insertion and before every request, so this is safe to requeue.
      await bindings.DB.prepare("UPDATE mentor_async_jobs SET status='queued',attempts=MAX(0,attempts-1),lease_token=NULL,lease_expires_at=0,updated_at=? WHERE id=? AND lease_token=? AND status='running'").bind(now,job.id,token).run();
    } else if(source.state==='succeeded'&&source.response_json){await repairKnownSuccess(bindings,job,source);}
    else if(source.state==='failed'&&source.response_json){const response=JSON.parse(source.response_json) as BridgeResponse;await finishResourceLocks(bindings.DB,{row:source,lease:source.lease_token},'safe_failure');await settle(bindings,job,'failed',undefined,response.ok?uncertainty():response.error);}
    else if(source.state==='preflight_retry'){await finishResourceLocks(bindings.DB,{row:source,lease:source.lease_token},'safe_failure');await settle(bindings,job,'failed',undefined,{code:'UPSTREAM_UNAVAILABLE',message:'The source was not reached for this change. Retry this same request after the service is available.',retryable:true},true,source.lease_expires_at);}
    else if(source.state==='upstream_pending'){await settle(bindings,job,'needs_review',undefined,pendingError(),true,source.lease_expires_at);}
    else {await settle(bindings,job,'needs_review',undefined,uncertainty());}
  }
}
async function claimNext(bindings:PortalBindings):Promise<AsyncJobRow|null> {
  const now=Date.now(),token=crypto.randomUUID();
  const rows=(await bindings.DB.prepare(`SELECT * FROM mentor_async_jobs j WHERE j.status='queued' AND j.attempts<?
    AND NOT EXISTS (SELECT 1 FROM mentor_async_jobs earlier WHERE earlier.group_id=j.group_id AND earlier.sequence<j.sequence AND earlier.status IN ${ASYNC_ACTIVE_STATES}) ORDER BY j.sequence LIMIT 10`).bind(MAX_JOB_ATTEMPTS).all<AsyncJobRow>()).results;
  for(const row of rows){
    const result=await bindings.DB.prepare(`UPDATE mentor_async_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued' AND attempts<?
      AND (SELECT COUNT(*) FROM mentor_async_jobs WHERE status='running' AND lease_expires_at>?)<2
      AND NOT EXISTS (SELECT 1 FROM mentor_async_jobs other WHERE other.group_id=mentor_async_jobs.group_id AND other.id<>mentor_async_jobs.id AND (other.status='running' OR (other.sequence<mentor_async_jobs.sequence AND other.status IN ${ASYNC_ACTIVE_STATES})))`)
      .bind(token,now+ASYNC_LEASE_MS,now,row.id,MAX_JOB_ATTEMPTS,now).run();
    if(result.meta.changes===1)return asyncJobRow(bindings.DB,row.id);
  }
  return null;
}
async function checkPins(bindings:PortalBindings,principal:Principal,job:AsyncJobRow):Promise<void> {
  const p=(JSON.parse(job.request_json) as ClientRequest).payload as {attachmentIds?:string[]};
  const rows=(await bindings.DB.prepare('SELECT file_id,snapshot_json FROM mentor_async_files WHERE job_id=?').bind(job.id).all<{file_id:string;snapshot_json:string}>()).results;
  if(rows.length!==(p.attachmentIds??[]).length)fail('ATTACHMENT_REJECTED','A submitted attachment is no longer reserved by this request.',409);
  for(const row of rows){const file=await ownFile(bindings.DB,principal,row.file_id);if(fileFingerprint(file)!==row.snapshot_json)fail('ATTACHMENT_REJECTED','A submitted attachment changed. Review the original request before continuing.',409);}
}
async function executeJob(bindings:PortalBindings,job:AsyncJobRow,options:AsyncWorkerOptions):Promise<void> {
  let principal:Principal|undefined;
  try {
    principal=await currentPrincipal(bindings,job);
    const scope=await cachedAsyncScope(bindings,principal);ownedCachedGroup(scope,job.group_id);
    const source=await requestForJob(bindings.DB,job);
    if(source?.state==='succeeded'&&source.response_json){await repairKnownSuccess(bindings,job,source);return;}
    if(job.attempts===1&&!source&&job.created_at+MAX_QUEUED_AGE_MS<Date.now())fail('VERSION_CONFLICT','The queued change expired before dispatch. Review the current record and submit a new change.',409);
    await checkPins(bindings,principal,job);
    const request=JSON.parse(job.request_json) as ClientRequest;
    const response=await executeMentor(bindings,principal,request,job.request_id,{...options,asyncExecution:{jobId:job.id,leaseToken:job.lease_token!}});
    if(response.ok)await settle(bindings,job,'succeeded',response);else await settle(bindings,job,'failed',undefined,response.error);
  } catch(error) {
    const safe=safeError(error),source=await requestForJob(bindings.DB,job);
    if(principal&&SOURCE_AUTH_DENIALS.has(safe.code)){await denyAccountCache(bindings.DB,principal,Date.now(),Date.now()+86_400_000,safe.code);}
    if(principal&&safe.code==='VERSION_CONFLICT'){try{await invalidateMentorCache(bindings,principal);}catch{console.error('mentor_async_invalidation_failed');}}
    if(source?.state==='succeeded'&&source.response_json){await repairKnownSuccess(bindings,job,source);return;}
    if(source?.state==='upstream_pending'){await settle(bindings,job,'needs_review',undefined,pendingError(),true,source.lease_expires_at);}
    else if(source?.state==='uncertain'||source?.state==='pending'||safe.code==='PARTIAL_WRITE'){await settle(bindings,job,'needs_review',undefined,uncertainty());}
    else {
      const retry=source?.state==='preflight_retry'||(!source&&safe.retryable&&['UPSTREAM_UNAVAILABLE','CACHE_PENDING','CACHE_EXPIRED','RATE_LIMITED','REQUEST_IN_PROGRESS'].includes(safe.code));
      await settle(bindings,job,'failed',undefined,{code:safe.code,message:safe.message,retryable:retry},retry,Math.max(source?.lease_expires_at??0,Date.now()+3000));
    }
  }
}
export async function runAsyncJobs(bindings:PortalBindings,options:AsyncWorkerOptions={}):Promise<{processed:number;statuses:string[]}> {
  if(bindings.PORTAL_MODE==='demo')return {processed:0,statuses:[]};
  const max=options.maxJobs??1;if(!Number.isInteger(max)||max<1||max>10)throw new MentorError('VALIDATION_ERROR','Choose between one and ten background jobs per tick.');
  await recoverExpired(bindings);
  await bindings.DB.prepare("DELETE FROM mentor_async_jobs WHERE sequence IN (SELECT sequence FROM mentor_async_jobs WHERE status IN ('succeeded','failed') AND updated_at<? ORDER BY sequence LIMIT 100)").bind(Date.now()-JOB_RETENTION_MS).run();
  if(bindings.MENTOR_LIVE_WRITES_ENABLED!=='true')return {processed:0,statuses:[]};
  const statuses:string[]=[];
  for(let i=0;i<max;i++){
    const job=await claimNext(bindings);if(!job)break;
    await executeJob(bindings,job,options);
    const status=(await asyncJobRow(bindings.DB,job.id))?.status??'needs_review';statuses.push(status);
    console.log(JSON.stringify({event:'mentor_async_job',operation:job.operation,requestId:job.request_id,status}));
  }
  return {processed:statuses.length,statuses};
}

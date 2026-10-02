import type { AttachmentDto, BridgeResponse, ClientRequest, OperationPayloads, OperationResults, UploadFile } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { callFlow, configuredEndpoint, LIVE_WRITE_BUDGET_MS, type FlowCallContext } from '../flow-bridge';
import { readDemo, validateFileParent, writeDemo } from './demo';
import { claimRequest, completeDemo, completeLive, loadDemo, recordFailure, recordPreflightRetry, recordUpstreamPending, renewLiveClaim, type Claim } from './store';
import { isWrite, requireLiveWriteAccess, requireMentor } from './validation';
import { fail, MentorError, safeError } from './errors';
import { applyConfirmedWriteToCache, invalidateMentorCache, readCachedMentor } from '../mentor-cache';
import { authorizeLiveParent, bytesAsUpload, fileDto, ownFile, ownFiles, projectLiveAttachments, removeObject, stageUpload, validateDemoFile, type FileRow } from './files';
import { acquireResourceLocks, finishResourceLocks, markResourceDispatch, renewResourceLocks } from './resource-locks';

/** Internal dependency injection only; request JSON cannot override timings or transport. */
export interface LiveExecutionOptions { requestBudgetMs?: number; claimLeaseMs?: number; heartbeatMs?: number; fetcher?: typeof fetch }
function liveContext(bindings:PortalBindings,claim:Claim|undefined,options:LiveExecutionOptions) {
  const bounded=(value:number|undefined,fallback:number,max:number)=>{
    if(value===undefined)return fallback;
    if(!Number.isSafeInteger(value)||value<20||value>max)fail('VALIDATION_ERROR','Invalid internal request timing.');
    return value;
  };
  const budget=bounded(options.requestBudgetMs,LIVE_WRITE_BUDGET_MS,LIVE_WRITE_BUDGET_MS);
  const leaseMs=bounded(options.claimLeaseMs,45000,45000), heartbeatMs=bounded(options.heartbeatMs,10000,10000);
  if(heartbeatMs>=leaseMs)fail('VALIDATION_ERROR','The heartbeat must precede claim expiry.');
  const controller=new AbortController(),deadlineAt=Date.now()+budget;
  let stopped=false,leaseError:unknown,renewal=Promise.resolve(),resources:string[]=[];
  const state={dispatched:false,localMutation:false};
  const renew=()=>{
    renewal=renewal.then(async()=>{if(!stopped&&claim){const expires=Math.min(deadlineAt+5000,Date.now()+leaseMs);await renewLiveClaim(bindings.DB,claim,expires);await renewResourceLocks(bindings.DB,claim,resources,expires);}});
    return renewal;
  };
  const check=async()=>{
    if(leaseError)throw leaseError;
    if(controller.signal.aborted||Date.now()>=deadlineAt)fail('UPSTREAM_UNAVAILABLE','The request budget expired. Retry with the same request key.',503,true);
    await renew();
    if(leaseError)throw leaseError;
  };
  const timer=setTimeout(()=>controller.abort(),budget);
  const heartbeat=claim?setInterval(()=>{void renew().catch(error=>{leaseError=error;controller.abort();});},heartbeatMs):undefined;
  const context:FlowCallContext={deadlineAt,signal:controller.signal,fetcher:options.fetcher,readMemo:new Map(),beforeDispatch:async(operation)=>{await check();if(claim&&isWrite(operation))await markResourceDispatch(bindings.DB,claim,resources);},onWriteDispatch:()=>{state.dispatched=true;}};
  return {context,state,check,acquire:async(keys:string[])=>{await check();if(claim)resources=await acquireResourceLocks(bindings.DB,claim,keys,Math.min(deadlineAt+5000,Date.now()+leaseMs));},stop:()=>{stopped=true;clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);controller.abort();}};
}
type LiveContext=ReturnType<typeof liveContext>;
async function finishLocks(bindings:PortalBindings,claim:Claim,outcome:Parameters<typeof finishResourceLocks>[2]) {
  try {await finishResourceLocks(bindings.DB,claim,outcome);}catch {console.error(JSON.stringify({event:'mentor_write_lock_cleanup_failed',operation:claim.row.operation,requestId:claim.row.request_id}));}
}
async function authorizeWriteResources(bindings:PortalBindings,principal:Principal,request:ClientRequest,live:LiveContext) {
  const p=request.payload as Record<string,unknown>,keys:string[]=[];
  if(['profile.update','tickets.create','redemptions.create'].includes(request.operation)) {
    const response=await callFlow(bindings,principal,{operation:'profile.get',payload:{}},crypto.randomUUID(),undefined,undefined,live.context);
    if(!response.ok||(response.data as OperationResults['profile.get']).profile.id!==String(principal.mentorUserId))fail('OWNERSHIP_DENIED','The mentor profile is unavailable.',403);
    const family=request.operation==='profile.update'?'profile':request.operation==='tickets.create'?'ticketCreate':'redemptionCreate';
    keys.push(`${family}:mentor:${principal.mentorUserId}`);
  }
  if(typeof p.groupId==='string') {
    const response=await callFlow(bindings,principal,{operation:'groups.get',payload:{groupId:p.groupId}},crypto.randomUUID(),undefined,undefined,live.context);
    if(!response.ok)fail('OWNERSHIP_DENIED','The group is unavailable.',403);
    const detail=response.data as OperationResults['groups.get'];
    if(detail.group.id!==p.groupId)fail('OWNERSHIP_DENIED','The group is unavailable.',403);
    keys.push(`group:${p.groupId}`);
    if(typeof p.reportId==='string') {
      const kind=request.operation.split('.')[1];
      if(!detail.reports.some(report=>report.id===p.reportId&&report.kind===kind))fail('OWNERSHIP_DENIED','The report is unavailable.',403);
      keys.push(`${kind==='meetup'?'meetupReport':kind+'Report'}:${p.reportId}`);
    }
    if(typeof p.expenseId==='string') {
      if(!detail.expenses.some(expense=>expense.id===p.expenseId))fail('OWNERSHIP_DENIED','The expense is unavailable.',403);
      keys.push(`expense:${p.expenseId}`);
    }
  }
  if(request.operation==='tickets.update') {
    const response=await callFlow(bindings,principal,{operation:'tickets.get',payload:{ticketId:String(p.ticketId)}},crypto.randomUUID(),undefined,undefined,live.context);
    if(!response.ok||(response.data as OperationResults['tickets.get']).ticket.id!==p.ticketId)fail('OWNERSHIP_DENIED','The ticket is unavailable.',403);
    keys.push(`ticket:${p.ticketId}`);
  }
  await live.acquire(keys);
}
async function updateConfirmedCache(bindings:PortalBindings,principal:Principal,request:ClientRequest,response:BridgeResponse,claim:Claim,replayed=false) {
  if(bindings.MENTOR_CACHE_ENABLED!=='true'||!response.ok)return;
  try {await applyConfirmedWriteToCache(bindings,principal,request,response,{completedAt:claim.row.updated_at,replayed});}
  catch(error) {
    console.error(JSON.stringify({event:'mentor_cache_confirmation_failed',operation:request.operation,requestId:response.requestId,code:safeError(error).code}));
    try {await invalidateMentorCache(bindings,principal);}catch{console.error('mentor_cache_invalidation_failed');}
  }
}

async function readFiles(bindings:PortalBindings,principal:Principal,request:ClientRequest):Promise<FileRow[]> {
  const payload=request.payload as Record<string,unknown>;
  const ids=Array.isArray(payload.attachmentIds) ? payload.attachmentIds as string[] : typeof payload.attachmentId==='string' ? [payload.attachmentId] : [];
  return ownFiles(bindings.DB,principal,ids);
}
async function fileDownload(bindings:PortalBindings,principal:Principal,request:ClientRequest,requestId:string):Promise<BridgeResponse> {
  const v=request.payload as OperationPayloads['attachments.download'], file=await ownFile(bindings.DB,principal,v.attachmentId);
  if(file.parent_kind!==v.parentKind || file.parent_id!==(v.parentId??null) || (v.groupId && v.groupId!==file.group_id)) fail('OWNERSHIP_DENIED','This attachment does not belong to the selected record.',403);
  if(principal.mode==='demo') validateDemoFile((await loadDemo(bindings.DB,principal)).state,file);
  else { const {parent}=await authorizeLiveParent(bindings,principal,fileDto(file)); if(file.source_attachment_id && !parent?.attachments.some(a=>a.id===file.source_attachment_id)) fail('RECORD_NOT_FOUND','This attachment is no longer linked to this record.',404); }
  return {schemaVersion:'1.0',requestId,ok:true,data:{attachment:fileDto(file),downloadUrl:`/api/files/${encodeURIComponent(file.id)}`}};
}
async function writePreview(bindings:PortalBindings,principal:Principal,request:ClientRequest,claim:Claim):Promise<BridgeResponse> {
  let uploaded: FileRow|undefined;
  if(request.operation==='attachments.upload') {
    const v=request.payload as OperationPayloads['attachments.upload'];
    const {state}=await loadDemo(bindings.DB,principal);
    const {parent,group}=validateFileParent(state,{...v,parentId:v.parentId??null},v.expectedVersion,true);
    if(parent && parent.attachments.length>=5) fail('ATTACHMENT_REJECTED','A record can contain at most five attachments.');
    uploaded=await stageUpload(bindings,principal,v,claim.row.request_id,group?.id);
  }
  for(let attempt=0;attempt<3;attempt++) {
    const {state,revision}=await loadDemo(bindings.DB,principal), files=await readFiles(bindings,principal,request);
    const change=writeDemo(state,request,{requestId:claim.row.request_id,now:new Date().toISOString(),files:files.map(fileDto),...(uploaded?{upload:fileDto(uploaded)}:{})});
    const response=await completeDemo(bindings.DB,claim,revision,change);
    if(response) { if(change.deletedFileId) await removeObject(bindings,principal,change.deletedFileId); return response; }
  }
  fail('VERSION_CONFLICT','Another change is being saved. Reload the record before trying again.',409,true);
}
async function resolveLiveFiles(bindings:PortalBindings,principal:Principal,request:ClientRequest,live:LiveContext):Promise<{payload:Record<string,unknown>;staged:FileRow[]}> {
  const payload={...request.payload} as Record<string,unknown>;
  const files=await readFiles(bindings,principal,request), staged:FileRow[]=[],uploads:UploadFile[]=[];
  const parentKind:AttachmentDto['parentKind']|undefined=request.operation==='reports.meetup.save'?'meetupReport':request.operation==='expenses.save'?'expense':request.operation==='tickets.create'?'ticket':undefined;
  const parentId=(payload.reportId??payload.expenseId??payload.ticketId??null) as string|null;
  let aggregate=0;
  const parents=new Set<string>();
  for(const file of files) {
    if(!parentKind || file.parent_kind!==parentKind || (file.parent_id && file.parent_id!==parentId) || (file.group_id??undefined)!==payload.groupId) fail('OWNERSHIP_DENIED','An attachment belongs to another record.',403);
    const parentKey=JSON.stringify([file.parent_kind,file.parent_id,file.group_id]);
    if(!parents.has(parentKey)) {await authorizeLiveParent(bindings,principal,fileDto(file),undefined,false,live.context);parents.add(parentKey);}
    if(!file.source_attachment_id) { aggregate+=file.size_bytes; if(aggregate>10*1024*1024) fail('ATTACHMENT_REJECTED','Attach no more than 10 MiB of new files to one submission.'); uploads.push(await bytesAsUpload(bindings,file)); staged.push(file); }
  }
  delete payload.attachmentIds;
  if(uploads.length) payload.attachments=uploads;
  // The adapter must also enforce required existing photo/receipt and current report ownership.
  if(request.operation==='reports.meetup.save' && !payload.reportId && !uploads.some(f=>f.mimeType.startsWith('image/'))) fail('ATTACHMENT_REJECTED','A photograph is required before final submission.');
  if(request.operation==='expenses.save' && !payload.expenseId && uploads.length===0) fail('ATTACHMENT_REJECTED','An expense receipt is required.');
  return {payload,staged};
}
async function writeLive(bindings:PortalBindings,principal:Principal,request:ClientRequest,claim:Claim,live:LiveContext):Promise<BridgeResponse> {
  configuredEndpoint(bindings,request.operation);
  let response:BridgeResponse;
  if(request.operation==='attachments.upload') {
    const v=request.payload as OperationPayloads['attachments.upload'];
    const {parent,groupId}=await authorizeLiveParent(bindings,principal,{...v,parentId:v.parentId??null},v.expectedVersion,!claim.resumingUpstreamPending,live.context);
    await live.acquire(v.parentId?[`${v.parentKind}:${v.parentId}`]:[]);
    if(parent && parent.attachments.length>=5 && !claim.resumingUpstreamPending) fail('ATTACHMENT_REJECTED','A record can contain at most five attachments.');
    await live.check();live.state.localMutation=true;
    const file=await stageUpload(bindings,principal,v,claim.row.request_id,groupId);
    if(!v.parentId) response={schemaVersion:'1.0',requestId:claim.row.request_id,ok:true,data:{attachment:fileDto(file),parentVersion:null}};
    else {
      response=await callFlow(bindings,principal,request,claim.row.request_id,{parentKind:v.parentKind,parentId:v.parentId,expectedVersion:v.expectedVersion,file:v.file},undefined,live.context);
      if(response.ok) { const data=response.data as {attachment:AttachmentDto;parentVersion:string}; await bindings.DB.prepare('UPDATE mentor_files SET state=\'attached\',source_attachment_id=?,updated_at=? WHERE id=? AND account_id=? AND mode=\'live\'').bind(data.attachment.id,Date.now(),file.id,principal.accountId).run(); response={...response,data:{attachment:fileDto({...file,state:'attached',source_attachment_id:data.attachment.id}),parentVersion:data.parentVersion}} as BridgeResponse; }
    }
  } else if(request.operation==='attachments.delete') {
    const v=request.payload as OperationPayloads['attachments.delete'],file=await ownFile(bindings.DB,principal,v.attachmentId);
    if(file.parent_kind!==v.parentKind || file.parent_id!==(v.parentId??null) || (v.groupId && v.groupId!==file.group_id)) fail('OWNERSHIP_DENIED','This attachment belongs to another record.',403);
    const {parent}=await authorizeLiveParent(bindings,principal,fileDto(file),v.expectedVersion,!claim.resumingUpstreamPending,live.context);
    await live.acquire(file.parent_id?[`${file.parent_kind}:${file.parent_id}`]:[]);
    if(file.source_attachment_id) { if(!claim.resumingUpstreamPending && !parent?.attachments.some(a=>a.id===file.source_attachment_id)) fail('RECORD_NOT_FOUND','The attachment is no longer linked.',404); response=await callFlow(bindings,principal,request,claim.row.request_id,{parentKind:file.parent_kind,parentId:file.parent_id,expectedVersion:v.expectedVersion,attachmentId:file.source_attachment_id},undefined,live.context); }
    else response={schemaVersion:'1.0',requestId:claim.row.request_id,ok:true,data:{deleted:true,parentVersion:null}};
    await live.check();live.state.localMutation=true;
    await bindings.DB.prepare('UPDATE mentor_files SET state=\'deleting\',updated_at=? WHERE id=? AND account_id=? AND mode=\'live\'').bind(Date.now(),file.id,principal.accountId).run();
    await completeLive(bindings.DB,claim,response);
    await removeObject(bindings,principal,file.id);
    return response;
  } else {
    await authorizeWriteResources(bindings,principal,request,live);
    const {payload,staged}=await resolveLiveFiles(bindings,principal,request,live);
    response=await callFlow(bindings,principal,request,claim.row.request_id,payload,undefined,live.context);
    if(response.ok) {
      // Attachments created upstream are matched by unique filenames within this staged submission.
      const data=response.data as unknown as Record<string,unknown>;
      const parent=(data.report??data.expense??data.ticket) as {id:string;groupId?:string;attachments:AttachmentDto[]}|undefined;
      if(staged.length && !parent) fail('PARTIAL_WRITE','The submitted files need reconciliation. Contact staff before repeating this request.',409,false);
      for(const file of staged) {
        const matches=parent!.attachments.filter(a=>a.fileName===file.file_name);
        if(matches.length!==1) fail('PARTIAL_WRITE','The submitted attachment mapping needs reconciliation. Contact staff before repeating this request.',409,false);
        await bindings.DB.prepare('UPDATE mentor_files SET parent_id=?,group_id=?,source_attachment_id=?,state=\'attached\',updated_at=? WHERE id=? AND account_id=? AND mode=\'live\' AND parent_id IS NULL').bind(parent!.id,parent!.groupId??null,matches[0].id,Date.now(),file.id,principal.accountId).run();
      }
      response={...response,data:await projectLiveAttachments(bindings,principal,response.data,claim.row.request_id)} as BridgeResponse;
    }
  }
  await live.check();
  await completeLive(bindings.DB,claim,response);
  return response;
}
async function reauthorizeLiveReplay(bindings:PortalBindings,principal:Principal,request:ClientRequest,replay:BridgeResponse,context:FlowCallContext):Promise<void> {
  const read=(req:ClientRequest)=>callFlow(bindings,principal,req,crypto.randomUUID(),undefined,undefined,context);
  const p=request.payload as Record<string,unknown>,data=replay.ok?replay.data as unknown as Record<string,unknown>:{};
  if(request.operation.startsWith('attachments.')) {
    const returned=data.attachment as AttachmentDto|undefined;
    const fileId=typeof p.attachmentId==='string'?p.attachmentId:returned?.id;
    if(fileId) {
      const file=await ownFile(bindings.DB,principal,fileId,true);
      await authorizeLiveParent(bindings,principal,fileDto(file),undefined,false,context);
    } else await authorizeLiveParent(bindings,principal,{parentKind:p.parentKind as AttachmentDto['parentKind'],parentId:typeof p.parentId==='string'?p.parentId:null,...(typeof p.groupId==='string'?{groupId:p.groupId}:{})},undefined,false,context);
    return;
  }
  if(request.operation.startsWith('tickets.')) {
    const ticketId=p.ticketId ?? (data.ticket as {id?:string}|undefined)?.id;
    if(ticketId) { await read({operation:'tickets.get',payload:{ticketId:String(ticketId)}}); return; }
  }
  if(request.operation.startsWith('reports.')) {
    const reportId=p.reportId ?? (data.report as {id?:string}|undefined)?.id;
    if(reportId) { await read({operation:'reports.get',payload:{kind:request.operation.split('.')[1] as 'week1'|'meetup'|'completion',reportId:String(reportId)}}); return; }
  }
  if(p.groupId) {
    const response=await read({operation:'groups.get',payload:{groupId:String(p.groupId)}});
    const expenseId=p.expenseId ?? (data.expense as {id?:string}|undefined)?.id;
    if(expenseId && response.ok && !(response.data as {expenses:{id:string}[]}).expenses.some(e=>e.id===expenseId)) fail('RECORD_NOT_FOUND','This expense is no longer available to your account.',404);
    return;
  }
  await read({operation:'profile.get',payload:{}});
}
export async function executeMentor(bindings:PortalBindings,principal:Principal,request:ClientRequest,requestId=crypto.randomUUID(),options:LiveExecutionOptions={}):Promise<BridgeResponse> {
  const mode=bindings.PORTAL_MODE==='demo'?'demo':'live'; requireMentor(principal,mode);
  requireLiveWriteAccess(bindings,request.operation);
  if(request.operation==='attachments.download') return fileDownload(bindings,principal,request,requestId);
  if(!isWrite(request.operation)) {
    if(mode==='live') {
      // Background sync already replaces source attachment handles with account-owned IDs.
      if(bindings.MENTOR_CACHE_ENABLED==='true') return readCachedMentor(bindings,principal,request,requestId);
      const response=await callFlow(bindings,principal,request,requestId); return response.ok ? {...response,data:await projectLiveAttachments(bindings,principal,response.data,requestId)} as BridgeResponse:response;
    }
    return {schemaVersion:'1.0',requestId,ok:true,data:readDemo((await loadDemo(bindings.DB,principal)).state,request)} as BridgeResponse;
  }
  const claim=await claimRequest(bindings.DB,principal,request,requestId);
  if(claim.replay) {
    if(mode==='live') {
      const live=liveContext(bindings,undefined,options);
      try { await reauthorizeLiveReplay(bindings,principal,request,claim.replay,live.context); }
      catch(error) { const safe=safeError(error);safe.requestId=claim.row.request_id;throw safe; }
      finally {live.stop();}
      if(claim.replay.ok)await finishLocks(bindings,claim,'complete');
      await updateConfirmedCache(bindings,principal,request,claim.replay,claim,true);
    }
    if(claim.replay.ok && request.operation==='attachments.delete') await removeObject(bindings,principal,(request.payload as OperationPayloads['attachments.delete']).attachmentId);
    return claim.replay;
  }
  const live=mode==='live'?liveContext(bindings,claim,options):undefined;
  try {
    const response=mode==='demo' ? await writePreview(bindings,principal,request,claim) : await writeLive(bindings,principal,request,claim,live!);
    live?.stop();
    if(mode==='live')await finishLocks(bindings,claim,'complete');
    if(mode==='live')await updateConfirmedCache(bindings,principal,request,response,claim);
    return response;
  }
  catch(error) {
    live?.stop();
    if(mode==='live' && claim.resumingUpstreamPending && !live?.state.dispatched) {
      // A failed status-check preflight does not prove the previously acknowledged
      // source write stopped. Retain its ledger state and any dispatched resource locks.
      const safe=safeError(error);safe.requestId=claim.row.request_id;
      try {await recordUpstreamPending(bindings.DB,claim);}catch { /* Preserve the existing durable fence on storage failure. */ }
      await finishLocks(bindings,claim,'pending');
      throw safe;
    }
    if(mode==='live' && live?.state.dispatched && error instanceof MentorError && error.code==='REQUEST_IN_PROGRESS') {
      error.requestId=claim.row.request_id;
      try { await recordUpstreamPending(bindings.DB,claim); } catch { /* A pending row still blocks unsafe transport retries. */ }
      await finishLocks(bindings,claim,'pending');
      throw error;
    }
    if(live && !live.state.dispatched && !live.state.localMutation && error instanceof MentorError && error.retryable && ['UPSTREAM_UNAVAILABLE','RATE_LIMITED','REQUEST_IN_PROGRESS'].includes(error.code)) {
      error.requestId=claim.row.request_id;
      try {await recordPreflightRetry(bindings.DB,claim);}catch { /* The pending claim still prevents an unsafe resend. */ }
      await finishLocks(bindings,claim,'safe_failure');
      throw error;
    }
    const uncertain=mode==='live' && (!(error instanceof MentorError) || error.code==='PARTIAL_WRITE' || ((live?.state.dispatched || live?.state.localMutation) && error.code==='UPSTREAM_UNAVAILABLE'));
    const safe=uncertain ? new MentorError('PARTIAL_WRITE','The request outcome needs reconciliation. Keep this request reference and contact staff before repeating the change.',409,false,error instanceof MentorError?error.requestId:undefined) : safeError(error);
    safe.requestId??=claim.row.request_id;
    try { await recordFailure(bindings.DB,claim,safe,uncertain); } catch { /* The pending lease remains durable and prevents an unsafe live resend. */ }
    if(mode==='live')await finishLocks(bindings,claim,uncertain?'uncertain':'safe_failure');
    if(mode==='live' && bindings.MENTOR_CACHE_ENABLED==='true' && (uncertain || safe.code==='VERSION_CONFLICT')) {
      try {await invalidateMentorCache(bindings,principal);}catch{console.error('mentor_cache_invalidation_failed');}
    }
    throw safe;
  }
  finally {live?.stop();}
}

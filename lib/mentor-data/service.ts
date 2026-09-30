import type { AttachmentDto, BridgeResponse, ClientRequest, OperationPayloads, UploadFile } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { callFlow, configuredEndpoint } from '../flow-bridge';
import { readDemo, validateFileParent, writeDemo } from './demo';
import { claimRequest, completeDemo, completeLive, loadDemo, recordFailure, recordUpstreamPending, type Claim } from './store';
import { isWrite, requireMentor } from './validation';
import { fail, MentorError, safeError } from './errors';
import { authorizeLiveParent, bytesAsUpload, fileDto, ownFile, ownFiles, projectLiveAttachments, removeObject, stageUpload, validateDemoFile, type FileRow } from './files';

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
async function resolveLiveFiles(bindings:PortalBindings,principal:Principal,request:ClientRequest):Promise<{payload:Record<string,unknown>;staged:FileRow[]}> {
  const payload={...request.payload} as Record<string,unknown>;
  const files=await readFiles(bindings,principal,request), staged:FileRow[]=[],uploads:UploadFile[]=[];
  const parentKind:AttachmentDto['parentKind']|undefined=request.operation==='reports.meetup.save'?'meetupReport':request.operation==='expenses.save'?'expense':request.operation==='tickets.create'?'ticket':undefined;
  const parentId=(payload.reportId??payload.expenseId??payload.ticketId??null) as string|null;
  let aggregate=0;
  for(const file of files) {
    if(!parentKind || file.parent_kind!==parentKind || (file.parent_id && file.parent_id!==parentId) || (file.group_id??undefined)!==payload.groupId) fail('OWNERSHIP_DENIED','An attachment belongs to another record.',403);
    await authorizeLiveParent(bindings,principal,fileDto(file));
    if(!file.source_attachment_id) { aggregate+=file.size_bytes; if(aggregate>10*1024*1024) fail('ATTACHMENT_REJECTED','Attach no more than 10 MiB of new files to one submission.'); uploads.push(await bytesAsUpload(bindings,file)); staged.push(file); }
  }
  delete payload.attachmentIds;
  if(uploads.length) payload.attachments=uploads;
  // The adapter must also enforce required existing photo/receipt and current report ownership.
  if(request.operation==='reports.meetup.save' && !payload.reportId && !uploads.some(f=>f.mimeType.startsWith('image/'))) fail('ATTACHMENT_REJECTED','A photograph is required before final submission.');
  if(request.operation==='expenses.save' && !payload.expenseId && uploads.length===0) fail('ATTACHMENT_REJECTED','An expense receipt is required.');
  return {payload,staged};
}
async function writeLive(bindings:PortalBindings,principal:Principal,request:ClientRequest,claim:Claim):Promise<BridgeResponse> {
  configuredEndpoint(bindings,request.operation);
  let response:BridgeResponse;
  if(request.operation==='attachments.upload') {
    const v=request.payload as OperationPayloads['attachments.upload'];
    const {parent,groupId}=await authorizeLiveParent(bindings,principal,{...v,parentId:v.parentId??null},v.expectedVersion,true);
    if(parent && parent.attachments.length>=5) fail('ATTACHMENT_REJECTED','A record can contain at most five attachments.');
    const file=await stageUpload(bindings,principal,v,claim.row.request_id,groupId);
    if(!v.parentId) response={schemaVersion:'1.0',requestId:claim.row.request_id,ok:true,data:{attachment:fileDto(file),parentVersion:null}};
    else {
      response=await callFlow(bindings,principal,request,claim.row.request_id,{parentKind:v.parentKind,parentId:v.parentId,expectedVersion:v.expectedVersion,file:v.file});
      if(response.ok) { const data=response.data as {attachment:AttachmentDto;parentVersion:string}; await bindings.DB.prepare('UPDATE mentor_files SET state=\'attached\',source_attachment_id=?,updated_at=? WHERE id=? AND account_id=? AND mode=\'live\'').bind(data.attachment.id,Date.now(),file.id,principal.accountId).run(); response={...response,data:{attachment:fileDto({...file,state:'attached',source_attachment_id:data.attachment.id}),parentVersion:data.parentVersion}} as BridgeResponse; }
    }
  } else if(request.operation==='attachments.delete') {
    const v=request.payload as OperationPayloads['attachments.delete'],file=await ownFile(bindings.DB,principal,v.attachmentId);
    if(file.parent_kind!==v.parentKind || file.parent_id!==(v.parentId??null) || (v.groupId && v.groupId!==file.group_id)) fail('OWNERSHIP_DENIED','This attachment belongs to another record.',403);
    const {parent}=await authorizeLiveParent(bindings,principal,fileDto(file),v.expectedVersion,true);
    if(file.source_attachment_id) { if(!parent?.attachments.some(a=>a.id===file.source_attachment_id)) fail('RECORD_NOT_FOUND','The attachment is no longer linked.',404); response=await callFlow(bindings,principal,request,claim.row.request_id,{parentKind:file.parent_kind,parentId:file.parent_id,expectedVersion:v.expectedVersion,attachmentId:file.source_attachment_id}); }
    else response={schemaVersion:'1.0',requestId:claim.row.request_id,ok:true,data:{deleted:true,parentVersion:null}};
    await bindings.DB.prepare('UPDATE mentor_files SET state=\'deleting\',updated_at=? WHERE id=? AND account_id=? AND mode=\'live\'').bind(Date.now(),file.id,principal.accountId).run();
    await completeLive(bindings.DB,claim,response);
    await removeObject(bindings,principal,file.id);
    return response;
  } else {
    const {payload,staged}=await resolveLiveFiles(bindings,principal,request);
    response=await callFlow(bindings,principal,request,claim.row.request_id,payload);
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
  await completeLive(bindings.DB,claim,response);
  return response;
}
async function reauthorizeLiveReplay(bindings:PortalBindings,principal:Principal,request:ClientRequest,replay:BridgeResponse):Promise<void> {
  const p=request.payload as Record<string,unknown>,data=replay.ok?replay.data as unknown as Record<string,unknown>:{};
  if(request.operation.startsWith('attachments.')) {
    const returned=data.attachment as AttachmentDto|undefined;
    const fileId=typeof p.attachmentId==='string'?p.attachmentId:returned?.id;
    if(fileId) {
      const file=await ownFile(bindings.DB,principal,fileId,true);
      await authorizeLiveParent(bindings,principal,fileDto(file));
    } else await authorizeLiveParent(bindings,principal,{parentKind:p.parentKind as AttachmentDto['parentKind'],parentId:typeof p.parentId==='string'?p.parentId:null,...(typeof p.groupId==='string'?{groupId:p.groupId}:{})});
    return;
  }
  if(request.operation.startsWith('tickets.')) {
    const ticketId=p.ticketId ?? (data.ticket as {id?:string}|undefined)?.id;
    if(ticketId) { await callFlow(bindings,principal,{operation:'tickets.get',payload:{ticketId:String(ticketId)}},crypto.randomUUID()); return; }
  }
  if(request.operation.startsWith('reports.')) {
    const reportId=p.reportId ?? (data.report as {id?:string}|undefined)?.id;
    if(reportId) { await callFlow(bindings,principal,{operation:'reports.get',payload:{kind:request.operation.split('.')[1] as 'week1'|'meetup'|'completion',reportId:String(reportId)}},crypto.randomUUID()); return; }
  }
  if(p.groupId) {
    const response=await callFlow(bindings,principal,{operation:'groups.get',payload:{groupId:String(p.groupId)}},crypto.randomUUID());
    const expenseId=p.expenseId ?? (data.expense as {id?:string}|undefined)?.id;
    if(expenseId && response.ok && !(response.data as {expenses:{id:string}[]}).expenses.some(e=>e.id===expenseId)) fail('RECORD_NOT_FOUND','This expense is no longer available to your account.',404);
    return;
  }
  await callFlow(bindings,principal,{operation:'profile.get',payload:{}},crypto.randomUUID());
}
export async function executeMentor(bindings:PortalBindings,principal:Principal,request:ClientRequest,requestId=crypto.randomUUID()):Promise<BridgeResponse> {
  const mode=bindings.PORTAL_MODE==='demo'?'demo':'live'; requireMentor(principal,mode);
  if(request.operation==='attachments.download') return fileDownload(bindings,principal,request,requestId);
  if(!isWrite(request.operation)) {
    if(mode==='live') { const response=await callFlow(bindings,principal,request,requestId); return response.ok ? {...response,data:await projectLiveAttachments(bindings,principal,response.data,requestId)} as BridgeResponse:response; }
    return {schemaVersion:'1.0',requestId,ok:true,data:readDemo((await loadDemo(bindings.DB,principal)).state,request)} as BridgeResponse;
  }
  const claim=await claimRequest(bindings.DB,principal,request,requestId);
  if(claim.replay) {
    if(mode==='live') {
      try { await reauthorizeLiveReplay(bindings,principal,request,claim.replay); }
      catch(error) { const safe=safeError(error);safe.requestId=claim.row.request_id;throw safe; }
    }
    if(claim.replay.ok && request.operation==='attachments.delete') await removeObject(bindings,principal,(request.payload as OperationPayloads['attachments.delete']).attachmentId);
    return claim.replay;
  }
  try { return mode==='demo' ? await writePreview(bindings,principal,request,claim) : await writeLive(bindings,principal,request,claim); }
  catch(error) {
    if(mode==='live' && error instanceof MentorError && error.code==='REQUEST_IN_PROGRESS') {
      error.requestId=claim.row.request_id;
      try { await recordUpstreamPending(bindings.DB,claim); } catch { /* A pending row still blocks unsafe transport retries. */ }
      throw error;
    }
    const uncertain=mode==='live' && (!(error instanceof MentorError) || error.code==='PARTIAL_WRITE');
    const safe=uncertain ? new MentorError('PARTIAL_WRITE','The request outcome needs reconciliation. Keep this request reference and contact staff before repeating the change.',409,false) : safeError(error);
    safe.requestId=claim.row.request_id;
    try { await recordFailure(bindings.DB,claim,safe,uncertain); } catch { /* The pending lease remains durable and prevents an unsafe live resend. */ }
    throw safe;
  }
}

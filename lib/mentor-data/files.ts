import type { AttachmentDto, ClientRequest, GroupDto, OperationPayloads, ReportDto, ExpenseDto, TicketDto, UploadFile } from '../contracts';
import type { PortalBindings, Principal } from '../runtime';
import { callFlow, configuredEndpoint, type FlowCallContext } from '../flow-bridge';
import { fail } from './errors';
import { type DemoState, validateFileParent } from './demo';
import { expectVersion, parseUpload } from './validation';
import { sha256 } from './store';

export interface FileRow {
  id: string; account_id: string; mode: 'demo'|'live'; parent_kind: AttachmentDto['parentKind']; parent_id: string|null; group_id: string|null; file_name: string; mime_type: UploadFile['mimeType']; size_bytes: number; sha256: string; object_key: string; state: string; request_id: string; source_attachment_id: string|null;
}
export function fileDto(file: FileRow): AttachmentDto { return { id:file.id,fileName:file.file_name,mimeType:file.mime_type,sizeBytes:file.size_bytes || null,parentKind:file.parent_kind,parentId:file.parent_id,...(file.group_id ? {groupId:file.group_id}: {}) }; }
export async function ownFile(db: D1Database, principal: Principal, id: string, allowDeleting = false): Promise<FileRow> {
  const file = await db.prepare('SELECT * FROM mentor_files WHERE id=? AND account_id=? AND mode=?').bind(id,principal.accountId,principal.mode).first<FileRow>();
  if (!file || !['ready','attached',...(allowDeleting ? ['deleting','deleted']:[])].includes(file.state)) fail('RECORD_NOT_FOUND','This attachment is unavailable or does not belong to your account.',404);
  return file;
}
export async function ownFiles(db: D1Database, principal: Principal, ids: string[]): Promise<FileRow[]> {
  const result: FileRow[]=[]; for(const id of ids) result.push(await ownFile(db,principal,id)); return result;
}
export function validateDemoFile(state: DemoState, file: FileRow): void {
  const {parent} = validateFileParent(state,fileDto(file));
  if (parent && !parent.attachments.some(a=>a.id===file.id)) fail('RECORD_NOT_FOUND','The attachment is no longer linked to this record.',404);
}
export async function authorizeLiveParent(bindings: PortalBindings, principal: Principal, target: Pick<AttachmentDto,'parentKind'|'parentId'|'groupId'>, expectedVersion?: string, editing=false, context?: FlowCallContext): Promise<{parent?: ReportDto|ExpenseDto|TicketDto;groupId?:string}> {
  const read = (request: ClientRequest) => callFlow(bindings,principal,request,crypto.randomUUID(),undefined,undefined,context);
  if (!target.parentId && target.parentKind==='ticket') { if(target.groupId) fail('VALIDATION_ERROR','Ticket attachments cannot target a group.'); await read({operation:'profile.get',payload:{}}); return {}; }
  let parent: ReportDto|ExpenseDto|TicketDto|undefined, groupId=target.groupId;
  if(target.parentKind==='ticket') {
    const response=await read({operation:'tickets.get',payload:{ticketId:target.parentId!}});
    if(!response.ok) fail('OWNERSHIP_DENIED','The ticket is unavailable.',403);
    parent=(response.data as {ticket:TicketDto}).ticket;
    if(parent.id!==target.parentId) fail('OWNERSHIP_DENIED','The ticket is unavailable.',403);
    if(editing && parent.status==='Closed') fail('EDIT_NOT_ALLOWED','Closed tickets cannot be edited.',403);
  } else {
    if(target.parentId && target.parentKind==='meetupReport') {
      const response=await read({operation:'reports.get',payload:{kind:'meetup',reportId:target.parentId}});
      if(!response.ok) fail('OWNERSHIP_DENIED','The report is unavailable.',403);
      parent=(response.data as {report:ReportDto}).report;
      if(parent.id!==target.parentId || parent.kind!=='meetup') fail('OWNERSHIP_DENIED','The report is unavailable.',403);
      if(groupId && groupId!==parent.groupId) fail('OWNERSHIP_DENIED','The attachment group does not match.',403);
      groupId=parent.groupId;
    }
    if(!groupId) fail('OWNERSHIP_DENIED','An owned group is required.',403);
    const response=await read({operation:'groups.get',payload:{groupId}});
    if(!response.ok) fail('OWNERSHIP_DENIED','The group is unavailable.',403);
    const detail=response.data as {group:GroupDto;expenses:ExpenseDto[]};
    if(detail.group.id!==groupId) fail('OWNERSHIP_DENIED','The group is unavailable.',403);
    if(editing && !detail.group.reportEnabled) fail('EDIT_NOT_ALLOWED','Reports are closed for this group.',403);
    if(target.parentId && target.parentKind==='expense') { parent=detail.expenses.find(e=>e.id===target.parentId); if(!parent) fail('OWNERSHIP_DENIED','The expense is unavailable.',403); }
    if(editing && parent && 'reviewStatus' in parent && parent.reviewStatus==='accepted') fail('EDIT_NOT_ALLOWED','Accepted records cannot be edited.',403);
  }
  if(editing && parent) expectVersion(parent.version,expectedVersion);
  return {parent,groupId};
}
export async function stageUpload(bindings: PortalBindings, principal: Principal, payload: OperationPayloads['attachments.upload'], requestId:string, groupId?:string): Promise<FileRow> {
  if(!bindings.BUCKET) fail('UPSTREAM_UNAVAILABLE','Attachment storage is unavailable.',503,true);
  const bytes=parseUpload(payload.file), digest=await sha256(bytes), now=Date.now(), fileId=`file_${requestId}`;
  const key=`${principal.mode}/${principal.accountId}/${fileId}`;
  await bindings.DB.prepare('INSERT INTO mentor_files (id,account_id,mode,parent_kind,parent_id,group_id,file_name,mime_type,size_bytes,sha256,object_key,state,request_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,\'staging\',?,?,? WHERE (SELECT COUNT(*) FROM mentor_files WHERE account_id=? AND mode=? AND state IN (\'staging\',\'ready\'))<20 ON CONFLICT(id) DO NOTHING').bind(fileId,principal.accountId,principal.mode,payload.parentKind,payload.parentId??null,groupId??payload.groupId??null,payload.file.fileName,payload.file.mimeType,bytes.length,digest,key,requestId,now,now,principal.accountId,principal.mode).run();
  const row=await bindings.DB.prepare('SELECT * FROM mentor_files WHERE id=? AND account_id=? AND mode=?').bind(fileId,principal.accountId,principal.mode).first<FileRow>();
  if(!row) fail('ATTACHMENT_REJECTED','Too many unattached uploads. Remove an unused upload before adding another.',409);
  if(row.sha256!==digest) fail('IDEMPOTENCY_CONFLICT','The existing attachment has different contents.',409);
  if(['ready','attached'].includes(row.state)) return row;
  try {
    await bindings.BUCKET.put(key,bytes,{httpMetadata:{contentType:payload.file.mimeType},customMetadata:{sha256:digest}});
    await bindings.DB.prepare('UPDATE mentor_files SET state=\'ready\',updated_at=? WHERE id=? AND account_id=? AND mode=? AND state=\'staging\'').bind(Date.now(),fileId,principal.accountId,principal.mode).run();
  } catch { await bindings.DB.prepare('UPDATE mentor_files SET state=\'failed\',updated_at=? WHERE id=? AND account_id=? AND mode=? AND state=\'staging\'').bind(Date.now(),fileId,principal.accountId,principal.mode).run(); fail('UPSTREAM_UNAVAILABLE','The attachment could not be stored. Please try again later.',503,true); }
  return {...row,state:'ready'};
}
export async function removeObject(bindings: PortalBindings, principal: Principal, id:string): Promise<void> {
  const row=await ownFile(bindings.DB,principal,id,true);
  if(row.state==='deleted') return;
  if(row.state!=='deleting') fail('EDIT_NOT_ALLOWED','The attachment has not been marked for removal.',409);
  try { await bindings.BUCKET.delete(row.object_key); await bindings.DB.prepare('UPDATE mentor_files SET state=\'deleted\',updated_at=? WHERE id=? AND account_id=? AND mode=? AND state=\'deleting\'').bind(Date.now(),id,principal.accountId,principal.mode).run(); }
  catch { fail('PARTIAL_WRITE','Access to the attachment has been removed, but storage cleanup needs a retry with the same request key.',409,true); }
}
export async function bytesAsUpload(bindings:PortalBindings,file:FileRow):Promise<UploadFile> {
  const object=await bindings.BUCKET.get(file.object_key);
  if(!object || object.size!==file.size_bytes || object.size>5242880) fail('ATTACHMENT_REJECTED','The staged attachment is unavailable.');
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(await sha256(bytes)!==file.sha256) fail('ATTACHMENT_REJECTED','The staged attachment could not be verified.');
  let raw=''; for(let i=0;i<bytes.length;i+=32768) raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return {fileName:file.file_name,mimeType:file.mime_type,contentBase64:btoa(raw)};
}
/** Replace adapter handles with per-account opaque file IDs before any browser response. */
export async function projectLiveAttachments(bindings:PortalBindings,principal:Principal,value:unknown,requestId:string,groupId?:string):Promise<unknown> {
  if(Array.isArray(value)) { const items=[]; for(const item of value) items.push(await projectLiveAttachments(bindings,principal,item,requestId,groupId));return items; }
  if(!value || typeof value!=='object') return value;
  const obj=value as Record<string,unknown>;
  const nextGroup=typeof obj.groupId==='string' ? obj.groupId:groupId;
  if(typeof obj.fileName==='string' && typeof obj.id==='string' && typeof obj.parentKind==='string' && typeof obj.parentId==='string') {
    const a=obj as unknown as AttachmentDto;
    const existing=await bindings.DB.prepare('SELECT * FROM mentor_files WHERE account_id=? AND mode=\'live\' AND parent_kind=? AND parent_id=? AND source_attachment_id=? AND state=\'attached\' LIMIT 1').bind(principal.accountId,a.parentKind,a.parentId,a.id).first<FileRow>();
    if(existing) return fileDto(existing);
    const digest=await sha256(`${principal.accountId}|${a.parentKind}|${a.parentId}|${a.id}`), id=`file_${digest.slice(0,48)}`,now=Date.now();
    await bindings.DB.prepare('INSERT INTO mentor_files (id,account_id,mode,parent_kind,parent_id,group_id,file_name,mime_type,size_bytes,sha256,object_key,state,request_id,source_attachment_id,created_at,updated_at) VALUES (?,?,\'live\',?,?,?,?,?,?,\'\',?,\'attached\',?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,principal.accountId,a.parentKind,a.parentId,nextGroup??null,a.fileName,a.mimeType,a.sizeBytes??0,`live/${principal.accountId}/${id}`,requestId,a.id,now,now).run();
    return {...a,id,...(nextGroup?{groupId:nextGroup}:{})};
  }
  const result:Record<string,unknown>={}; for(const [key,item]of Object.entries(obj)) result[key]=await projectLiveAttachments(bindings,principal,item,requestId,nextGroup);return result;
}
export async function liveFileBytes(bindings:PortalBindings,principal:Principal,file:FileRow):Promise<{bytes:Uint8Array;mimeType:string;fileName:string}> {
  configuredEndpoint(bindings,'attachments.download');
  const {parent}=await authorizeLiveParent(bindings,principal,fileDto(file));
  if(file.source_attachment_id) {
    if(!parent?.attachments.some(a=>a.id===file.source_attachment_id)) fail('RECORD_NOT_FOUND','The attachment is no longer linked to this record.',404);
    const payload={parentKind:file.parent_kind,parentId:file.parent_id!,attachmentId:file.source_attachment_id};
    const response=await callFlow(bindings,principal,{operation:'attachments.download',payload} as ClientRequest,crypto.randomUUID());
    if(!response.ok) fail('UPSTREAM_UNAVAILABLE','The attachment is unavailable.',503);
    const download=response.data as unknown as UploadFile & {sizeBytes:number};
    const bytes=parseUpload(download,255);if(bytes.length!==download.sizeBytes) fail('ATTACHMENT_REJECTED','The attachment size could not be verified.');
    return {bytes,mimeType:download.mimeType,fileName:download.fileName};
  }
  const upload=await bytesAsUpload(bindings,file); return {bytes:parseUpload(upload),mimeType:upload.mimeType,fileName:upload.fileName};
}

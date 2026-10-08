import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import type { ClientRequest, OperationResults } from '../lib/contracts';
import type { Principal } from '../lib/runtime';
import type { StandaloneBindings } from '../lib/standalone';
import type { PrivateSnapshot } from '../lib/mentor-cache/types';
import type { AsyncAcceptedResponse, AsyncJob } from '../lib/mentor-data/async-contract';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',GROUP='900101';
const principal:Principal={accountId:A,mentorUserId:17,email:'synthetic-a@example.test',displayName:'Synthetic A',role:'mentor',mode:'live'};
const other:Principal={...principal,accountId:B,mentorUserId:18,email:'synthetic-b@example.test'};
const png={fileName:'synthetic.png',mimeType:'image/png' as const,contentBase64:'iVBORw0KGgoAAAAAAAAAAA=='};
let impl:{
  createStandaloneBindings:typeof import('../lib/standalone').createStandaloneBindings;
  enqueueMentorWrite:typeof import('../lib/mentor-data/async-queue').enqueueMentorWrite;
  getAsyncJob:typeof import('../lib/mentor-data/async-queue').getAsyncJob;
  listAsyncJobs:typeof import('../lib/mentor-data/async-queue').listAsyncJobs;
  retryAsyncJob:typeof import('../lib/mentor-data/async-queue').retryAsyncJob;
  shouldEnqueueAsync:typeof import('../lib/mentor-data/async-queue').shouldEnqueueAsync;
  runAsyncJobs:typeof import('../lib/mentor-data/async-worker').runAsyncJobs;
  executeMentor:typeof import('../lib/mentor-data/service').executeMentor;
  readCachedMentor:typeof import('../lib/mentor-cache').readCachedMentor;
  validateFlowData:typeof import('../lib/mentor-data/response-validation').validateFlowData;
  invalidateMentorCache:typeof import('../lib/mentor-cache').invalidateMentorCache;
};
let moduleDirectory:string,directory:string,bindings:StandaloneBindings,raw:Record<string,unknown>,detail:OperationResults['groups.get'];
let calls:{operation:string;requestId:string;key?:string;payload:Record<string,unknown>}[],nextId:number;
let holdRead:(()=>Promise<void>)|undefined,deny=false,writeError:string|undefined,transport=false;
let originalFetch:typeof fetch;
before(async()=>{
  const bundle=await build({stdin:{contents:`export {createStandaloneBindings} from './lib/standalone';export {enqueueMentorWrite,getAsyncJob,listAsyncJobs,retryAsyncJob,shouldEnqueueAsync} from './lib/mentor-data/async-queue';export {runAsyncJobs} from './lib/mentor-data/async-worker';export {executeMentor} from './lib/mentor-data/service';export {readCachedMentor,invalidateMentorCache} from './lib/mentor-cache';export {validateFlowData} from './lib/mentor-data/response-validation';`,resolveDir:process.cwd(),sourcefile:'async-test.ts',loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',target:'node24'});
  moduleDirectory=await mkdtemp(join(tmpdir(),'mentor-async-module-'));const path=join(moduleDirectory,'test.mjs');await writeFile(path,bundle.outputFiles[0].text);impl=await import(pathToFileURL(path).href);
  originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Unexpected real fetch in synthetic queue test');};
});
after(async()=>{globalThis.fetch=originalFetch;if(moduleDirectory)await rm(moduleDirectory,{recursive:true,force:true});});
function open(){return impl.createStandaloneBindings({dataDir:directory,migrationsDir:resolve('drizzle'),env:{PORTAL_MODE:'live',MENTOR_LIVE_WRITES_ENABLED:'true',MENTOR_ASYNC_WRITES_ENABLED:'true',MENTOR_CACHE_ENABLED:'true',MENTOR_SYNC_ALLOWED_USER_IDS:'17,18',MENTOR_BRIDGE_KEY:'synthetic-background-writer-key-at-least-32-characters',MENTOR_READ_URL:'https://queue-fixture.logic.azure.com/read',MENTOR_ATTENDANCE_URL:'https://queue-fixture.logic.azure.com/attendance',MENTOR_REPORT_URL:'https://queue-fixture.logic.azure.com/report',MENTOR_ATTACHMENT_URL:'https://queue-fixture.logic.azure.com/attachment'}});}
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'mentor-async-db-'));bindings=open();calls=[];nextId=910000;holdRead=undefined;deny=false;writeError=undefined;transport=false;
  raw=JSON.parse(await readFile('tests/fixtures/flow-contract-groups.get.json','utf8')).data;
  raw.reports=[];raw.expenses=[];raw.tasks=[];raw.mentees=(raw.mentees as Record<string,unknown>[]).slice(0,1);
  Object.assign(raw.group as object,{version:'1',reportEnabled:true,meetupCount:0,meetupReports:0,week1Reports:0,completionReports:0});
  Object.assign((raw.mentees as object[])[0],{version:'1',attended:false,attendanceRecorded:false});
  detail=impl.validateFlowData('groups.get',structuredClone(raw)) as OperationResults['groups.get'];
  for(const person of [principal,other]){
    await bindings.DB.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,'mentor','live','active',?)").bind(person.accountId,person.email,person.displayName,person.mentorUserId,Date.now()).run();
    await bindings.DB.prepare("INSERT INTO mentor_cache_sync_state (account_id,mentor_user_id,lease_expires_at,invalidation_version,next_private_sync_at,next_catalog_sync_at,authorization_state,failure_count,updated_at) VALUES (?,?,0,0,?,?,'authorized',0,?)").bind(person.accountId,person.mentorUserId,Date.now()+86_400_000,Date.now()+172_800_000,Date.now()).run();
    await seed(person,person===principal?[detail]:[]);
  }
});
afterEach(async()=>{bindings?.close();if(directory)await rm(directory,{recursive:true,force:true});});
async function seed(person=principal,groups=[detail]){
  const now=Date.now(),balance={balance:100,totalCredit:100,reserved:0,roundCount:1,milestone:200,milestoneRound:2};
  const snapshot:PrivateSnapshot={schemaVersion:1,bootstrap:{mentor:{id:String(person.mentorUserId),displayName:'Synthetic',preferredName:'Synthetic',communicationEmail:person.email},balance,groups:groups.map(item=>item.group),tasks:[],mode:'live',previewLabel:null},profile:{profile:{id:String(person.mentorUserId),version:'1',displayName:'Synthetic',preferredName:'Synthetic',communicationEmail:person.email,country:'Australia',phoneNumber:'0400000000',communicationChannels:[],programs:[],stream:'',otherStream:'',wwcc:'WWC-SYNTHETIC',wwccExpiryDate:null,dateOfBirth:null},choices:{communicationChannels:[],programs:[],streams:[]}},balance,groups,transactions:[],tickets:[],redemptions:[]};
  const state=await bindings.DB.prepare('SELECT invalidation_version FROM mentor_cache_sync_state WHERE account_id=? AND mentor_user_id=?').bind(person.accountId,person.mentorUserId).first<{invalidation_version:number}>();
  await bindings.DB.prepare("INSERT INTO mentor_cache_snapshots (account_id,mentor_user_id,namespace,generation,snapshot_json,synced_at,refresh_after,hard_expires_at,invalidation_version) VALUES (?,?,'private',?,?,?,?,?,?) ON CONFLICT(account_id,mentor_user_id,namespace) DO UPDATE SET generation=excluded.generation,snapshot_json=excluded.snapshot_json,synced_at=excluded.synced_at,refresh_after=excluded.refresh_after,hard_expires_at=excluded.hard_expires_at,invalidation_version=excluded.invalidation_version").bind(person.accountId,person.mentorUserId,randomUUID().replaceAll('-',''),JSON.stringify(snapshot),now,now+86_400_000,now+259_200_000,state!.invalidation_version).run();
}
const sourceFetch:typeof fetch=async(_url,init)=>{
  const sent=JSON.parse(String(init?.body));calls.push({operation:sent.operation,requestId:sent.requestId,key:sent.idempotencyKey,payload:sent.payload});
  const p=sent.payload,base={schemaVersion:'1.0',requestId:sent.requestId};
  const error=(code:string,retryable=false)=>Response.json({...base,ok:false,error:{code,message:'Synthetic source response',retryable}},{status:409});
  if(sent.operation==='groups.get'){
    await holdRead?.();if(deny)return error('OWNERSHIP_DENIED');return Response.json({...base,ok:true,data:raw});
  }
  if(sent.operation==='reports.get')return Response.json({...base,ok:true,data:{report:(raw.reports as Record<string,unknown>[]).find(report=>report.id===p.reportId&&report.kind===p.kind)}});
  if(writeError)return error(writeError,writeError==='UPSTREAM_UNAVAILABLE');
  const group=raw.group as Record<string,unknown>,mentees=raw.mentees as Record<string,unknown>[];
  let data;
  if(sent.operation==='attendance.save'){
    if(group.version!==p.expectedVersion||p.entries.some((entry:{menteeId:number;expectedVersion:string})=>mentees.find(row=>row.id===entry.menteeId)?.version!==entry.expectedVersion))return error('VERSION_CONFLICT');
    for(const entry of p.entries){const row=mentees.find(item=>item.id===entry.menteeId)!;Object.assign(row,{attended:entry.attended,attendanceRecorded:true,version:String(Number(row.version)+1)});}
    group.version=String(Number(group.version)+1);group.attendedCount=mentees.filter(item=>item.attended).length;data={group,mentees};
  }else if(/^reports\.(week1|meetup|completion)\.save$/.test(sent.operation)){
    const kind=sent.operation.split('.')[1],id=p.reportId??++nextId,reports=raw.reports as Record<string,unknown>[];
    const existing=reports.find(report=>report.id===id&&report.kind===kind);
    if(p.reportId&&(!existing||existing.version!==p.expectedVersion))return error('VERSION_CONFLICT');
    const report={...p,id,version:String(existing?Number(existing.version)+1:1),kind,groupId:p.groupId,title:p.title??'Synthetic submitted report',createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),reviewStatus:'submitted',submissionState:'submitted',attachments:(p.attachments??[]).map((file:{fileName:string;mimeType:string},index:number)=>({id:`photo_${id}_${index}`,fileName:file.fileName,mimeType:file.mimeType,sizeBytes:16,parentKind:'meetupReport',parentId:id}))};
    delete report.expectedVersion;delete report.submit;
    if(existing)reports[reports.indexOf(existing)]=report;else reports.push(report);
    group.version=String(Number(group.version)+1);group.meetupCount=reports.filter(r=>r.kind==='meetup').length;group.meetupReports=group.meetupCount;data={report,group};
  }else throw new Error('Unexpected synthetic operation');
  if(transport)throw new Error('Synthetic lost HTTP acknowledgement');
  return Response.json({...base,ok:true,data});
};
function attendance():ClientRequest<'attendance.save'>{return {operation:'attendance.save',idempotencyKey:randomUUID(),payload:{groupId:GROUP,expectedVersion:'1',entries:[{menteeId:detail.mentees[0].id,expectedVersion:'1',attended:true}]}};}
function week1():ClientRequest<'reports.week1.save'>{return {operation:'reports.week1.save',idempotencyKey:randomUUID(),payload:{groupId:GROUP,question:'Synthetic initial contact',submit:true}};}
function meetup(file:string):ClientRequest<'reports.meetup.save'>{return {operation:'reports.meetup.save',idempotencyKey:randomUUID(),payload:{groupId:GROUP,title:'Synthetic meetup',meetupDate:'2026-10-08',attendance:1,description:'Synthetic report text',isUseGC:false,isRequiredSC:false,attachmentIds:[file],submit:true}};}
async function enqueue(request:ClientRequest):Promise<AsyncJob>{const result=await impl.enqueueMentorWrite(bindings,principal,request,randomUUID());assert.ok('accepted'in result&&result.accepted);return (result as AsyncAcceptedResponse).data.job;}
async function upload(name='synthetic.png'){const result=await impl.executeMentor(bindings,principal,{operation:'attachments.upload',idempotencyKey:randomUUID(),payload:{parentKind:'meetupReport',groupId:GROUP,file:{...png,fileName:name}}},randomUUID(),{fetcher:sourceFetch});assert.ok(result.ok);return (result.data as OperationResults['attachments.upload']).attachment.id;}
function code(expected:string){return(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===expected;}
async function count(table:string){return Number(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM '+table).first<number>('n'));}
async function run(){return impl.runAsyncJobs(bindings,{fetcher:sourceFetch,maxJobs:1});}
async function coolDown(id:string){await bindings.DB.prepare('UPDATE mentor_async_jobs SET retry_after=0 WHERE id=?').bind(id).run();await bindings.DB.prepare("UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=(SELECT idempotency_key FROM mentor_async_jobs WHERE id=?) AND state IN ('preflight_retry','upstream_pending')").bind(id).run();}

test('acceptance is local, durable, fast, idempotent and leaves confirmed cache unchanged',async()=>{
  const request=attendance(),before=await bindings.DB.prepare("SELECT snapshot_json FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(A).first<string>('snapshot_json');
  const start=performance.now(),[a,b]=await Promise.all([enqueue(request),enqueue(request)]);assert.ok(performance.now()-start<1000);assert.equal(a.id,b.id);assert.equal(a.status,'queued');assert.equal(calls.length,0);assert.equal(await count('mentor_requests'),0);assert.equal(await count('mentor_async_jobs'),1);
  assert.equal(await bindings.DB.prepare("SELECT snapshot_json FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(A).first<string>('snapshot_json'),before);
  await assert.rejects(enqueue({...request,payload:{...request.payload,entries:[{...request.payload.entries[0],attended:false}]}}),code('IDEMPOTENCY_CONFLICT'));
  bindings.close();bindings=open();assert.equal((await impl.getAsyncJob(bindings,principal,a.id)).status,'queued');
  await run();const done=await impl.getAsyncJob(bindings,principal,a.id);assert.equal(done.status,'succeeded');assert.equal(calls.filter(item=>item.operation==='attendance.save').length,1);assert.ok(calls.every(item=>item.operation!=='attendance.save'||item.requestId===a.requestId));
  const cached=await impl.readCachedMentor(bindings,principal,{operation:'groups.get',payload:{groupId:GROUP}});assert.ok(cached.ok);assert.equal((cached.data as OperationResults['groups.get']).mentees[0].attended,true);
});

test('disabled feature, stale cache, bad versions and foreign mentees fail before admission',async()=>{
  bindings.MENTOR_ASYNC_WRITES_ENABLED='false';assert.equal(impl.shouldEnqueueAsync(bindings,attendance()),false);await assert.rejects(enqueue(attendance()),code('DRAFT_NOT_CONFIGURED'));bindings.MENTOR_ASYNC_WRITES_ENABLED='true';
  const invalid=attendance();invalid.payload.entries[0].menteeId='123';await assert.rejects(enqueue(invalid),code('OWNERSHIP_DENIED'));
  await assert.rejects(enqueue({...attendance(),payload:{...attendance().payload,expectedVersion:'999'}}),code('VERSION_CONFLICT'));
  await bindings.DB.prepare("UPDATE mentor_cache_snapshots SET refresh_after=0 WHERE account_id=?").bind(A).run();await assert.rejects(enqueue(attendance()),code('CACHE_EXPIRED'));
  assert.equal(await count('mentor_async_jobs'),0);assert.deepEqual(calls,[]);
});

test('job reads are owner scoped and disappear after group removal, revocation or mapping change',async()=>{
  const job=await enqueue(week1());await assert.rejects(impl.getAsyncJob(bindings,other,job.id),code('RECORD_NOT_FOUND'));
  await seed(principal,[]);assert.equal((await impl.listAsyncJobs(bindings,principal)).items.length,0);await assert.rejects(impl.getAsyncJob(bindings,principal,job.id),code('RECORD_NOT_FOUND'));await run();assert.deepEqual(calls,[]);
  await seed();await bindings.DB.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").bind(A).run();await assert.rejects(impl.getAsyncJob(bindings,principal,job.id),code('MENTOR_FORBIDDEN'));
  await bindings.DB.prepare("UPDATE auth_accounts SET status='active',mentor_user_id=19 WHERE id=?").bind(A).run();await assert.rejects(impl.getAsyncJob(bindings,principal,job.id),code('MENTOR_FORBIDDEN'));
});

test('pending list survives flag rollback and pages without another account or group leaking',async()=>{
  const jobs=[];for(let i=0;i<3;i++)jobs.push(await enqueue(week1()));bindings.MENTOR_ASYNC_WRITES_ENABLED='false';
  const first=await impl.listAsyncJobs(bindings,principal,{limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);const second=await impl.listAsyncJobs(bindings,principal,{limit:2,cursor:first.nextCursor!});assert.equal(second.items.length,1);assert.equal(second.items[0].id,jobs[0].id);
  await assert.rejects(impl.listAsyncJobs(bindings,principal,{limit:2,cursor:'aj1.4.0000000000000000'}),code('VALIDATION_ERROR'));
  assert.deepEqual(await impl.listAsyncJobs({...bindings,PORTAL_MODE:'demo'},{...principal,mode:'demo'}),{items:[],nextCursor:null});
});

test('synchronous group writes cannot bypass an accepted lane while new staged files remain possible',async()=>{
  const job=await enqueue(attendance());await assert.rejects(impl.executeMentor(bindings,principal,week1(),randomUUID(),{fetcher:sourceFetch}),code('REQUEST_IN_PROGRESS'));assert.deepEqual(calls,[]);assert.equal(await count('mentor_requests'),0);
  assert.ok(await upload('separate-receipt-photo.png'));assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'queued');
});

test('two meetups stay distinct and concurrent workers preserve the group lane and attachment bindings',async()=>{
  const f1=await upload('one.png'),f2=await upload('two.png');calls=[];const first=await enqueue(meetup(f1)),second=await enqueue(meetup(f2));assert.notEqual(first.clientRecordId,second.clientRecordId);
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{started=resolve;});holdRead=async()=>{started();await new Promise<void>(resolve=>{release=resolve;});};
  const running=run();await held;assert.equal((await run()).processed,0);holdRead=undefined;release();await running;await run();
  const one=await impl.getAsyncJob(bindings,principal,first.id),two=await impl.getAsyncJob(bindings,principal,second.id);assert.equal(one.status,'succeeded');assert.equal(two.status,'succeeded');
  assert.equal(one.operation,'reports.meetup.save');assert.equal(two.operation,'reports.meetup.save');if(one.operation!=='reports.meetup.save'||two.operation!=='reports.meetup.save')throw Error('Unexpected operation');
  assert.notEqual(one.result!.report.id,two.result!.report.id);assert.equal(one.result!.report.attachments[0].id,f1);assert.equal(two.result!.report.attachments[0].id,f2);assert.equal(one.result!.report.attachments[0].parentId,one.result!.report.id);
  assert.equal(await count('mentor_async_files'),0);assert.equal(calls.filter(item=>item.operation==='reports.meetup.save').length,2);assert.ok(calls.every(item=>!JSON.stringify(item.payload).includes('pending_')));
  const replay=await enqueue(JSON.parse((await bindings.DB.prepare('SELECT request_json FROM mentor_async_jobs WHERE id=?').bind(first.id).first<string>('request_json'))!));assert.equal(replay.id,first.id);assert.equal(replay.status,'succeeded');
});

test('queued photos cannot be deleted and changed pin metadata is rejected before HTTP',async()=>{
  const file=await upload(),job=await enqueue(meetup(file));calls=[];
  await assert.rejects(impl.executeMentor(bindings,principal,{operation:'attachments.delete',idempotencyKey:randomUUID(),payload:{parentKind:'meetupReport',groupId:GROUP,attachmentId:file}},randomUUID(),{fetcher:sourceFetch}),code('REQUEST_IN_PROGRESS'));assert.deepEqual(calls,[]);
  await bindings.DB.prepare('UPDATE mentor_files SET file_name=? WHERE id=?').bind('changed.png',file).run();await run();const state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'failed');assert.equal(state.error?.code,'ATTACHMENT_REJECTED');assert.deepEqual(calls,[]);
});

test('a deletion started before enqueue cannot remove the newly reserved photo',async()=>{
  const file=await upload();let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{started=resolve;});holdRead=async()=>{started();await new Promise<void>(resolve=>{release=resolve;});};
  const deletion=impl.executeMentor(bindings,principal,{operation:'attachments.delete',idempotencyKey:randomUUID(),payload:{parentKind:'meetupReport',groupId:GROUP,attachmentId:file}},randomUUID(),{fetcher:sourceFetch});const rejected=assert.rejects(deletion,code('REQUEST_IN_PROGRESS'));await held;await enqueue(meetup(file));holdRead=undefined;release();await rejected;
  assert.equal(await bindings.DB.prepare('SELECT state FROM mentor_files WHERE id=?').bind(file).first<string>('state'),'ready');assert.equal(await count('mentor_async_files'),1);
});

test('unclaimed crashed jobs resume but expired live executor claims require review',async()=>{
  const job=await enqueue(week1());await bindings.DB.prepare("UPDATE mentor_async_jobs SET status='running',attempts=1,lease_token='dead',lease_expires_at=0 WHERE id=?").bind(job.id).run();await run();assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'succeeded');assert.equal(calls.filter(item=>item.operation==='reports.week1.save').length,1);
  await seed(principal,[impl.validateFlowData('groups.get',structuredClone(raw)) as OperationResults['groups.get']]);
  const uncertain=await enqueue(week1());const row=await bindings.DB.prepare('SELECT * FROM mentor_async_jobs WHERE id=?').bind(uncertain.id).first<Record<string,unknown>>();
  await bindings.DB.prepare("INSERT INTO mentor_requests (account_id,mode,idempotency_key,request_id,operation,payload_hash,state,lease_token,lease_expires_at,created_at,updated_at) VALUES (?,'live',?,?,?,?,'pending','dead',0,?,?)").bind(A,row!.idempotency_key,uncertain.requestId,uncertain.operation,row!.payload_hash,Date.now(),Date.now()).run();
  await bindings.DB.prepare("UPDATE mentor_async_jobs SET status='running',attempts=1,lease_token='dead',lease_expires_at=0 WHERE id=?").bind(uncertain.id).run();calls=[];await run();const state=await impl.getAsyncJob(bindings,principal,uncertain.id);assert.equal(state.status,'needs_review');assert.equal(state.canRetry,false);assert.deepEqual(calls,[]);
});

test('a lost source acknowledgement is never automatically or explicitly resent',async()=>{
  const job=await enqueue(week1());transport=true;await run();const state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'needs_review');assert.equal(state.error?.code,'PARTIAL_WRITE');assert.equal(state.canRetry,false);assert.equal((raw.reports as unknown[]).length,1);
  transport=false;assert.equal((await run()).processed,0);await assert.rejects(impl.retryAsyncJob(bindings,principal,job.id),code('EDIT_NOT_ALLOWED'));assert.equal(calls.filter(item=>item.operation==='reports.week1.save').length,1);
});

test('safe preflight failures retry explicitly with the original request ID and key',async()=>{
  const request=week1(),job=await enqueue(request);holdRead=async()=>{throw Error('Synthetic preflight transport failure');};await run();let state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'failed');assert.equal(calls.filter(item=>item.operation==='reports.week1.save').length,0);
  await coolDown(job.id);state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.canRetry,true);holdRead=undefined;await impl.retryAsyncJob(bindings,principal,job.id);await run();state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'succeeded');const sent=calls.find(item=>item.operation==='reports.week1.save')!;assert.equal(sent.requestId,job.requestId);assert.equal(sent.key,request.idempotencyKey);
});

test('native in-progress plus later EDIT_NOT_ALLOWED remains unresolved and retains locks',async()=>{
  const job=await enqueue(week1());writeError='REQUEST_IN_PROGRESS';await run();await coolDown(job.id);assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).canRetry,true);
  await impl.retryAsyncJob(bindings,principal,job.id);writeError='EDIT_NOT_ALLOWED';await run();const state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'needs_review');assert.equal(await bindings.DB.prepare('SELECT state FROM mentor_requests WHERE request_id=?').bind(job.requestId).first<string>('state'),'upstream_pending');assert.equal(await count('mentor_resource_locks'),1);
});

test('known conflict stays failed and schedules background refresh without rebasing the intent',async()=>{
  const job=await enqueue(attendance());(raw.group as Record<string,unknown>).version='2';await run();const state=await impl.getAsyncJob(bindings,principal,job.id);assert.equal(state.status,'failed');assert.equal(state.error?.code,'VERSION_CONFLICT');assert.equal(state.canRetry,false);
  const due=await bindings.DB.prepare('SELECT next_private_sync_at FROM mentor_cache_sync_state WHERE account_id=?').bind(A).first<number>('next_private_sync_at');assert.ok(due!<=Date.now());assert.equal(state.intent.operation,'attendance.save');if(state.intent.operation==='attendance.save')assert.equal(state.intent.payload.expectedVersion,'1');
});

test('source ownership denial clears cached job visibility before another queued write can run',async()=>{
  const job=await enqueue(week1());deny=true;await run();assert.equal(await count('mentor_cache_snapshots'),1);await assert.rejects(impl.getAsyncJob(bindings,principal,job.id),code('MENTOR_FORBIDDEN'));assert.equal(calls.filter(item=>item.operation==='reports.week1.save').length,0);
});

test('known persisted success repairs queue/cache after a crash without a business replay',async()=>{
  const job=await enqueue(week1());await run();await bindings.DB.prepare("UPDATE mentor_async_jobs SET status='running',lease_token='crashed',lease_expires_at=0,response_json=NULL WHERE id=?").bind(job.id).run();await seed();await bindings.DB.prepare('UPDATE mentor_cache_snapshots SET synced_at=? WHERE account_id=?').bind(Date.now()-60_000,A).run();calls=[];await run();assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'succeeded');assert.deepEqual(calls,[]);const result=await impl.readCachedMentor(bindings,principal,{operation:'reports.list',payload:{groupId:GROUP}});assert.ok(result.ok);assert.equal((result.data as OperationResults['reports.list']).items.length,1);
});

test('global pause retains queued intents and safe retry attempts are bounded',async()=>{
  const job=await enqueue(week1());bindings.MENTOR_LIVE_WRITES_ENABLED='false';assert.equal((await run()).processed,0);assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'queued');bindings.MENTOR_LIVE_WRITES_ENABLED='true';
  holdRead=async()=>{throw Error('Synthetic preflight failure');};for(let i=0;i<3;i++){if(i){await coolDown(job.id);await impl.retryAsyncJob(bindings,principal,job.id);}await run();}
  await coolDown(job.id);assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).canRetry,false);await assert.rejects(impl.retryAsyncJob(bindings,principal,job.id),code('EDIT_NOT_ALLOWED'));
});

test('a stale queue worker cannot dispatch after another lease fences its delayed preflight',async()=>{
  const job=await enqueue(week1());let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{started=resolve;});holdRead=async()=>{started();await new Promise<void>(resolve=>{release=resolve;});};
  const running=run();await held;await bindings.DB.prepare("UPDATE mentor_async_jobs SET lease_token='replacement' WHERE id=?").bind(job.id).run();holdRead=undefined;release();await running;
  assert.equal(calls.filter(item=>item.operation==='reports.week1.save').length,0);await bindings.DB.prepare('UPDATE mentor_async_jobs SET lease_expires_at=0 WHERE id=?').bind(job.id).run();await run();assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'needs_review');
});

test('synchronous and async admission racing on one key cannot create two intent owners',async()=>{
  const request=attendance();const results=await Promise.allSettled([
    impl.enqueueMentorWrite(bindings,principal,request,randomUUID()),
    impl.executeMentor(bindings,principal,request,randomUUID(),{fetcher:sourceFetch}),
  ]);
  for(const result of results)if(result.status==='rejected')assert.ok(code('REQUEST_IN_PROGRESS')(result.reason));
  await run();assert.equal(calls.filter(item=>item.operation==='attendance.save').length,1);assert.equal(await count('mentor_requests'),1);
  const sourceId=await bindings.DB.prepare('SELECT request_id FROM mentor_requests WHERE idempotency_key=?').bind(request.idempotencyKey).first<string>('request_id');
  const jobId=await bindings.DB.prepare('SELECT request_id FROM mentor_async_jobs WHERE idempotency_key=?').bind(request.idempotencyKey).first<string>('request_id');if(jobId)assert.equal(jobId,sourceId);
});

test('a live group resource lock prevents partial queue admission or attachment reservation',async()=>{
  const file=await upload();calls=[];await bindings.DB.prepare("INSERT INTO mentor_resource_locks (resource_key,request_id,owner_account_id,lease_token,lease_expires_at,state,updated_at) VALUES (?,?,?, ?,?,'pending',?)").bind(`group:${GROUP}`,randomUUID(),A,randomUUID(),Date.now()+60_000,Date.now()).run();
  await assert.rejects(enqueue(meetup(file)),code('REQUEST_IN_PROGRESS'));assert.equal(await count('mentor_async_jobs'),0);assert.equal(await count('mentor_async_files'),0);assert.deepEqual(calls,[]);
});

test('retryable jobs cannot bypass the queue attempt cap through the old synchronous endpoint',async()=>{
  const request=week1(),job=await enqueue(request);holdRead=async()=>{throw Error('Synthetic preflight failure');};await run();await coolDown(job.id);calls=[];
  await assert.rejects(impl.executeMentor(bindings,principal,request,randomUUID(),{fetcher:sourceFetch}),code('REQUEST_IN_PROGRESS'));assert.deepEqual(calls,[]);
});

test('old unstarted jobs expire safely while unresolved jobs and their photo pins survive retention',async()=>{
  const file=await upload(),expired=await enqueue(meetup(file));calls=[];await bindings.DB.prepare('UPDATE mentor_async_jobs SET created_at=? WHERE id=?').bind(Date.now()-25*3_600_000,expired.id).run();await run();assert.equal((await impl.getAsyncJob(bindings,principal,expired.id)).status,'failed');assert.equal(await count('mentor_async_files'),0);assert.deepEqual(calls,[]);
  const unresolved=await enqueue(meetup(file));await bindings.DB.prepare("UPDATE mentor_async_jobs SET status='needs_review',updated_at=? WHERE id=?").bind(Date.now()-31*86_400_000,unresolved.id).run();await bindings.DB.prepare('UPDATE mentor_async_jobs SET updated_at=? WHERE id=?').bind(Date.now()-31*86_400_000,expired.id).run();bindings.MENTOR_LIVE_WRITES_ENABLED='false';await run();assert.equal(await count('mentor_async_jobs'),1);assert.equal(await count('mentor_async_files'),1);assert.equal((await impl.getAsyncJob(bindings,principal,unresolved.id)).status,'needs_review');
});

test('completion is queued independently and report drafts are rejected without changing scope',async()=>{
  const request:ClientRequest<'reports.completion.save'>={operation:'reports.completion.save',idempotencyKey:randomUUID(),payload:{groupId:GROUP,keyTakeaways:'Synthetic learning',mostHelpful:'Synthetic activity',isJointAgain:true,submit:true}};
  const job=await enqueue(request);await run();assert.equal((await impl.getAsyncJob(bindings,principal,job.id)).status,'succeeded');assert.deepEqual(calls.map(item=>item.operation),['groups.get','reports.completion.save']);
  await assert.rejects(enqueue({...week1(),payload:{...week1().payload,submit:false}}),code('DRAFT_NOT_CONFIGURED'));
});

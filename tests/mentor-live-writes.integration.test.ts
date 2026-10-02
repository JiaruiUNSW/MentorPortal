import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { BridgeResponse, Operation, OperationResults } from '../lib/contracts';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GROUP='900101',MENTEE='900111';
const png={fileName:'fixture.png',mimeType:'image/png',contentBase64:'iVBORw0KGgoAAAAAAAAAAA=='};
let runtime:Miniflare,database:Awaited<ReturnType<Miniflare['getD1Database']>>;
before(async()=>{
  const group=JSON.parse(await readFile('tests/fixtures/flow-contract-groups.get.json','utf8')).data;
  const profile=JSON.parse(await readFile('tests/fixtures/flow-contract-profile.get.json','utf8')).data;
  group.reports=[];group.expenses=[];group.tasks=[];group.mentees=group.mentees.slice(0,1);
  Object.assign(group.group,{version:'1',reportEnabled:true,meetupCount:0,meetupReports:0,week1Reports:0,completionReports:0});
  const bundle=await build({stdin:{contents:`
    import {executeMentor} from './lib/mentor-data/service';
    import {readCachedMentor,applyConfirmedWriteToCache} from './lib/mentor-cache';
    import {claimLease,publishSnapshots,snapshotFor} from './lib/mentor-cache/store';
    import {cacheConfig} from './lib/mentor-cache/config';
    import {parseClientRequest} from './lib/mentor-data/validation';
    import {validateFlowData} from './lib/mentor-data/response-validation';
    import {errorEnvelope,safeError} from './lib/mentor-data/errors';
    const GROUP=${JSON.stringify(group)},PROFILE=${JSON.stringify(profile)};
    const controls=new Map(),sources=new Map(),calls=[],heldSyncs=new Map();
    const copy=x=>JSON.parse(JSON.stringify(x));
    function source(account,actor) {
      if(!sources.has(account)){const profile=copy(PROFILE);profile.profile.id=actor;sources.set(account,{detail:copy(GROUP),profile,tickets:[],redemptions:[],pendingReplies:new Map(),next:910000});}
      return sources.get(account);
    }
    async function delay(ms,signal){if(!ms)return;await new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();});}
    async function sourceFetch(url,init){
      const sent=JSON.parse(init.body),account=sent.actor.portalAccountId,p=sent.payload,state=source(account,sent.actor.userId),control=controls.get(account)||{};
      calls.push({operation:sent.operation,account,key:sent.idempotencyKey,requestId:sent.requestId});
      const envelope={schemaVersion:'1.0',requestId:sent.requestId};
      await delay(control.delays?.[sent.operation],init.signal);
      if(control.failOperation===sent.operation)return Response.json({...envelope,ok:false,error:{code:control.failCode||'UPSTREAM_UNAVAILABLE',message:'Synthetic service failure',retryable:true}},{status:503});
      if(control.transportOperation===sent.operation)throw new Error('Synthetic private transport message');
      if(sent.idempotencyKey&&state.pendingReplies.has(sent.idempotencyKey))return Response.json({...envelope,ok:true,data:state.pendingReplies.get(sent.idempotencyKey),replayed:true});
      const files=(parentKind,parentId)=> (p.attachments||[]).map(file=>({id:btoa(file.fileName).replaceAll('=','').replaceAll('+','-').replaceAll('/','_'),fileName:file.fileName,mimeType:file.mimeType,sizeBytes:16,parentKind,parentId}));
      const version=x=>String(Number(x.replaceAll('"',''))+1);
      let data;
      switch(sent.operation){
        case 'profile.get':data=state.profile;break;
        case 'rewards.get':data={reward:{id:p.rewardId,name:'Synthetic reward',inStock:true,points:40,discountPoints:null,effectivePoints:40,productType:'Voucher',imageUrl:null},options:[]};break;
        case 'groups.get':data=state.detail;break;
        case 'reports.get':data={report:state.detail.reports.find(report=>report.id===p.reportId&&report.kind===p.kind)};break;
        case 'tickets.get':data={ticket:state.tickets.find(ticket=>ticket.id===p.ticketId)};break;
        case 'tickets.create':{
          const id=++state.next,ticket={id,version:'1',title:p.title,description:p.description,status:'Open',staffName:'',staffComment:'',createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),attachments:files('ticket',id)};
          state.tickets.push(ticket);data={ticket};break;
        }
        case 'tickets.update':{
          const ticket=state.tickets.find(ticket=>ticket.id===p.ticketId);
          if(ticket.version!==p.expectedVersion)return Response.json({...envelope,ok:false,error:{code:'VERSION_CONFLICT',message:'Synthetic etag conflict',retryable:false}},{status:409});
          Object.assign(ticket,{title:p.title,description:p.description,version:version(ticket.version)});data={ticket};break;
        }
        case 'profile.update':Object.assign(state.profile.profile,{country:p.country,phoneNumber:p.phoneNumber,version:version(state.profile.profile.version)});data={profile:state.profile.profile};break;
        case 'attendance.save':
          for(const entry of p.entries){const mentee=state.detail.mentees.find(item=>item.id===entry.menteeId);Object.assign(mentee,{attended:entry.attended,attendanceRecorded:true,version:version(mentee.version)});}
          state.detail.group.version=version(state.detail.group.version);state.detail.group.attendedCount=state.detail.mentees.filter(item=>item.attended).length;data={group:state.detail.group,mentees:state.detail.mentees};break;
        case 'reports.meetup.save':{
          const id=p.reportId||++state.next,report={id,version:'1',kind:'meetup',groupId:p.groupId,title:p.title,createdAt:new Date().toISOString(),modifiedAt:new Date().toISOString(),reviewStatus:'submitted',submissionState:'submitted',meetupDate:p.meetupDate,attendance:p.attendance,description:p.description,isUseGC:p.isUseGC,isRequiredSC:p.isRequiredSC,attachments:files('meetupReport',id)};
          state.detail.reports.push(report);state.detail.group.meetupCount=state.detail.reports.length;state.detail.group.meetupReports=state.detail.reports.length;state.detail.group.version=version(state.detail.group.version);data={report,group:state.detail.group};break;
        }
        case 'expenses.save':{
          const id=++state.next,expense={id,version:'1',groupId:p.groupId,meetupReportId:p.meetupReportId,amount:p.amount,currency:'AUD',reviewStatus:'submitted',processingStatus:'unknown',attachments:files('expense',id)};state.detail.expenses.push(expense);data={expense};break;
        }
        case 'attachments.upload': case 'attachments.delete':{
          const parent=p.parentKind==='ticket'?state.tickets.find(item=>item.id===p.parentId):p.parentKind==='expense'?state.detail.expenses.find(item=>item.id===p.parentId):state.detail.reports.find(item=>item.id===p.parentId);
          if(parent.version!==p.expectedVersion)return Response.json({...envelope,ok:false,error:{code:'VERSION_CONFLICT',message:'Synthetic parent etag conflict',retryable:false}},{status:409});
          parent.version=version(parent.version);
          if(sent.operation==='attachments.delete'){parent.attachments=parent.attachments.filter(item=>item.id!==p.attachmentId);data={deleted:true,parentVersion:parent.version};}
          else{const attachment={id:btoa(p.file.fileName).replaceAll('=',''),fileName:p.file.fileName,mimeType:p.file.mimeType,sizeBytes:16,parentKind:p.parentKind,parentId:p.parentId};parent.attachments.push(attachment);data={attachment,parentVersion:parent.version};}
          break;
        }
        case 'redemptions.create':data={redemption:{id:++state.next,requestReference:'SYNTHETIC',rewardId:p.rewardId,rewardName:'Synthetic reward',optionIds:p.optionIds,comment:p.comment,points:40,status:'pending',creditState:'not_debited',createdAt:new Date().toISOString()}};break;
        default:throw new Error('Unexpected synthetic operation '+sent.operation);
      }
      if(control.pendingOnceOperation===sent.operation){state.pendingReplies.set(sent.idempotencyKey,copy(data));return Response.json({...envelope,ok:false,error:{code:'REQUEST_IN_PROGRESS',message:'Synthetic ledger is finishing',retryable:true}},{status:409});}
      return Response.json({...envelope,ok:true,data});
    }
    export default {async fetch(request,env){
      const input=await request.json(),account=input.account||${JSON.stringify(A)},actor=input.actor||1;
      const principal={accountId:account,mentorUserId:actor,email:'synthetic@example.test',displayName:'Synthetic',role:'mentor',mode:'live'};
      const bindings={...env,PORTAL_MODE:'live',MENTOR_LIVE_WRITES_ENABLED:'true',MENTOR_CACHE_ENABLED:input.cache===false?'false':'true',MENTOR_SYNC_ALLOWED_USER_IDS:'1,2',MENTOR_BRIDGE_KEY:'synthetic-test-key-with-at-least-32-characters'};
      for(const key of ['MENTOR_READ_URL','MENTOR_TICKET_URL','MENTOR_PROFILE_URL','MENTOR_ATTENDANCE_URL','MENTOR_REPORT_URL','MENTOR_EXPENSE_URL','MENTOR_ATTACHMENT_URL','MENTOR_REDEEM_URL'])bindings[key]='https://synthetic.logic.azure.com/test';
      try{
        if(input.action==='reset'){sources.clear();controls.clear();heldSyncs.clear();calls.length=0;return Response.json({ok:true});}
        if(input.action==='control'){controls.set(account,input.control||{});return Response.json({ok:true});}
        if(input.action==='stats')return Response.json({calls});
        if(input.action==='hold-sync'){const lease=await claimLease(env.DB,principal,Date.now(),60000),row=await snapshotFor(env.DB,principal,'private');heldSyncs.set(account,{lease,snapshot:JSON.parse(row.snapshot_json)});return Response.json({ok:true});}
        if(input.action==='publish-old-sync'){const held=heldSyncs.get(account);return Response.json({ok:await publishSnapshots(env.DB,principal,held.lease,{private:held.snapshot},cacheConfig(bindings),Date.now())});}
        if(input.action==='seed'){
          const state=source(account,actor),detail=validateFlowData('groups.get',state.detail),profile=validateFlowData('profile.get',state.profile),balance={balance:100,totalCredit:100,roundCount:1,milestone:0,milestoneRound:0,reserved:0};
          const snapshot={schemaVersion:1,bootstrap:{mentor:profile.profile,balance,groups:[],tasks:[],mode:'live',previewLabel:null},profile,balance,groups:[detail],transactions:[],tickets:[],redemptions:[]},now=Date.now()-1000;
          await env.DB.batch([
            env.DB.prepare("INSERT INTO mentor_cache_sync_state (account_id,mentor_user_id,lease_expires_at,invalidation_version,next_private_sync_at,next_catalog_sync_at,authorization_state,failure_count,updated_at) VALUES (?,?,0,0,?,?,'authorized',0,?)").bind(account,actor,now+86400000,now+172800000,now),
            env.DB.prepare("INSERT INTO mentor_cache_snapshots (account_id,mentor_user_id,namespace,generation,snapshot_json,synced_at,refresh_after,hard_expires_at,invalidation_version) VALUES (?,?,'private',?,?,?,?,?,0)").bind(account,actor,'a'.repeat(32),JSON.stringify(snapshot),now,now+86400000,now+259200000)
          ]);return Response.json({ok:true});
        }
        const parsed=parseClientRequest(input.request);
        if(input.action==='read')return Response.json(await readCachedMentor(bindings,principal,parsed));
        if(input.action==='confirm'){await applyConfirmedWriteToCache(bindings,principal,parsed,input.response,input.options);return Response.json({ok:true});}
        return Response.json(await executeMentor(bindings,principal,parsed,crypto.randomUUID(),{...input.options,fetcher:sourceFetch}));
      }catch(error){const safe=safeError(error);return Response.json(errorEnvelope(crypto.randomUUID(),safe),{status:safe.status});}
    }};`,resolveDir:process.cwd(),loader:'ts',sourcefile:'mentor-live-write-test-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-22',d1Databases:['DB'],r2Buckets:['BUCKET']});
  database=await runtime.getD1Database('DB');
  for(const file of (await readdir('drizzle')).filter(file=>file.endsWith('.sql')).sort())for(const sql of (await readFile(`drizzle/${file}`,'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await database.prepare(sql).run();
});
after(async()=>{await runtime?.dispose();});
beforeEach(async()=>{
  for(const table of ['mentor_resource_locks','mentor_requests','mentor_cache_snapshots','mentor_cache_sync_state','mentor_files','mentor_audit','auth_accounts'])await database.prepare(`DELETE FROM ${table}`).run();
  await command({action:'reset'});
  for(const [account,actor]of [[A,1],[B,2]] as const){await database.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,'mentor','live','active',?)").bind(account,`${actor}@example.test`,'Synthetic',actor,Date.now()).run();await command({action:'seed',account,actor});}
});
async function command(input:Record<string,unknown>){const response=await runtime.dispatchFetch('https://local-write-test.invalid/run',{method:'POST',body:JSON.stringify(input)});return {status:response.status,body:await response.json() as BridgeResponse & {calls?:{operation:string;account:string;key?:string}[]}};}
async function write<O extends Operation>(operation:O,payload:unknown,key=crypto.randomUUID(),extra:Record<string,unknown>={}){return command({action:'write',request:{operation,payload,idempotencyKey:key},...extra});}
async function read<O extends Operation>(operation:O,payload:unknown={},extra:Record<string,unknown>={}){return command({action:'read',request:{operation,payload},...extra});}
function data<O extends Operation>(response:Awaited<ReturnType<typeof command>>):OperationResults[O]{assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.ok,true);if(!response.body.ok)throw new Error('No data');return response.body.data as OperationResults[O];}
function code(response:Awaited<ReturnType<typeof command>>){return response.body.ok?undefined:response.body.error.code;}
async function calls(){return (await command({action:'stats'})).body.calls!;}
async function upload(parentKind='ticket',fileName='fixture.png'){return data<'attachments.upload'>(await write('attachments.upload',{parentKind,...(parentKind==='ticket'?{}:{groupId:GROUP}),file:{...png,fileName}})).attachment;}
async function waitForCall(operation:string){for(let i=0;i<100;i++){if((await calls()).some(item=>item.operation===operation))return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Synthetic request did not start');}

test('delayed preflight renews the claim, deduplicates five parent reads and permits only one same-key write',async()=>{
  const attachments=[];for(let i=0;i<5;i++)attachments.push(await upload('ticket',`photo-${i}.png`));
  const before=(await calls()).length;
  await command({action:'control',control:{delays:{'profile.get':350,'tickets.create':150}}});
  const key=crypto.randomUUID(),payload={title:'One ticket',description:'Five bounded files',attachmentIds:attachments.map(item=>item.id)},options={requestBudgetMs:2000,claimLeaseMs:200,heartbeatMs:40};
  const pending=write('tickets.create',payload,key,{options});
  await new Promise(resolve=>setTimeout(resolve,260));
  const duplicate=await write('tickets.create',payload,key,{options});assert.equal(code(duplicate),'REQUEST_IN_PROGRESS');
  const saved=data<'tickets.create'>(await pending);assert.equal(saved.ticket.attachments.length,5);
  const emitted=(await calls()).slice(before);assert.equal(emitted.filter(item=>item.operation==='profile.get').length,1);assert.equal(emitted.filter(item=>item.operation==='tickets.create').length,1);
  assert.equal(data<'tickets.get'>(await read('tickets.get',{ticketId:saved.ticket.id})).ticket.id,saved.ticket.id);
});

test('the total preflight budget stops before write dispatch and safely retries the same key',async()=>{
  const file=await upload();await command({action:'control',control:{delays:{'profile.get':500}}});
  const key=crypto.randomUUID(),payload={title:'Budget test',description:'No dispatch on exhausted preflight',attachmentIds:[file.id]},options={requestBudgetMs:120,claimLeaseMs:200,heartbeatMs:40};
  const failed=await write('tickets.create',payload,key,{options});assert.equal(code(failed),'UPSTREAM_UNAVAILABLE');
  assert.equal((await calls()).filter(item=>item.operation==='tickets.create').length,0);
  const row=await database.prepare('SELECT state,request_id FROM mentor_requests WHERE idempotency_key=?').bind(key).first<{state:string;request_id:string}>();assert.equal(row?.state,'preflight_retry');
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(key).run();await command({action:'control',control:{}});
  const saved=await write('tickets.create',payload,key);data<'tickets.create'>(saved);assert.equal(saved.body.requestId,row?.request_id);assert.equal((await calls()).filter(item=>item.operation==='tickets.create').length,1);
});

test('post-dispatch timeout remains uncertain with no automatic business replay',async()=>{
  await command({action:'control',control:{delays:{'tickets.create':500}}});
  const key=crypto.randomUUID(),payload={title:'Uncertain request',description:'Retain the request reference'};
  const failed=await write('tickets.create',payload,key,{options:{requestBudgetMs:100,claimLeaseMs:200,heartbeatMs:40}});assert.equal(code(failed),'PARTIAL_WRITE');
  const repeated=await write('tickets.create',payload,key);assert.equal(code(repeated),'PARTIAL_WRITE');assert.equal(repeated.body.requestId,failed.body.requestId);
  assert.equal(code(await write('tickets.create',payload)),'PARTIAL_WRITE','A lost browser key cannot duplicate an uncertain creation.');
  assert.equal((await calls()).filter(item=>item.operation==='tickets.create').length,1);
});

test('successful replay repairs omitted cache confirmation without repeating the business write',async()=>{
  const key=crypto.randomUUID(),payload={title:'Confirmed remotely',description:'Recover cache after interrupted acknowledgement'};
  const initial=await write('tickets.create',payload,key,{cache:false}),ticket=data<'tickets.create'>(initial).ticket;
  assert.equal(code(await read('tickets.get',{ticketId:ticket.id})),'RECORD_NOT_FOUND');
  const before=await database.prepare('SELECT invalidation_version FROM mentor_cache_sync_state WHERE account_id=?').bind(A).first<{invalidation_version:number}>();
  const replay=await write('tickets.create',payload,key);assert.equal(replay.body.ok,true);assert.equal(replay.body.replayed,true);
  assert.equal(data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket.title,payload.title);
  const after=await database.prepare('SELECT invalidation_version FROM mentor_cache_sync_state WHERE account_id=?').bind(A).first<{invalidation_version:number}>();assert.ok(after!.invalidation_version>before!.invalidation_version);
  assert.equal((await calls()).filter(item=>item.operation==='tickets.create').length,1);assert.equal(data<'bootstrap'>(await read('bootstrap')).dataSync?.stale,true);
});

test('confirmed attendance, new report and its receipt are immediately readable without source reads',async()=>{
  const original=data<'groups.get'>(await read('groups.get',{groupId:GROUP}));
  const attendance=data<'attendance.save'>(await write('attendance.save',{groupId:GROUP,expectedVersion:original.group.version,entries:[{menteeId:MENTEE,expectedVersion:original.mentees[0].version,attended:false}]}));
  assert.equal(data<'groups.get'>(await read('groups.get',{groupId:GROUP})).mentees[0].version,attendance.mentees[0].version);
  const photo=await upload('meetupReport');
  const report=data<'reports.meetup.save'>(await write('reports.meetup.save',{groupId:GROUP,title:'Immediate report',meetupDate:'2026-10-03',attendance:1,description:'Known saved values',isUseGC:true,isRequiredSC:false,attachmentIds:[photo.id]})).report;
  assert.equal(data<'reports.get'>(await read('reports.get',{kind:'meetup',reportId:report.id})).report.attachments[0].id,photo.id);
  const receipt=await upload('expense','receipt.png');
  const expense=data<'expenses.save'>(await write('expenses.save',{groupId:GROUP,meetupReportId:report.id,amount:15,attachmentIds:[receipt.id]})).expense;
  const before=(await calls()).length,detail=data<'groups.get'>(await read('groups.get',{groupId:GROUP}));
  assert.equal(detail.expenses.find(item=>item.id===expense.id)?.meetupReportId,report.id);assert.equal(detail.group.meetupCount,1);
  assert.equal((await calls()).length,before,'Cache reads do not dispatch HTTP.');
});

test('cache confirmation is account scoped, preserves source age, and does not roll back a later edit on replay',async()=>{
  const key=crypto.randomUUID(),payload={title:'First version',description:'Synthetic'},first=await write('tickets.create',payload,key),ticket=data<'tickets.create'>(first).ticket;
  const row=await database.prepare("SELECT synced_at,hard_expires_at FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(A).first<{synced_at:number;hard_expires_at:number}>();
  await write('tickets.update',{ticketId:ticket.id,expectedVersion:ticket.version,title:'Later version',description:'Preserve the newer value'});
  await write('tickets.create',payload,key);
  assert.equal(data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket.title,'Later version');
  assert.equal(code(await read('tickets.get',{ticketId:ticket.id},{account:B,actor:2})),'RECORD_NOT_FOUND');
  const after=await database.prepare("SELECT synced_at,hard_expires_at FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(A).first();assert.deepEqual(after,row);
  await database.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").bind(A).run();assert.equal(code(await read('tickets.get',{ticketId:ticket.id})),'MENTOR_FORBIDDEN');
});

test('cache confirmation cannot introduce another parent or account profile into a snapshot',async()=>{
  const original=data<'profile.get'>(await read('profile.get'));
  const response={schemaVersion:'1.0',requestId:crypto.randomUUID(),ok:true,data:{profile:{...original.profile,id:'2',country:'Wrong account'}}};
  const result=await command({action:'confirm',request:{operation:'profile.update',idempotencyKey:crypto.randomUUID(),payload:{expectedVersion:original.profile.version,country:'Australia',phoneNumber:'0412345678',communicationChannels:[],programs:[],stream:'',otherStream:'',under18:false,wwcc:'WWC12345E',wwccExpiryDate:'2029-01-01'}},response,options:{completedAt:Date.now()}});
  assert.equal(code(result),'OWNERSHIP_DENIED');assert.equal(data<'profile.get'>(await read('profile.get')).profile.country,original.profile.country);
});

test('different request keys cannot concurrently attach to the same parent and confirmation updates parent metadata',async()=>{
  const ticket=data<'tickets.create'>(await write('tickets.create',{title:'Parent lock',description:'One parent'})).ticket;
  await command({action:'control',control:{delays:{'attachments.upload':350}}});
  const payload={parentKind:'ticket',parentId:ticket.id,expectedVersion:ticket.version,file:png};
  const first=write('attachments.upload',payload,crypto.randomUUID(),{options:{requestBudgetMs:2000,claimLeaseMs:200,heartbeatMs:40}});
  await waitForCall('attachments.upload');
  const second=await write('attachments.upload',{...payload,file:{...png,fileName:'another.png'}});assert.equal(code(second),'REQUEST_IN_PROGRESS');
  const saved=data<'attachments.upload'>(await first),cached=data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket;
  assert.equal(cached.version,saved.parentVersion);assert.equal(cached.attachments[0].id,saved.attachment.id);
  assert.equal((await calls()).filter(item=>item.operation==='attachments.upload').length,1);
  await command({action:'control',control:{}});
  const deleted=data<'attachments.delete'>(await write('attachments.delete',{parentKind:'ticket',parentId:ticket.id,expectedVersion:cached.version,attachmentId:saved.attachment.id}));
  const empty=data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket;assert.equal(empty.attachments.length,0);assert.equal(empty.version,deleted.parentVersion);
  const locks=await database.prepare('SELECT count(*) AS n FROM mentor_resource_locks').first<{n:number}>();assert.equal(locks?.n,0);
});

test('shared Group counters serialize across two authorized portal accounts',async()=>{
  const original=data<'groups.get'>(await read('groups.get',{groupId:GROUP}));
  await command({action:'control',control:{delays:{'attendance.save':350}}});
  const payload={groupId:GROUP,expectedVersion:original.group.version,entries:[{menteeId:MENTEE,expectedVersion:original.mentees[0].version,attended:false}]};
  const first=write('attendance.save',payload);await waitForCall('attendance.save');
  const second=await write('attendance.save',payload,crypto.randomUUID(),{account:B,actor:2});assert.equal(code(second),'REQUEST_IN_PROGRESS');
  data<'attendance.save'>(await first);assert.equal((await calls()).filter(item=>item.operation==='attendance.save').length,1);
});

test('uncertain parent locks never expire into an automatic different-key retry',async()=>{
  const ticket=data<'tickets.create'>(await write('tickets.create',{title:'Uncertain parent',description:'Hold for reconciliation'})).ticket;
  await command({action:'control',control:{delays:{'tickets.update':500}}});
  const payload={ticketId:ticket.id,expectedVersion:ticket.version,title:'Unknown change',description:'No automatic replay'};
  const failed=await write('tickets.update',payload,crypto.randomUUID(),{options:{requestBudgetMs:100,claimLeaseMs:200,heartbeatMs:40}});assert.equal(code(failed),'PARTIAL_WRITE');
  const lock=await database.prepare('SELECT state FROM mentor_resource_locks WHERE resource_key=?').bind(`ticket:${ticket.id}`).first<{state:string}>();assert.equal(lock?.state,'uncertain');
  await database.prepare('UPDATE mentor_resource_locks SET lease_expires_at=0').run();await command({action:'control',control:{}});
  assert.equal(code(await write('tickets.update',payload)),'PARTIAL_WRITE');assert.equal((await calls()).filter(item=>item.operation==='tickets.update').length,1);
});

test('a crashed pre-dispatch parent lease can recover but a dispatched lease cannot',async()=>{
  const ticket=data<'tickets.create'>(await write('tickets.create',{title:'Lease recovery',description:'Synthetic crash'})).ticket;
  const key=`ticket:${ticket.id}`;
  await database.prepare("INSERT INTO mentor_resource_locks (resource_key,request_id,owner_account_id,lease_token,lease_expires_at,state,updated_at) VALUES (?,?,?,?,0,'pending',0)").bind(key,crypto.randomUUID(),A,crypto.randomUUID()).run();
  const saved=data<'tickets.update'>(await write('tickets.update',{ticketId:ticket.id,expectedVersion:ticket.version,title:'Recovered',description:'Pending lease recovered'})).ticket;
  await database.prepare("INSERT INTO mentor_resource_locks (resource_key,request_id,owner_account_id,lease_token,lease_expires_at,state,updated_at) VALUES (?,?,?,?,0,'dispatched',0)").bind(key,crypto.randomUUID(),A,crypto.randomUUID()).run();
  assert.equal(code(await write('tickets.update',{ticketId:ticket.id,expectedVersion:saved.version,title:'Must stop',description:'Unknown prior business write'})),'PARTIAL_WRITE');
  assert.equal((await calls()).filter(item=>item.operation==='tickets.update').length,1);
});

test('explicit upstream pending attachment status can replay after the source ETag and file membership changed',async()=>{
  const ticket=data<'tickets.create'>(await write('tickets.create',{title:'Pending file result',description:'Same native ledger request'})).ticket;
  await command({action:'control',control:{pendingOnceOperation:'attachments.upload'}});
  const key=crypto.randomUUID(),payload={parentKind:'ticket',parentId:ticket.id,expectedVersion:ticket.version,file:png};
  const pending=await write('attachments.upload',payload,key);assert.equal(code(pending),'REQUEST_IN_PROGRESS');
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(key).run();
  await command({action:'control',control:{delays:{'tickets.get':500}}});
  assert.equal(code(await write('attachments.upload',payload,key,{options:{requestBudgetMs:100,claimLeaseMs:200,heartbeatMs:40}})),'UPSTREAM_UNAVAILABLE');
  const held=await database.prepare('SELECT state FROM mentor_resource_locks WHERE resource_key=?').bind(`ticket:${ticket.id}`).first<{state:string}>();assert.equal(held?.state,'dispatched');
  const retry=await database.prepare('SELECT state FROM mentor_requests WHERE idempotency_key=?').bind(key).first<{state:string}>();assert.equal(retry?.state,'upstream_pending');
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(key).run();await command({action:'control',control:{}});
  const uploaded=data<'attachments.upload'>(await write('attachments.upload',payload,key));assert.equal(uploaded.parentVersion,'2');
  const parent=data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket;assert.equal(parent.attachments.length,1);
  await command({action:'control',control:{pendingOnceOperation:'attachments.delete'}});
  const deleteKey=crypto.randomUUID(),deletion={parentKind:'ticket',parentId:ticket.id,expectedVersion:parent.version,attachmentId:uploaded.attachment.id};
  assert.equal(code(await write('attachments.delete',deletion,deleteKey)),'REQUEST_IN_PROGRESS');
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(deleteKey).run();
  data<'attachments.delete'>(await write('attachments.delete',deletion,deleteKey));assert.equal(data<'tickets.get'>(await read('tickets.get',{ticketId:ticket.id})).ticket.attachments.length,0);
});

test('concurrent independent confirmations merge atomically and fence an older full snapshot publication',async()=>{
  const first=data<'tickets.create'>(await write('tickets.create',{title:'First initial ticket',description:'Keep both'})).ticket;
  const second=data<'tickets.create'>(await write('tickets.create',{title:'Second initial ticket',description:'Keep both'})).ticket;
  await command({action:'hold-sync'});
  const [a,b]=await Promise.all([write('tickets.update',{ticketId:first.id,expectedVersion:first.version,title:'First updated ticket',description:'Keep both'}),write('tickets.update',{ticketId:second.id,expectedVersion:second.version,title:'Second updated ticket',description:'Keep both'})]);
  data<'tickets.update'>(a);data<'tickets.update'>(b);assert.equal((await command({action:'publish-old-sync'})).body.ok,false);
  const list=data<'tickets.list'>(await read('tickets.list')).items;assert.deepEqual(new Set(list.map(item=>item.title)),new Set(['First updated ticket','Second updated ticket']));
});

test('profile confirmation is immediate while redemption acknowledgement never invents balance or approval',async()=>{
  const original=data<'profile.get'>(await read('profile.get'));
  const profile=data<'profile.update'>(await write('profile.update',{expectedVersion:original.profile.version,country:'Canada',phoneNumber:'0412345678',communicationChannels:[],programs:[],stream:'',otherStream:'',under18:false,wwcc:'WWC12345E',wwccExpiryDate:'2029-01-01'})).profile;
  const cached=data<'profile.get'>(await read('profile.get'));assert.equal(cached.profile.country,'Canada');assert.equal(cached.profile.version,profile.version);assert.deepEqual(cached.choices,original.choices);
  const redemption=data<'redemptions.create'>(await write('redemptions.create',{rewardId:'44',optionIds:[],comment:'Pending approval',expectedPoints:40})).redemption;
  assert.equal(data<'redemptions.list'>(await read('redemptions.list')).items[0].id,redemption.id);assert.equal(redemption.status,'pending');assert.equal(redemption.creditState,'not_debited');assert.equal(data<'balance.get'>(await read('balance.get')).balance,100);
});

test('source version order wins when acknowledgement completion times arrive out of order',async()=>{
  const original=data<'profile.get'>(await read('profile.get'));
  const payload={expectedVersion:original.profile.version,country:'Canada',phoneNumber:'0412345678',communicationChannels:[],programs:[],stream:'',otherStream:'',under18:false,wwcc:'WWC12345E',wwccExpiryDate:'2029-01-01'};
  const saved=data<'profile.update'>(await write('profile.update',payload)).profile;
  const next={...saved,version:String(Number(saved.version)+1),country:'New Zealand'};
  const result=await command({action:'confirm',request:{operation:'profile.update',payload:{...payload,expectedVersion:saved.version},idempotencyKey:crypto.randomUUID()},response:{schemaVersion:'1.0',requestId:crypto.randomUUID(),ok:true,data:{profile:next}},options:{completedAt:Date.now()-1000}});
  assert.equal(result.body.ok,true);assert.equal(data<'profile.get'>(await read('profile.get')).profile.country,'New Zealand');
});

test('a lost browser key cannot create another uncertain redemption intent',async()=>{
  await command({action:'control',control:{transportOperation:'redemptions.create'}});
  const payload={rewardId:'44',optionIds:[],comment:'Pending only',expectedPoints:40};
  assert.equal(code(await write('redemptions.create',payload)),'PARTIAL_WRITE');
  await command({action:'control',control:{}});
  assert.equal(code(await write('redemptions.create',payload)),'PARTIAL_WRITE');
  assert.equal((await calls()).filter(item=>item.operation==='redemptions.create').length,1);
});

test('leading-zero source IDs cannot create alternate Group or parent locks',async()=>{
  const original=data<'groups.get'>(await read('groups.get',{groupId:GROUP}));
  assert.equal(code(await write('attendance.save',{groupId:'0'+GROUP,expectedVersion:original.group.version,entries:[{menteeId:MENTEE,expectedVersion:original.mentees[0].version,attended:false}]})),'VALIDATION_ERROR');
  const locks=await database.prepare('SELECT count(*) AS n FROM mentor_resource_locks').first<{n:number}>();assert.equal(locks?.n,0);assert.equal((await calls()).length,0);
});

test('the default write transport accepts one valid response beyond the former 20-second deadline',async()=>{
  await command({action:'control',control:{delays:{'tickets.create':21000}}});
  data<'tickets.create'>(await write('tickets.create',{title:'Slow verified response',description:'21 second synthetic adapter'}));
  assert.equal((await calls()).filter(item=>item.operation==='tickets.create').length,1);
});

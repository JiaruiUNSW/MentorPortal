import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { Operation, OperationResults } from '../lib/contracts';

let runtime:Miniflare;
let database:Awaited<ReturnType<Miniflare['getD1Database']>>;
before(async()=>{
  const bundle=await build({stdin:{contents:`
    import { executeMentor } from './lib/mentor-data/service';
    import { parseClientRequest, parseUpload } from './lib/mentor-data/validation';
    import { claimRequest } from './lib/mentor-data/store';
    import { ownFile, projectLiveAttachments, validateDemoFile } from './lib/mentor-data/files';
    import { loadDemo } from './lib/mentor-data/store';
    import { callFlow, normalizeLivePayload, sourceId } from './lib/flow-bridge';
    import { errorEnvelope,safeError } from './lib/mentor-data/errors';
    import { validateFlowData } from './lib/mentor-data/response-validation';
    const liveWriteCounts=new Map();
    export default {async fetch(request,env){
      const [_,mode,account,action]=new URL(request.url).pathname.split('/');
      const principal={accountId:account,email:account+'@example.test',displayName:'Preview Mentor '+account,mentorUserId:request.headers.get('x-admin')?0:1,role:request.headers.get('x-admin')?'admin':'mentor',mode};
      const bindings={...env,PORTAL_MODE:mode};
      const requestId=crypto.randomUUID();
      const nativeFetch=globalThis.fetch;
      try {
        const value=await request.json();
        if(action==='flow-fixture') {
          const data=validateFlowData(value.operation,value.response.data);
          if(value.operation==='attachments.download' && parseUpload(data,255).byteLength!==data.sizeBytes)throw new Error('Generated download fixture size mismatch');
          return Response.json({data:await projectLiveAttachments(bindings,{...principal,mode:'live'},data,requestId)});
        }
        if(action.startsWith('mock-')) {
          Object.assign(bindings,{MENTOR_BRIDGE_KEY:'test-only-bridge-key-with-at-least-32-characters',MENTOR_READ_URL:'https://test.logic.azure.com/read',MENTOR_TICKET_URL:'https://test.logic.azure.com/ticket',MENTOR_ATTACHMENT_URL:'https://test.logic.azure.com/file'});
          globalThis.fetch=async(url,init)=>{
            const sent=JSON.parse(init.body),p=sent.payload,base={schemaVersion:'1.0',requestId:sent.requestId};
            if(action==='mock-transport')throw new Error('private upstream transport details');
            if(action==='mock-deny' && ['tickets.get','reports.get','groups.get'].includes(sent.operation))return Response.json({...base,ok:false,error:{code:'OWNERSHIP_DENIED',message:'Private upstream text',retryable:false}},{status:403});
            const ticket={id:77,version:'1',title:'Live fixture ticket',description:'Mock adapter test only',status:'Open',staffName:'',staffComment:'',createdAt:'2026-09-30T00:00:00Z',modifiedAt:'2026-09-30T00:00:00Z',attachments:[]};
            if(sent.operation==='tickets.create') {
              const count=liveWriteCounts.get(account)||0;liveWriteCounts.set(account,count+1);
              if(action==='mock-pending' && count===0)return Response.json({...base,ok:false,error:{code:'REQUEST_IN_PROGRESS',message:'Still processing',retryable:true}},{status:409});
              return Response.json({...base,ok:true,data:{ticket}});
            }
            if(sent.operation==='tickets.get')return Response.json({...base,ok:true,data:{ticket}});
            if(sent.operation==='attachments.upload')return Response.json({...base,ok:true,data:{attachment:{id:'upstream-attachment',fileName:p.file.fileName,mimeType:p.file.mimeType,sizeBytes:16,parentKind:p.parentKind,parentId:p.parentId},parentVersion:'2'}});
            return Response.json({...base,ok:true,data:{profile:{id:1,version:'1',displayName:'Live fixture',preferredName:'Live',communicationEmail:'live@example.test',country:'Australia',phoneNumber:'+61 400 000 000',communicationChannels:[],programs:[],stream:'',otherStream:'',wwcc:'',wwccExpiryDate:null,dateOfBirth:null},choices:{communicationChannels:[],programs:[],streams:[]}}});
          };
        }
        if(action==='bridge'){
          let calls=0,captured; const req=parseClientRequest(value.request);
          const result=await callFlow({...bindings,PORTAL_MODE:value.demo?'demo':'live',MENTOR_BRIDGE_KEY:'test-only-bridge-key-with-at-least-32-characters',MENTOR_READ_URL:'https://test.logic.azure.com/workflow',MENTOR_TICKET_URL:'https://test.logic.azure.com/workflow',MENTOR_ATTACHMENT_URL:'https://test.logic.azure.com/workflow'}, {...principal,mode:'live'},req,requestId,value.resolved,async(url,init)=>{
            calls++;captured={body:JSON.parse(init.body),headers:init.headers};
            if(value.transportFailure)throw new Error('secret URL or backend error');
            return Response.json({schemaVersion:'1.0',requestId,ok:true,data:value.response});
          });
          if(value.project && result.ok)result.data=await projectLiveAttachments(bindings,{...principal,mode:'live'},result.data,requestId);
          return Response.json({result,calls,captured});
        }
        if(action==='normalize')return Response.json(normalizeLivePayload(parseClientRequest(value)));
        const parsed=parseClientRequest(value);
        if(action==='claim'){const c=await claimRequest(env.DB,principal,parsed,requestId);return Response.json({requestId:c.row.request_id});}
        if(action==='file'){const f=await ownFile(env.DB,principal,value.payload.attachmentId);validateDemoFile((await loadDemo(env.DB,principal)).state,f);const o=await env.BUCKET.get(f.object_key);return new Response(o.body);}
        const result=await executeMentor(bindings,principal,parsed,requestId);return Response.json(result);
      }catch(error){const safe=safeError(error);return Response.json(errorEnvelope(requestId,safe),{status:safe.status});}finally{globalThis.fetch=nativeFetch;}
    }};`,resolveDir:process.cwd(),loader:'ts',sourcefile:'mentor-test-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-22',d1Databases:['DB'],r2Buckets:['BUCKET']});
  database=await runtime.getD1Database('DB');
  for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile(`drizzle/${file}`,'utf8')).split('--> statement-breakpoint').map(v=>v.trim()).filter(Boolean))await database.prepare(sql).run();
});
after(async()=>{await runtime?.dispose();});
beforeEach(async()=>{await database.batch(['mentor_demo_state','mentor_requests','mentor_files','mentor_audit'].map(t=>database.prepare(`DELETE FROM ${t}`)));});
// Test-only actors are set by the harness; production obtains them exclusively from requireSession.
async function request<O extends Operation>(account:string,operation:O,payload:unknown={},key?:string,mode='demo',action='run'){
  const response=await runtime.dispatchFetch(`https://test.invalid/${mode}/${account}/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,payload,...(key?{idempotencyKey:key}:{})})});
  return {status:response.status,body:await response.json() as {ok:boolean;data:OperationResults[O];error?:{code:string;message:string;retryable:boolean};replayed?:boolean;requestId:string}};
}
const uuid=()=>crypto.randomUUID();
async function seed(account='a'){return (await request(account,'bootstrap')).body.data;}
const png={fileName:'preview.png',mimeType:'image/png',contentBase64:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,69,78,68]).toString('base64')};
async function upload(account:string,groupId:string,kind='meetupReport'){
  const result=await request(account,'attachments.upload',{parentKind:kind,groupId,file:png},uuid());assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data.attachment;
}

test('synthetic seed persists per account with required three groups and Cedar tasks',async()=>{
  const a=await seed(),again=await seed(),b=await seed('b');
  assert.equal(a.mode,'demo');assert.match(a.previewLabel ?? '',/Synthetic/);
  assert.deepEqual(a.groups.map((g)=>[g.title,g.type,g.menteeCount]),[['Group Cedar','Diploma',4],['Group Banksia','Foundation',3],['Group Wattle','Diploma',5]]);
  assert.equal(a.groups[0].id,again.groups[0].id);assert.notEqual(a.groups[0].id,b.groups[0].id);
  const detail=(await request('a','groups.get',{groupId:a.groups[0].id})).body.data;
  assert.deepEqual(detail.mentees.map((m)=>[m.firstName,m.lastName,m.attended,m.attendanceRecorded]),[['Jamie','Lee',true,true],['Sam','Rivera',true,true],['Taylor','Chen',false,false],['Casey','Green',false,false]]);
  assert.deepEqual(detail.tasks.filter((t)=>['report.week1','report.meetup1','report.completion'].includes(t.key)).map((t)=>t.submissionState),['submitted','draft','not_started']);
});

test('cross-account group, report, ticket and staged-file references are denied',async()=>{
  const a=await seed(),groupId=a.groups[0].id;await seed('b');
  assert.equal((await request('b','groups.get',{groupId})).status,404);
  const detail=(await request('a','groups.get',{groupId})).body.data;
  assert.equal((await request('b','reports.get',{kind:'week1',reportId:detail.reports[0].id})).status,404);
  const ticket=(await request('a','tickets.create',{title:'Preview issue',description:'A test issue.'},uuid())).body.data.ticket;
  assert.equal((await request('b','tickets.get',{ticketId:ticket.id})).status,404);
  const file=await upload('a',groupId);
  assert.equal((await request('b','attachments.download',{parentKind:'meetupReport',groupId,attachmentId:file.id})).status,404);
});

test('attendance validates group membership, preserves state and rejects stale versions',async()=>{
  const a=await seed(),groupId=a.groups[0].id;
  const detail=(await request('a','groups.get',{groupId})).body.data;
  const other=(await request('a','groups.get',{groupId:a.groups[1].id})).body.data;
  assert.equal((await request('a','attendance.save',{groupId,expectedVersion:detail.group.version,entries:[{menteeId:other.mentees[0].id,attended:true,expectedVersion:'1'}]},uuid())).status,403);
  const payload={groupId,expectedVersion:detail.group.version,entries:[{menteeId:detail.mentees[2].id,attended:true,expectedVersion:'1'}]};
  assert.equal((await request('a','attendance.save',payload,uuid())).status,200);
  assert.equal((await request('a','groups.get',{groupId})).body.data.group.attendedCount,3);
  assert.equal((await request('a','attendance.save',payload,uuid())).body.error?.code,'VERSION_CONFLICT');
});

test('invalid dates, amounts, enum/identity fields and missing receipt are rejected before mutation',async()=>{
  const a=await seed(),groupId=a.groups[0].id;
  for(const amount of [-1,0,1.001,10001])assert.equal((await request('a','expenses.save',{groupId,meetupReportId:'x',amount,attachmentIds:['x']},uuid())).status,400);
  assert.equal((await request('a','expenses.save',{groupId,meetupReportId:'x',amount:2,attachmentIds:[]},uuid())).status,400);
  assert.equal((await request('a','reports.meetup.save',{groupId,title:'Test',meetupDate:'2026-02-30',attendance:2,description:'Test',isUseGC:false,isRequiredSC:false},uuid())).status,400);
  assert.equal((await request('a','groups.get',{groupId,userId:99})).status,400);
  const forged=await runtime.dispatchFetch('https://test.invalid/demo/a/run',{method:'POST',body:JSON.stringify({operation:'bootstrap',payload:{},actor:{userId:2}})});assert.equal(forged.status,400);
  const profile=(await request('a','profile.get')).body.data.profile;
  assert.equal((await request('a','profile.update',{...profile,expectedVersion:profile.version,under18:false,email:'other@example.test'},uuid())).status,400);
});

test('R2 staged photo persists, binds on final submission and cannot be reused by another group',async()=>{
  const a=await seed(),groupId=a.groups[0].id;
  const detail=(await request('a','groups.get',{groupId})).body.data,draft=detail.reports.find((r)=>r.kind==='meetup');
  assert.ok(draft);
  const payload={groupId,reportId:draft.id,expectedVersion:draft.version,title:'Test meet-up',meetupDate:'2026-09-20',attendance:2,description:'We met to plan revision.',isUseGC:false,isRequiredSC:false};
  assert.equal((await request('a','reports.meetup.save',payload,uuid())).body.error?.code,'ATTACHMENT_REJECTED');
  const file=await upload('a',groupId);
  const saved=await request('a','reports.meetup.save',{...payload,attachmentIds:[file.id]},uuid());assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.report.submissionState,'submitted');
  const dbFile=await database.prepare('SELECT parent_id,state FROM mentor_files WHERE id=?').bind(file.id).first<{parent_id:string;state:string}>();assert.equal(dbFile?.parent_id,draft.id);assert.equal(dbFile?.state,'attached');
  const downloaded=await request('a','attachments.download',{parentKind:'meetupReport',parentId:draft.id,groupId,attachmentId:file.id});assert.match(downloaded.body.data.downloadUrl,/^\/api\/files\/file_/);
  assert.equal((await request('a','reports.meetup.save',{...payload,groupId:a.groups[1].id,reportId:undefined,expectedVersion:undefined,attachmentIds:[file.id]},uuid())).status,403);
  const object=await (await runtime.getR2Bucket('BUCKET')).get(`demo/a/${file.id}`);assert.deepEqual(Buffer.from(await object!.arrayBuffer()),Buffer.from(png.contentBase64,'base64'));
  assert.equal((await request('a','attachments.delete',{parentKind:'meetupReport',parentId:draft.id,groupId,expectedVersion:saved.body.data.report.version,attachmentId:file.id},uuid())).status,409);
});

test('upload validates byte signature, extensions and HEIC/HEIF ftyp brands',async()=>{
  const a=await seed(),groupId=a.groups[0].id;
  for(const file of [{...png,fileName:'payload.html'},{...png,contentBase64:Buffer.from('not an image').toString('base64')},{...png,fileName:'../x.png'},{...png,mimeType:'text/html'}])assert.equal((await request('a','attachments.upload',{parentKind:'meetupReport',groupId,file},uuid())).status,400);
  const heic=Buffer.alloc(24);heic.writeUInt32BE(24);heic.write('ftyp',4);heic.write('heic',8);heic.write('mif1',16);heic.write('heic',20);
  assert.equal((await request('a','attachments.upload',{parentKind:'meetupReport',groupId,file:{fileName:'phone.heic',mimeType:'image/heic',contentBase64:heic.toString('base64')}},uuid())).status,200);
  heic.write('mp42',8);assert.equal((await request('a','attachments.upload',{parentKind:'meetupReport',groupId,file:{fileName:'phone.heic',mimeType:'image/heic',contentBase64:heic.toString('base64')}},uuid())).status,400);
});

test('concurrent redemption retries reserve credit once and return pending with one successful audit',async()=>{
  await seed();const reward=(await request('a','rewards.list')).body.data.items[0],key=uuid(),payload={rewardId:reward.id,optionIds:[],comment:'Preview test'};
  const results=await Promise.all([request('a','redemptions.create',payload,key),request('a','redemptions.create',payload,key)]);
  assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));
  const replay=await request('a','redemptions.create',payload,key);assert.equal(replay.body.replayed,true);assert.equal(replay.body.data.redemption.status,'pending');assert.equal(replay.body.data.redemption.creditState,'reserved');
  const balance=(await request('a','balance.get')).body.data;assert.equal(balance.balance,180-reward.effectivePoints);assert.equal(balance.reserved,reward.effectivePoints);
  assert.equal((await request('a','redemptions.list')).body.data.items.length,1);
  assert.equal((await database.prepare('SELECT count(*) AS n FROM mentor_audit WHERE operation=\'redemptions.create\' AND outcome=\'succeeded\'').first<{n:number}>())?.n,1);
  assert.equal((await request('a','redemptions.create',{...payload,comment:'changed'},key)).body.error?.code,'IDEMPOTENCY_CONFLICT');
});

test('expired demo lease is resumed safely without creating a second intent',async()=>{
  await seed();const key=uuid(),payload={title:'Recovered ticket',description:'Same intended write'};
  const claim=await request('a','tickets.create',payload,key,'demo','claim');
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(key).run();
  const saved=await request('a','tickets.create',payload,key);assert.equal(saved.status,200);assert.equal(saved.body.requestId,claim.body.requestId);
  assert.equal((await request('a','tickets.list')).body.data.items.length,1);
  assert.equal((await request('a','tickets.create',payload,key)).body.replayed,true);
});

test('staged file deletion is idempotent and removes R2 bytes',async()=>{
  const a=await seed(),groupId=a.groups[0].id,file=await upload('a',groupId),key=uuid(),payload={parentKind:'meetupReport',groupId,attachmentId:file.id};
  assert.equal((await request('a','attachments.delete',payload,key)).status,200);
  assert.equal((await request('a','attachments.delete',payload,key)).body.replayed,true);
  assert.equal(await (await runtime.getR2Bucket('BUCKET')).get(`demo/a/${file.id}`),null);
  assert.equal((await request('a','attachments.download',payload)).status,404);
});

test('demo/live isolation, unconfigured live endpoints and admin denial fail closed',async()=>{
  assert.equal((await request('a','bootstrap',{},undefined,'live')).body.error?.code,'DRAFT_NOT_CONFIGURED');
  assert.equal((await request('a','tickets.create',{title:'test',description:'test'},uuid(),'live')).body.error?.code,'DRAFT_NOT_CONFIGURED');
  const response=await runtime.dispatchFetch('https://test.invalid/demo/admin/run',{method:'POST',headers:{'x-admin':'1'},body:JSON.stringify({operation:'bootstrap',payload:{}})});assert.equal(response.status,403);
  const bridge=await runtime.dispatchFetch('https://test.invalid/live/a/bridge',{method:'POST',body:JSON.stringify({demo:true,request:{operation:'balance.get',payload:{}},response:{}})});assert.equal(bridge.status,403);
  const count=await database.prepare('SELECT count(*) AS n FROM mentor_demo_state').first<{n:number}>();assert.equal(count?.n,0);
});

test('live bridge strictly normalizes numeric IDs, drops response extras, and never leaks transport secrets',async()=>{
  assert.equal((await request('a','groups.get',{groupId:'demo_123'},undefined,'live','normalize')).status,400);
  assert.equal((await request('a','groups.get',{groupId:'01'},undefined,'live','normalize')).status,400);
  const valid=await request('a','groups.get',{groupId:'42'},undefined,'live','normalize');assert.equal((valid.body as unknown as {groupId:number}).groupId,42);
  const read=await runtime.dispatchFetch('https://test.invalid/live/a/bridge',{method:'POST',body:JSON.stringify({request:{operation:'balance.get',payload:{}},response:{balance:5,totalCredit:10,roundCount:1,milestone:20,milestoneRound:3,secret:'never send'}})});
  const body=await read.json() as {calls:number;result:{data:Record<string,unknown>;requestId:string};captured:{body:{actor:{userId:number}};headers:Record<string,string>}};assert.equal(read.status,200);assert.equal(body.calls,1);assert.equal(body.result.data.secret,undefined);assert.equal(body.captured.body.actor.userId,1);assert.equal(body.captured.headers['X-Mentor-Request-Id'],body.result.requestId);
  const write=await runtime.dispatchFetch('https://test.invalid/live/a/bridge',{method:'POST',body:JSON.stringify({transportFailure:true,request:{operation:'tickets.create',payload:{title:'Test',description:'A test'},idempotencyKey:uuid()}})});
  const failed=await write.json() as {error:{code:string;retryable:boolean}};assert.equal(failed.error.code,'PARTIAL_WRITE');assert.equal(failed.error.retryable,false);assert.doesNotMatch(JSON.stringify(failed),/secret URL|backend error|server-secret/);
});

test('source-mapped profile updates preserve identity, and Closed tickets reject edits',async()=>{
  await seed();const original=(await request('a','profile.get')).body.data.profile;
  const payload={expectedVersion:original.version,country:'Australia',phoneNumber:'+61 400 111 222',communicationChannels:['Email'],programs:['Diploma'],stream:'Science',otherStream:'',under18:false,wwcc:'PREVIEW-NEW',wwccExpiryDate:'2029-06-30'};
  const saved=await request('a','profile.update',payload,uuid());assert.equal(saved.status,200);assert.equal(saved.body.data.profile.communicationEmail,original.communicationEmail);assert.equal(saved.body.data.profile.displayName,original.displayName);assert.equal(saved.body.data.profile.wwccExpiryDate,'2029-06-30');
  assert.equal((await request('a','profile.update',payload,uuid())).body.error?.code,'VERSION_CONFLICT');
  const ticket=(await request('a','tickets.create',{title:'Test issue',description:'Please check this preview issue.'},uuid())).body.data.ticket;
  const row=await database.prepare('SELECT state_json FROM mentor_demo_state WHERE account_id=?').bind('a').first<{state_json:string}>();assert.ok(row);
  const state=JSON.parse(row.state_json) as {tickets:{id:string;status:string}[]};state.tickets.find(t=>t.id===ticket.id)!.status='Closed';
  await database.prepare('UPDATE mentor_demo_state SET state_json=? WHERE account_id=?').bind(JSON.stringify(state),'a').run();
  assert.equal((await request('a','tickets.update',{ticketId:ticket.id,expectedVersion:ticket.version,title:'Changed',description:'Changed'},uuid())).body.error?.code,'EDIT_NOT_ALLOWED');
});

test('expense receipt persists with amount precision and group/report ownership',async()=>{
  const a=await seed(),groupId=a.groups[0].id,detail=(await request('a','groups.get',{groupId})).body.data,report=detail.reports.find(r=>r.kind==='meetup');assert.ok(report);
  const receipt=await upload('a',groupId,'expense');
  const saved=await request('a','expenses.save',{groupId,meetupReportId:report.id,amount:18.45,attachmentIds:[receipt.id]},uuid());assert.equal(saved.status,200);assert.equal(saved.body.data.expense.amount,18.45);assert.equal(saved.body.data.expense.processingStatus,'not_requested');
  const refreshed=(await request('a','groups.get',{groupId})).body.data;assert.equal(refreshed.expenses[0].attachments[0].id,receipt.id);
  assert.equal((await request('a','expenses.save',{groupId:a.groups[1].id,meetupReportId:report.id,amount:18.45,attachmentIds:[receipt.id]},uuid())).status,403);
});

test('control-character versions, future live draft forwarding and excess mutations are blocked',async()=>{
  const a=await seed(),groupId=a.groups[0].id,detail=(await request('a','groups.get',{groupId})).body.data;
  assert.equal((await request('a','attendance.save',{groupId,expectedVersion:'1\r\nX-Injected: yes',entries:[{menteeId:detail.mentees[0].id,expectedVersion:'1',attended:true}]},uuid())).status,400);
  assert.equal((await request('a','reports.week1.save',{groupId:'42',question:'Test',submit:false},uuid(),'live','normalize')).body.error?.code,'DRAFT_NOT_CONFIGURED');
  for(let i=0;i<30;i++)assert.equal((await request('rate','tickets.create',{title:`Issue ${i}`,description:'A bounded preview write.'},uuid())).status,200);
  const limited=await request('rate','tickets.create',{title:'Over limit',description:'A bounded preview write.'},uuid());assert.equal(limited.status,429);assert.equal(limited.body.error?.code,'RATE_LIMITED');
});

test('explicit upstream pending remains queryable with the same original idempotency request',async()=>{
  const key=uuid(),payload={title:'Pending adapter request',description:'Adapter status check test'};
  const pending=await request('live-pending','tickets.create',payload,key,'live','mock-pending');assert.equal(pending.status,409);assert.equal(pending.body.error?.code,'REQUEST_IN_PROGRESS');
  const row=await database.prepare('SELECT state,request_id FROM mentor_requests WHERE idempotency_key=?').bind(key).first<{state:string;request_id:string}>();assert.equal(row?.state,'upstream_pending');assert.equal(row?.request_id,pending.body.requestId);
  await database.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(key).run();
  const completed=await request('live-pending','tickets.create',payload,key,'live','mock-pending');assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.requestId,pending.body.requestId);assert.equal(completed.body.data.ticket.id,'77');
});

test('cached live ticket creation and file writes revalidate exact current parent ownership',async()=>{
  const key=uuid(),payload={title:'Owned at creation',description:'Replay authorization test'};
  const created=await request('live-replay','tickets.create',payload,key,'live','mock-ok');assert.equal(created.status,200);
  const denied=await request('live-replay','tickets.create',payload,key,'live','mock-deny');assert.equal(denied.status,403);assert.equal(denied.body.error?.code,'OWNERSHIP_DENIED');assert.equal(denied.body.requestId,created.body.requestId);
  const fileKey=uuid(),filePayload={parentKind:'ticket',parentId:'77',expectedVersion:'1',file:png};
  const file=await request('live-file','attachments.upload',filePayload,fileKey,'live','mock-ok');assert.equal(file.status,200,JSON.stringify(file.body));
  const fileDenied=await request('live-file','attachments.upload',filePayload,fileKey,'live','mock-deny');assert.equal(fileDenied.status,403);assert.equal(fileDenied.body.requestId,file.body.requestId);
});

test('uncertain live writes retain the original recovery reference and are never resent',async()=>{
  const key=uuid(),payload={title:'Unknown outcome',description:'Transport ambiguity test'};
  const initial=await request('live-unknown','tickets.create',payload,key,'live','mock-transport');assert.equal(initial.body.error?.code,'PARTIAL_WRITE');assert.equal(initial.body.error?.retryable,false);
  const repeated=await request('live-unknown','tickets.create',payload,key,'live','mock-ok');assert.equal(repeated.body.error?.code,'PARTIAL_WRITE');assert.equal(repeated.body.requestId,initial.body.requestId);
  const count=await database.prepare('SELECT count(*) AS n FROM mentor_audit WHERE account_id=? AND outcome=\'live_dispatch\'').bind('live-unknown').first<{n:number}>();assert.equal(count?.n,1);
});

function attachmentMetadata(value:unknown):Array<{id:string;fileName:string;parentId:number|string}> {
  if(Array.isArray(value))return value.flatMap(attachmentMetadata);
  if(!value || typeof value!=='object')return [];
  const object=value as Record<string,unknown>;
  if(typeof object.id==='string' && typeof object.fileName==='string' && typeof object.parentKind==='string')return [object as {id:string;fileName:string;parentId:number|string}];
  return Object.values(object).flatMap(attachmentMetadata);
}

test('actual generated Flow response fixtures satisfy browser normalization and hide all source attachment handles',async()=>{
  const fixtureDirectory=new URL('./fixtures/',import.meta.url);
  const files=(await readdir(fixtureDirectory)).filter(file=>file.startsWith('flow-contract-') && file.endsWith('.json')).sort();
  assert.ok(files.length>=5,'Generate the Flow-owned response fixtures before this cross-contract check.');
  let historicalName=false,longHandle=false,manyAttachments=false;
  for(const file of files) {
    const fixture=JSON.parse(await readFile(new URL(file,fixtureDirectory),'utf8')) as {operation?:Operation;response?:{ok:boolean;data:unknown};ok?:boolean;data?:unknown};
    const envelope=fixture.response??fixture;
    if(envelope.ok!==true)continue;
    const operation=fixture.operation??file.replace(/^flow-contract-/,'').replace(/(?:\.response)?\.json$/,'') as Operation;
    const response=await runtime.dispatchFetch('https://test.invalid/live/flow-fixtures/flow-fixture',{method:'POST',body:JSON.stringify({operation,response:envelope})});
    const result=await response.json() as {data:unknown;error?:{code:string;message:string}};
    assert.equal(response.status,200,`${file}: ${JSON.stringify(result.error)}`);
    const source=attachmentMetadata(envelope.data),browser=attachmentMetadata(result.data);
    assert.equal(source.length,browser.length,`${file} keeps historical attachment metadata`);
    historicalName ||= source.some(a=>a.fileName.length===255);longHandle ||= source.some(a=>a.id.length>100);manyAttachments ||= source.length>=50;
    for(let i=0;i<source.length;i++) {
      assert.match(browser[i].id,/^file_[a-f0-9]{48}$/);
      assert.notEqual(browser[i].id,source[i].id,`${file} must not expose source attachment handles`);
      assert.equal(browser[i].fileName,source[i].fileName);
    }
  }
  assert.ok(historicalName && longHandle && manyAttachments,'Flow fixtures must include the historical filename, handle and attachment-count boundaries.');
});

test('generated native header contract and binary fixtures agree with validated-file attestation',async()=>{
  const fixtureDirectory=new URL('./fixtures/',import.meta.url);
  const headersSchema=JSON.parse(await readFile(new URL('flow-contract-headers.schema.json',fixtureDirectory),'utf8')) as {required:string[];properties:Record<string,{minLength?:number;maxLength?:number;pattern?:string;const?:string}>};
  const binary=JSON.parse(await readFile(new URL('flow-contract-attachments.download.heic.json',fixtureDirectory),'utf8')) as {response:{data:{fileName:string;mimeType:string;contentBase64:string}}};
  const ticket=JSON.parse(await readFile(new URL('flow-contract-tickets.create.json',fixtureDirectory),'utf8')) as {data:unknown};
  const file={contentBase64:binary.response.data.contentBase64,fileName:'forwarded.heic',mimeType:binary.response.data.mimeType};
  const payload={title:'Synthetic attestation ticket',description:'Generated binary fixture transfer'};
  const requestBody={request:{operation:'tickets.create',payload,idempotencyKey:uuid()},resolved:{...payload,attachments:[file]},response:ticket.data};
  const response=await runtime.dispatchFetch('https://test.invalid/live/header-fixture/bridge',{method:'POST',body:JSON.stringify(requestBody)});
  const body=await response.json() as {calls:number;captured:{body:{requestId:string};headers:Record<string,string>}};
  assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.calls,1);
  const headers=Object.fromEntries(Object.entries(body.captured.headers).map(([key,value])=>[key.toLowerCase(),value]));
  for(const name of headersSchema.required)assert.ok(headers[name],`Native Flow requires ${name}`);
  for(const [name,schema] of Object.entries(headersSchema.properties))if(headers[name]!==undefined){
    if(schema.minLength!==undefined)assert.ok(headers[name].length>=schema.minLength,name);
    if(schema.maxLength!==undefined)assert.ok(headers[name].length<=schema.maxLength,name);
    if(schema.pattern)assert.match(headers[name],new RegExp(schema.pattern),name);
    if(schema.const)assert.equal(headers[name],schema.const,name);
  }
  const canonical=JSON.stringify({attachments:[file],description:payload.description,title:payload.title});
  const digest=createHash('sha256').update(canonical).digest('hex');
  assert.equal(headers['x-mentor-request-id'],body.captured.body.requestId);
  assert.equal(headers['x-mentor-payload-sha256'],digest);
  assert.equal(headers['x-mentor-files-validated-sha256'],digest);
  const rejected=await runtime.dispatchFetch('https://test.invalid/live/header-fixture/bridge',{method:'POST',body:JSON.stringify({...requestBody,resolved:{...payload,attachments:[{...file,contentBase64:Buffer.from('invalid signature').toString('base64')}]}})});
  assert.equal(rejected.status,400);assert.equal((await rejected.json() as {error:{code:string}}).error.code,'ATTACHMENT_REJECTED');
});

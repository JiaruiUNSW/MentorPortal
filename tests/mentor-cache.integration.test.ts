import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { BridgeResponse, Operation, OperationResults } from '../lib/contracts';
import type { DueSyncResult, SyncResult } from '../lib/mentor-cache';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOUR = 3_600_000;
let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare['getD1Database']>>;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { readCachedMentor, syncMentorAccount, runDueSync, invalidateMentorCache } from './lib/mentor-cache';
        import { parseClientRequest } from './lib/mentor-data/validation';
        import { errorEnvelope, safeError } from './lib/mentor-data/errors';
        const controls = new Map();
        const calls = [];
        const sourceLogs = [];
        const originalConsoleError = console.error.bind(console);
        console.error = (...args) => {
          if(args.length===1 && typeof args[0]==='string' && args[0].includes('"event":"mentor_cache_source_read_failed"'))sourceLogs.push(JSON.parse(args[0]));
          else originalConsoleError(...args);
        };
        let releaseHold;
        let held = false;
        const today = () => new Date().toISOString().slice(0,10);
        function rawGroup(id,revision,past=false) {
          return {id,version:String(revision),title:'Synthetic group '+id,roundId:'Synthetic round',startDate:past?'2000-01-01':today(),type:'Diploma',mode:'In person',groupStatus:1,reportEnabled:true,mplName:'Synthetic coordinator',mplCommunicationEmail:'coordinator@example.test',menteeCount:1,attendedCount:0,week1Reports:1,meetupReports:1,completionReports:0,firstAttendanceUpdatedAt:null,attendanceUpdatedAt:null,week1ReportedAt:null,firstMeetupReportedAt:null,secondMeetupReportedAt:null,completedAt:null};
        }
        const file = (id,parentKind,parentId) => ({id:'source_'+id,fileName:'synthetic.png',mimeType:'image/png',sizeBytes:null,parentKind,parentId});
        function ticket(id,revision) {return {id,version:String(revision),title:'Synthetic issue '+id,description:'Revision '+revision,status:'Open',staffName:'',staffComment:'',createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z',attachments:[file(id,'ticket',id)]};}
        function page(items,cursor,bad) {
          const selected=items.filter(item=>item.id>Number(cursor||0));
          const first=selected.slice(0,1);
          return {items:first,nextCursor:bad?'not-a-source-cursor':selected.length>1?String(first[0].id):null};
        }
        async function sourceFetch(_url,init) {
          const request=JSON.parse(init.body),actor=request.actor.userId,account=request.actor.portalAccountId,p=request.payload;
          const control=controls.get(account)||{};const revision=control.revision||1,base=(actor-1)*100;
          calls.push({operation:request.operation,account,actor,payload:p});
          if(control.holdOperation===request.operation && !held) {held=true;await new Promise(resolve=>{releaseHold=resolve;});}
          if(control.failOperation===request.operation)return Response.json({schemaVersion:'1.0',requestId:request.requestId,ok:false,error:{code:control.failureCode||'UPSTREAM_UNAVAILABLE',message:'Synthetic source refusal',retryable:true}},{status:503});
          const groups=[rawGroup(base+10,revision),...(control.removeGroup2?[]:[rawGroup(base+20,revision,true)])];
          const balance={balance:actor*100+revision,totalCredit:500,roundCount:2,milestone:600,milestoneRound:5,ranking:[{rank:1,mentorName:'Synthetic mentor '+actor,roundCount:2,groupCount:groups.length,currentCredit:actor*100+revision,isCurrentMentor:true}]};
          const profile={id:actor,version:String(revision),displayName:'Synthetic mentor '+actor,preferredName:'Synthetic mentor '+actor,communicationEmail:'mentor'+actor+'@example.test',country:'Australia',phoneNumber:'0412345678',communicationChannels:['Email'],programs:['Diploma'],stream:'Science',otherStream:'',wwcc:'WWC-SYNTHETIC',wwccExpiryDate:'2029-01-01',dateOfBirth:null};
          const tickets=[ticket(base+50,revision),ticket(base+60,revision)];
          const rewards=[{id:500,name:'Synthetic reward',inStock:true,points:40,discountPoints:null,effectivePoints:40,productType:'Voucher',imageUrl:null},{id:600,name:'Synthetic notebook',inStock:true,points:60,discountPoints:null,effectivePoints:60,productType:'Item',imageUrl:null}];
          let data;
          switch(request.operation) {
            case 'bootstrap': data={mentor:{id:actor,displayName:profile.displayName,preferredName:profile.preferredName,communicationEmail:profile.communicationEmail},balance,groups:[groups[0]],tasks:[]};break;
            case 'profile.get': data={profile,choices:{communicationChannels:['Email'],programs:['Diploma'],streams:['Science']}};break;
            case 'balance.get': data=balance;break;
            case 'groups.list': data=page(groups,p.cursor,control.badCursor);break;
            case 'groups.get': {
              const group=groups.find(item=>item.id===p.groupId);
              if(!group)return Response.json({schemaVersion:'1.0',requestId:request.requestId,ok:false,error:{code:'OWNERSHIP_DENIED',message:'Synthetic ownership denied',retryable:false}},{status:403});
              const reportId=group.id+1,expenseId=group.id+2;
              const common={id:reportId,version:String(revision),groupId:group.id,title:'Synthetic report '+group.id,createdAt:'2026-01-01T00:00:00Z',modifiedAt:'2026-01-01T00:00:00Z',reviewStatus:'submitted',submissionState:'submitted'};
              data={group,mentees:[{id:group.id+3,version:String(revision),firstName:'Synthetic',lastName:'Mentee',gender:'',nationality:'',under18:'No',visa:'',program:'Diploma',attended:false}],reports:[{...common,kind:'week1',question:'Synthetic week1',attachments:[]},{...common,kind:'meetup',meetupDate:today(),attendance:1,description:'Meet-up revision '+revision,isUseGC:true,isRequiredSC:false,attachments:[file(reportId,'meetupReport',reportId)]}],expenses:[{id:expenseId,version:String(revision),groupId:group.id,meetupReportId:reportId,amount:10,currency:'AUD',reviewStatus:'submitted',processingStatus:'unknown',attachments:[file(expenseId,'expense',expenseId)]}],tasks:[{key:'report.meetup1',label:'Meet-up milestone',deadline:null,status:'Completed'}]};break;
            }
            case 'transactions.list': data=page([{id:base+70,transactionId:'SYNTHETIC-1',type:'Credit',group:'Synthetic',amount:10,timestamp:null,notes:'',issuer:''},{id:base+80,transactionId:'SYNTHETIC-2',type:'Credit',group:'Synthetic',amount:20,timestamp:null,notes:'',issuer:''}],p.cursor,false);break;
            case 'tickets.list': data=page(tickets,p.cursor,false);break;
            case 'tickets.get': data={ticket:tickets.find(item=>item.id===p.ticketId)};break;
            case 'redemptions.list': data=page([{id:base+90,requestReference:'SYNTHETIC',rewardId:500,rewardName:'Synthetic reward',optionIds:[],comment:'',points:40,status:'pending',creditState:'not_debited',createdAt:'2026-01-01T00:00:00Z'}],p.cursor,false);break;
            case 'rewards.list': data=page(rewards,p.cursor,false);break;
            case 'rewards.get': data={reward:rewards.find(item=>item.id===p.rewardId),options:[]};break;
            default: throw new Error('Unexpected synthetic source operation');
          }
          return Response.json({schemaVersion:'1.0',requestId:request.requestId,ok:true,data});
        }
        export default {async fetch(request,env) {
          const input=await request.json(),account=input.account||${JSON.stringify(ACCOUNT_A)},actor=input.actor||1;
          const principal={accountId:account,email:'mentor'+actor+'@example.test',displayName:'Synthetic mentor '+actor,mentorUserId:actor,role:'mentor',mode:'live'};
          const bindings={...env,PORTAL_MODE:'live',MENTOR_CACHE_ENABLED:'true',MENTOR_READ_URL:'https://cache-fixture.logic.azure.com/read',MENTOR_BRIDGE_KEY:'synthetic-cache-test-key-with-at-least-32-characters',...(input.bindings||{})};
          try {
            if(input.action==='reset'){controls.clear();calls.length=0;sourceLogs.length=0;held=false;releaseHold=undefined;return Response.json({ok:true});}
            if(input.action==='control'){controls.set(account,input.control||{});return Response.json({ok:true});}
            if(input.action==='stats')return Response.json({calls,held,sourceLogs});
            if(input.action==='release'){releaseHold?.();return Response.json({ok:true});}
            if(input.action==='invalidate'){await invalidateMentorCache(bindings,principal);return Response.json({ok:true});}
            const options={fetcher:sourceFetch,minimumRequestIntervalMs:0,...(input.options||{})};
            if(input.action==='sync')return Response.json(await syncMentorAccount(bindings,principal,options));
            if(input.action==='due')return Response.json(await runDueSync(bindings,options));
            const parsed=parseClientRequest({operation:input.operation,payload:input.payload||{}});
            return Response.json(await readCachedMentor(bindings,principal,parsed,crypto.randomUUID()));
          }catch(error){const safe=safeError(error);return Response.json(errorEnvelope(crypto.randomUUID(),safe),{status:safe.status});}
        }};
      `,
      resolveDir: process.cwd(), loader: 'ts', sourcefile: 'mentor-cache-test-worker.ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
  database = await runtime.getD1Database('DB');
  for (const file of (await readdir('drizzle')).filter(file => file.endsWith('.sql')).sort()) {
    for (const statement of (await readFile(`drizzle/${file}`, 'utf8')).split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
  }
});
after(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  await database.batch(['mentor_cache_snapshots','mentor_cache_sync_state','mentor_files','mentor_audit','auth_accounts'].map(table => database.prepare(`DELETE FROM ${table}`)));
  for (const [account, actor] of [[ACCOUNT_A,1],[ACCOUNT_B,2]] as const) await database.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,'mentor','live','active',?)").bind(account,`mentor${actor}@example.test`,`Synthetic mentor ${actor}`,actor,Date.now()).run();
  await command({ action: 'reset' });
});
async function command<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await runtime.dispatchFetch('https://local-cache-test.invalid/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}
async function cached<O extends Operation>(operation: O, payload: unknown = {}, account = ACCOUNT_A, actor = 1) {
  return command<BridgeResponse<O>>({ action: 'read', operation, payload, account, actor });
}
async function sync(extra: Record<string, unknown> = {}) {
  const result = await command<SyncResult>({ action: 'sync', ...extra });
  assert.equal(result.status,200,JSON.stringify(result.body)); return result.body;
}
async function stats() { return (await command<{calls: {operation:string;account:string;actor:number;payload:Record<string,unknown>}[];held:boolean;sourceLogs:Record<string,unknown>[]}>({action:'stats'})).body; }
function data<O extends Operation>(response: { body: BridgeResponse<O> }): OperationResults[O] { assert.equal(response.body.ok,true,JSON.stringify(response.body));if(!response.body.ok)throw new Error('Expected cached data');return response.body.data; }
function code(response: { body: BridgeResponse }): string | undefined { return response.body.ok ? undefined : response.body.error.code; }


test('cache miss is pending, all cached reads use zero HTTP, and complete scoped data persists', async () => {
  assert.equal(code(await cached('bootstrap')),'CACHE_PENDING');assert.equal((await stats()).calls.length,0);
  assert.equal((await sync()).status,'synced');
  const before=(await stats()).calls.length;
  const bootstrap=data(await cached('bootstrap'));assert.equal(bootstrap.mode,'live');assert.equal(bootstrap.previewLabel,null);assert.equal(bootstrap.groups.length,1);assert.equal(bootstrap.dataSync?.stale,false);
  const all=data(await cached('groups.list',{period:'all'}));assert.equal(all.items.length,2);
  assert.equal(data(await cached('groups.list',{period:'past'})).items.length,1);
  const group=data(await cached('groups.get',{groupId:'10'}));assert.equal(group.reports.length,2);assert.equal(group.expenses[0].meetupReportId,'11');assert.match(group.reports[1].attachments[0].id,/^file_[a-f0-9]{48}$/);
  assert.equal(data(await cached('reports.get',{kind:'week1',reportId:'11'})).report.kind,'week1');assert.equal(data(await cached('reports.get',{kind:'meetup',reportId:'11'})).report.kind,'meetup');
  assert.equal(data(await cached('reports.list',{groupId:'10',kind:'meetup'})).items.length,1);
  assert.equal(data(await cached('profile.get')).profile.id,'1');assert.equal(data(await cached('balance.get')).balance,101);
  assert.equal(data(await cached('transactions.list')).items.length,2);assert.equal(data(await cached('tickets.list',{search:'50'})).items.length,1);
  assert.equal(data(await cached('tickets.get',{ticketId:'50'})).ticket.id,'50');assert.equal(data(await cached('redemptions.list')).items.length,1);
  assert.equal(data(await cached('rewards.list')).items.length,2);assert.equal(data(await cached('rewards.get',{rewardId:'500'})).reward.id,'500');
  assert.equal((await stats()).calls.length,before,'Page reads never call the source, including entity lookups and paging.');
  assert.equal(code(await cached('attachments.download',{parentKind:'meetupReport',parentId:'11',groupId:'10',attachmentId:group.reports[1].attachments[0].id})),'VALIDATION_ERROR');
});

test('account and Mentor mapping isolate private balance/ranking and catalog namespaces', async () => {
  await sync();assert.equal((await sync({account:ACCOUNT_B,actor:2})).status,'synced');
  const first=data(await cached('balance.get'));const second=data(await cached('balance.get',{},ACCOUNT_B,2));assert.equal(first.balance,101);assert.equal(second.balance,201);assert.notEqual(first.ranking?.[0].mentorName,second.ranking?.[0].mentorName);
  assert.equal(code(await cached('groups.get',{groupId:'10'},ACCOUNT_B,2)),'RECORD_NOT_FOUND');assert.equal(code(await cached('reports.get',{kind:'meetup',reportId:'11'},ACCOUNT_B,2)),'RECORD_NOT_FOUND');
  const count=await database.prepare('SELECT count(*) AS n FROM mentor_cache_snapshots').first<{n:number}>();assert.equal(count?.n,4);
  await database.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").bind(ACCOUNT_A).run();const before=(await stats()).calls.length;assert.equal(code(await cached('bootstrap')),'MENTOR_FORBIDDEN');assert.equal((await stats()).calls.length,before);
});

test('soft expiry serves last-good stale while hard72-hour expiry refuses it without HTTP', async () => {
  await sync();const now=Date.now();
  await database.prepare("UPDATE mentor_cache_snapshots SET synced_at=?,refresh_after=?,hard_expires_at=? WHERE account_id=? AND namespace='private'").bind(now-25*HOUR,now-HOUR,now+47*HOUR,ACCOUNT_A).run();
  const before=(await stats()).calls.length;assert.equal(data(await cached('bootstrap')).dataSync?.stale,true);
  await database.prepare("UPDATE mentor_cache_snapshots SET synced_at=?,hard_expires_at=? WHERE account_id=? AND namespace='private'").bind(now-73*HOUR,now-HOUR,ACCOUNT_A).run();
  assert.equal(code(await cached('bootstrap')),'CACHE_EXPIRED');assert.equal((await stats()).calls.length,before);
});

test('failed partial synchronization preserves the entire last-good generation', async () => {
  await sync();const before=await database.prepare("SELECT generation,snapshot_json FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(ACCOUNT_A).first<{generation:string;snapshot_json:string}>();
  await command({action:'control',control:{revision:2,failOperation:'tickets.get'}});
  assert.equal((await sync({options:{force:true}})).status,'failed');
  const after=await database.prepare("SELECT generation,snapshot_json FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(ACCOUNT_A).first<{generation:string;snapshot_json:string}>();assert.deepEqual(after,before);
  assert.equal(data(await cached('balance.get')).balance,101);assert.equal(data(await cached('groups.get',{groupId:'10'})).group.version,'1');
});

test('source authorization loss purges both snapshots and cannot serve stale data', async () => {
  await sync();await command({action:'control',control:{failOperation:'profile.get',failureCode:'MENTOR_FORBIDDEN'}});
  const result=await sync({options:{force:true}});assert.equal(result.status,'denied');
  const count=await database.prepare('SELECT count(*) AS n FROM mentor_cache_snapshots WHERE account_id=?').bind(ACCOUNT_A).first<{n:number}>();assert.equal(count?.n,0);
  const before=(await stats()).calls.length;assert.equal(code(await cached('bootstrap')),'MENTOR_FORBIDDEN');assert.equal(code(await cached('rewards.list')),'MENTOR_FORBIDDEN');assert.equal((await stats()).calls.length,before);
});

test('replacing the owned-group snapshot removes old group/report/expense access', async () => {
  await sync();assert.equal(data(await cached('groups.get',{groupId:'20'})).expenses.length,1);
  await command({action:'control',control:{revision:2,removeGroup2:true}});assert.equal((await sync({options:{force:true,namespaces:['private']}})).status,'synced');
  assert.equal(data(await cached('groups.list',{period:'all'})).items.length,1);assert.equal(code(await cached('groups.get',{groupId:'20'})),'RECORD_NOT_FOUND');
  assert.equal(code(await cached('reports.get',{kind:'meetup',reportId:'21'})),'RECORD_NOT_FOUND');assert.equal(code(await cached('reports.list',{groupId:'20'})),'RECORD_NOT_FOUND');
});

test('opaque cache pagination is scoped to snapshot generation, identity and filters', async () => {
  await sync();const first=data(await cached('transactions.list',{limit:1}));assert.ok(first.nextCursor);
  const second=data(await cached('transactions.list',{limit:1,cursor:first.nextCursor}));assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);assert.equal(second.nextCursor,null);
  assert.equal(code(await cached('tickets.list',{limit:1,cursor:first.nextCursor})),'VERSION_CONFLICT');
  await command({action:'control',control:{revision:2}});await sync({options:{force:true,namespaces:['private']}});
  assert.equal(code(await cached('transactions.list',{limit:1,cursor:first.nextCursor})),'VERSION_CONFLICT');
});

test('invalid source cursor fails bounded synchronization without replacing old data', async () => {
  await sync();await command({action:'control',control:{revision:2,badCursor:true}});
  const before=(await stats()).calls.length;const result=await sync({options:{force:true,namespaces:['private']}});assert.equal(result.status,'failed');assert.ok((await stats()).calls.length-before<=4);assert.equal(data(await cached('balance.get')).balance,101);
});

test('private24h/catalog48h scheduling and write invalidation preserve last-good until refresh', async () => {
  await sync();const before=(await stats()).calls.length;assert.equal((await sync()).status,'not_due');assert.equal((await stats()).calls.length,before);
  await database.prepare('UPDATE mentor_cache_sync_state SET next_private_sync_at=0 WHERE account_id=?').bind(ACCOUNT_A).run();
  const privateSync=await sync();assert.equal(privateSync.status,'synced');assert.deepEqual(privateSync.namespaces,['private']);
  const calls=(await stats()).calls.slice(before);assert.ok(!calls.some(call=>call.operation.startsWith('rewards.')));
  await command({action:'invalidate'});assert.equal(data(await cached('bootstrap')).dataSync?.stale,true);assert.equal(code(await cached('reports.get',{kind:'meetup',reportId:'999'})),'RECORD_NOT_FOUND');
  const due=await database.prepare('SELECT next_private_sync_at,next_catalog_sync_at FROM mentor_cache_sync_state WHERE account_id=?').bind(ACCOUNT_A).first<{next_private_sync_at:number;next_catalog_sync_at:number}>();assert.ok(due && due.next_private_sync_at<=Date.now() && due.next_catalog_sync_at<=Date.now());
});

test('concurrent sync lease and invalidation fence prevent stale publication', async () => {
  await sync();await command({action:'control',control:{revision:2,holdOperation:'profile.get'}});
  const pending=sync({options:{force:true,namespaces:['private']}});
  for(let i=0;i<50 && !(await stats()).held;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal((await stats()).held,true);
  assert.equal((await sync({options:{force:true}})).status,'busy');await command({action:'invalidate'});await command({action:'release'});
  assert.equal((await pending).status,'superseded');assert.equal(data(await cached('balance.get')).balance,101);assert.equal(data(await cached('bootstrap')).dataSync?.stale,true);
});

test('expired persisted lease recovers after restart while fresh leases are respected', async () => {
  await sync();await database.prepare("UPDATE mentor_cache_sync_state SET lease_token='crashed-worker',lease_expires_at=?,next_private_sync_at=0 WHERE account_id=?").bind(Date.now()+60_000,ACCOUNT_A).run();
  assert.equal((await sync()).status,'busy');await database.prepare('UPDATE mentor_cache_sync_state SET lease_expires_at=0 WHERE account_id=?').bind(ACCOUNT_A).run();
  assert.equal((await sync()).status,'synced');
});

test('due runner ignores the obsolete pilot setting and returns partial status for source failure', async () => {
  const result=await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'1'},options:{maxAccounts:2}});assert.equal(result.body.status,'ok');assert.equal(result.body.accountsChecked,2);assert.equal(result.body.results.length,4);assert.deepEqual(new Set(result.body.results.map(item=>item.accountId)),new Set([ACCOUNT_A,ACCOUNT_B]));assert.deepEqual(result.body.results.map(item=>item.namespaces),[['private'],['catalog'],['private'],['catalog']]);
  assert.equal(data(await cached('bootstrap',{},ACCOUNT_B,2)).mentor.id,'2');
  await command({action:'control',control:{failOperation:'bootstrap'}});await command({action:'invalidate'});
  const failed=await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'1'}});assert.equal(failed.body.status,'partial');assert.equal(failed.body.results[0].status,'failed');
});

test('a newly activated Mentor 148 synchronizes without a list while disabled, demo and admin accounts are excluded', async () => {
  const newcomer='cccccccc-cccc-4ccc-8ccc-cccccccccccc',disabled='dddddddd-dddd-4ddd-8ddd-dddddddddddd',demo='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',admin='ffffffff-ffff-4fff-8fff-ffffffffffff';
  for(const [id,actor,mode,role,status]of [[newcomer,148,'live','mentor','active'],[disabled,149,'live','mentor','disabled'],[demo,150,'demo','mentor','active'],[admin,0,'live','admin','active']]as const)await database.prepare('INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,`synthetic-${actor}-${mode}@example.test`,'Synthetic account',actor,role,mode,status,Date.now()).run();
  assert.equal(await database.prepare('SELECT COUNT(*) AS n FROM mentor_cache_sync_state WHERE account_id=?').bind(newcomer).first<number>('n'),0);
  const result=await command<DueSyncResult>({action:'due'});assert.equal(result.body.status,'ok');assert.equal(result.body.accountsChecked,3);
  assert.deepEqual(new Set(result.body.results.map(item=>item.accountId)),new Set([ACCOUNT_A,ACCOUNT_B,newcomer]));const newcomerCalls=(await stats()).calls.filter(item=>item.account===newcomer);assert.ok(newcomerCalls.length>0);assert.ok(newcomerCalls.every(item=>item.actor===148));
  assert.equal(data(await cached('bootstrap',{},newcomer,148)).mentor.id,'148');assert.equal(await database.prepare('SELECT COUNT(*) AS n FROM mentor_cache_snapshots WHERE account_id=?').bind(newcomer).first<number>('n'),2);
  for(const id of [disabled,demo,admin])assert.equal(await database.prepare('SELECT COUNT(*) AS n FROM mentor_cache_sync_state WHERE account_id=?').bind(id).first<number>('n'),0);
  const before=(await stats()).calls.length;assert.equal((await sync({account:newcomer,actor:147,options:{force:true}})).status,'denied');assert.equal((await stats()).calls.length,before);assert.equal(data(await cached('bootstrap',{},newcomer,148)).mentor.id,'148');
});

test('one-off Mentor selection uses existing active mappings and cannot become an authorization bypass',async()=>{
  const newcomer='cccccccc-cccc-4ccc-8ccc-cccccccccccc';await database.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,148,'mentor','live','active',?)").bind(newcomer,'synthetic-new@example.test','Synthetic new Mentor',Date.now()).run();
  const result=await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'obsolete-invalid-value'},options:{mentorUserId:148,force:true}});assert.equal(result.body.status,'ok');assert.equal(result.body.accountsChecked,1);assert.ok(result.body.results.every(item=>item.accountId===newcomer));assert.equal(data(await cached('bootstrap',{},newcomer,148)).mentor.id,'148');
  assert.equal(code(await cached('bootstrap')),'CACHE_PENDING');await database.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").bind(newcomer).run();const before=(await stats()).calls.length;assert.equal((await command<DueSyncResult>({action:'due',options:{mentorUserId:148,force:true}})).body.accountsChecked,0);assert.equal((await stats()).calls.length,before);assert.equal(code(await cached('bootstrap',{},newcomer,148)),'MENTOR_FORBIDDEN');
  assert.equal(code(await command<BridgeResponse>({action:'due',options:{mentorUserId:0}})),'VALIDATION_ERROR');
});

test('catalog can refresh independently without publishing personal credit or changing the private generation', async () => {
  assert.equal((await sync({options:{namespaces:['private']}})).status,'synced');assert.equal(code(await cached('rewards.list')),'CACHE_PENDING');
  const original=await database.prepare("SELECT generation FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(ACCOUNT_A).first<{generation:string}>();
  const before=(await stats()).calls.length;const result=await sync();assert.equal(result.status,'synced');assert.deepEqual(result.namespaces,['catalog']);assert.ok((await stats()).calls.slice(before).every(call=>call.operation.startsWith('rewards.')));
  const retained=await database.prepare("SELECT generation FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(ACCOUNT_A).first<{generation:string}>();assert.deepEqual(retained,original);
  const catalog=await database.prepare("SELECT snapshot_json,refresh_after-synced_at AS ttl FROM mentor_cache_snapshots WHERE account_id=? AND namespace='catalog'").bind(ACCOUNT_A).first<{snapshot_json:string;ttl:number}>();assert.ok(catalog);assert.equal(catalog.ttl,48*HOUR);assert.doesNotMatch(catalog.snapshot_json,/isCurrentMentor|communicationEmail|WWC-SYNTHETIC|"balance"/);
});

test('an account mapping change never reuses the old Mentor snapshot', async () => {
  await sync();await database.prepare('UPDATE auth_accounts SET mentor_user_id=3 WHERE id=?').bind(ACCOUNT_A).run();const before=(await stats()).calls.length;
  assert.equal(code(await cached('bootstrap')),'MENTOR_FORBIDDEN');
  const rebound=await command<BridgeResponse<'bootstrap'>>({action:'read',operation:'bootstrap',account:ACCOUNT_A,actor:3});assert.equal(code(rebound),'CACHE_PENDING');assert.equal((await stats()).calls.length,before);
});

test('a reclaimed lease fences an older still-running synchronization', async () => {
  await sync();await command({action:'control',control:{revision:2,holdOperation:'profile.get'}});
  const older=sync({options:{force:true,namespaces:['private']}});
  for(let i=0;i<50 && !(await stats()).held;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal((await stats()).held,true);
  await database.prepare('UPDATE mentor_cache_sync_state SET lease_expires_at=0 WHERE account_id=?').bind(ACCOUNT_A).run();
  await command({action:'control',control:{revision:3}});assert.equal((await sync({options:{force:true,namespaces:['private']}})).status,'synced');
  await command({action:'release'});assert.equal((await older).status,'superseded');assert.equal(data(await cached('balance.get')).balance,103);
});

test('a publication batch failure rolls back both namespaces and retains the last-good snapshots', async () => {
  await sync();const original=await database.prepare('SELECT namespace,generation,snapshot_json FROM mentor_cache_snapshots WHERE account_id=? ORDER BY namespace').bind(ACCOUNT_A).all<{namespace:string;generation:string;snapshot_json:string}>();
  await database.prepare("CREATE TRIGGER synthetic_cache_publication_failure BEFORE INSERT ON mentor_cache_snapshots WHEN NEW.namespace='catalog' BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END").run();
  try {
    await command({action:'control',control:{revision:2}});assert.equal((await sync({options:{force:true}})).status,'failed');
    const retained=await database.prepare('SELECT namespace,generation,snapshot_json FROM mentor_cache_snapshots WHERE account_id=? ORDER BY namespace').bind(ACCOUNT_A).all<{namespace:string;generation:string;snapshot_json:string}>();assert.deepEqual(retained.results,original.results);assert.equal(data(await cached('balance.get')).balance,101);
  }finally{await database.prepare('DROP TRIGGER synthetic_cache_publication_failure').run();}
});

test('source failures log only fixed correlation fields without source text or record values', async () => {
  await command({action:'control',control:{failOperation:'profile.get'}});assert.equal((await sync()).status,'failed');
  const logs=(await stats()).sourceLogs;assert.equal(logs.length,1);assert.deepEqual(Object.keys(logs[0]).sort(),['code','event','operation','requestId','status']);
  assert.equal(logs[0].event,'mentor_cache_source_read_failed');assert.equal(logs[0].operation,'profile.get');assert.equal(logs[0].code,'UPSTREAM_UNAVAILABLE');assert.equal(logs[0].status,503);assert.match(String(logs[0].requestId),/^[a-f0-9-]{36}$/);
  assert.doesNotMatch(JSON.stringify(logs),/Synthetic source refusal|mentor1@example|WWC-SYNTHETIC|logic\.azure|secret|headers|payload/);
});

test('production due runner publishes complete private data even when the cold catalog sync fails', async () => {
  await command({action:'control',control:{failOperation:'rewards.list'}});
  const result=await command<DueSyncResult>({action:'due'});
  assert.equal(result.body.status,'partial');assert.equal(result.body.accountsChecked,2);assert.deepEqual(result.body.results.filter(item=>item.accountId===ACCOUNT_A).map(item=>[item.namespaces[0],item.status]),[['private','synced'],['catalog','failed']]);
  assert.equal(data(await cached('bootstrap')).mentor.id,'1');assert.equal(data(await cached('balance.get')).balance,101);assert.equal(data(await cached('groups.get',{groupId:'10'})).reports.length,2);assert.equal(code(await cached('rewards.list')),'CACHE_PENDING');
});

test('record-not-found refresh races retain last-good and retry soon without denying the account', async () => {
  await sync();await command({action:'control',control:{revision:2,failOperation:'groups.get',failureCode:'RECORD_NOT_FOUND'}});
  const result=await sync({options:{force:true,namespaces:['private']}});assert.equal(result.status,'failed');assert.equal(result.errorCode,'RECORD_NOT_FOUND');assert.equal(data(await cached('balance.get')).balance,101);assert.equal(data(await cached('rewards.list')).items.length,2);
  const state=await database.prepare('SELECT authorization_state,next_private_sync_at FROM mentor_cache_sync_state WHERE account_id=?').bind(ACCOUNT_A).first<{authorization_state:string;next_private_sync_at:number}>();assert.equal(state?.authorization_state,'authorized');assert.ok(state && state.next_private_sync_at>Date.now()+14*60_000 && state.next_private_sync_at<Date.now()+16*60_000);
});

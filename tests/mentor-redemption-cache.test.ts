import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { BridgeResponse, Operation, OperationResults, RedemptionDto } from '../lib/contracts';
import type { DueSyncResult, SyncResult } from '../lib/mentor-cache';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',MINUTE=60_000,HOUR=60*MINUTE;
let runtime:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
before(async()=>{
  const detail=JSON.parse(await readFile('tests/fixtures/flow-contract-groups.get.json','utf8')).data;
  detail.reports=[];detail.expenses=[];detail.tasks=[];detail.mentees=detail.mentees.slice(0,1);detail.group.meetupCount=0;
  const profile=JSON.parse(await readFile('tests/fixtures/flow-contract-profile.get.json','utf8')).data;
  const bundle=await build({stdin:{contents:`
    import {syncMentorAccount,runDueSync,refreshRedemptionStatus,readCachedMentor,applyConfirmedWriteToCache,invalidateMentorCache} from './lib/mentor-cache';
    import {hasUnsettledRedemptions} from './lib/mentor-cache/config';
    import {parseClientRequest} from './lib/mentor-data/validation';
    import {errorEnvelope,safeError} from './lib/mentor-data/errors';
    const DETAIL=${JSON.stringify(detail)},PROFILE=${JSON.stringify(profile)},controls=new Map(),calls=[],logs=[];
    let clock=Date.now(),held=false,releaseHold;
    const originalError=console.error.bind(console);
    console.error=(...args)=>{if(typeof args[0]==='string'&&args[0].includes('mentor_cache_source_read_failed'))logs.push(JSON.parse(args[0]));else originalError(...args);};
    const clone=value=>JSON.parse(JSON.stringify(value));
    function page(items,p,control){const selected=items.filter(item=>item.id>Number(p.cursor||0)),slice=selected.slice(0,control.pageSize||50);return {items:slice,nextCursor:control.badCursor?'bad-cursor':slice.length<selected.length?String(slice.at(-1).id):null};}
    async function fetcher(_url,init){
      const sent=JSON.parse(init.body),account=sent.actor.portalAccountId,actor=sent.actor.userId,control=controls.get(account)||{},p=sent.payload;
      calls.push({operation:sent.operation,account,actor});
      if(control.hold===sent.operation&&!held){held=true;await new Promise(resolve=>{releaseHold=resolve;});}
      if(control.fail===sent.operation)return Response.json({schemaVersion:'1.0',requestId:sent.requestId,ok:false,error:{code:control.errorCode||'UPSTREAM_UNAVAILABLE',message:'Synthetic source error',retryable:true}},{status:503});
      const detail=clone(DETAIL),profile=clone(PROFILE);profile.profile.id=actor;profile.profile.country='Country '+(control.revision||1);detail.group.title='Group revision '+(control.revision||1);
      const balance={balance:control.balance??actor*100,totalCredit:500,roundCount:1,milestone:0,milestoneRound:0,reserved:0};
      const redemptions=control.redemptions||[{id:actor*100+1,requestReference:'SYNTHETIC',rewardId:500,rewardName:'Synthetic reward',optionIds:[],comment:'',points:40,status:control.status||'pending',creditState:control.creditState||'not_debited',createdAt:'2026-10-01T00:00:00Z'}];
      const transactions=control.transactions||[{id:actor*100+10,transactionId:'SYNTHETIC-'+(control.revision||1),type:'Credit',group:'Synthetic',amount:control.amount??10,timestamp:null,notes:'',issuer:''}];
      let data;
      switch(sent.operation){
        case 'bootstrap':data={mentor:profile.profile,balance,groups:[detail.group],tasks:[]};break;
        case 'profile.get':data=profile;break;
        case 'balance.get':data=balance;break;
        case 'groups.list':data={items:[detail.group],nextCursor:null};break;
        case 'groups.get':data=detail;break;
        case 'tickets.list':case 'rewards.list':data={items:[],nextCursor:null};break;
        case 'redemptions.list':data=page(redemptions,p,control);break;
        case 'transactions.list':data=page(transactions,p,control);break;
        default:throw Error('Unexpected synthetic source operation');
      }
      return Response.json({schemaVersion:'1.0',requestId:sent.requestId,ok:true,data});
    }
    export default {async fetch(request,env){
      const input=await request.json(),account=input.account||${JSON.stringify(A)},actor=input.actor||1;
      const principal={accountId:account,mentorUserId:actor,email:'fixture'+actor+'@example.test',displayName:'Synthetic',role:'mentor',mode:'live'};
      const bindings={...env,PORTAL_MODE:'live',MENTOR_CACHE_ENABLED:'true',MENTOR_SYNC_ALLOWED_USER_IDS:'1,2',MENTOR_READ_URL:'https://synthetic.logic.azure.com/read',MENTOR_BRIDGE_KEY:'synthetic-test-bridge-key-at-least-32-characters',...(input.bindings||{})};
      const options={fetcher,now:()=>clock,minimumRequestIntervalMs:0,...(input.options||{})};
      try{
        if(input.action==='reset'){clock=Date.now();controls.clear();calls.length=0;logs.length=0;held=false;releaseHold=undefined;return Response.json({now:clock});}
        if(input.action==='clock'){clock=input.now;return Response.json({now:clock});}
        if(input.action==='control'){controls.set(account,input.control||{});return Response.json({ok:true});}
        if(input.action==='stats')return Response.json({calls,logs,held,now:clock});
        if(input.action==='release'){releaseHold?.();return Response.json({ok:true});}
        if(input.action==='predicate')return Response.json({unsettled:hasUnsettledRedemptions(input.items)});
        if(input.action==='invalidate'){await invalidateMentorCache(bindings,principal);return Response.json({ok:true});}
        if(input.action==='full')return Response.json(await syncMentorAccount(bindings,principal,options));
        if(input.action==='target')return Response.json(await refreshRedemptionStatus(bindings,principal,options));
        if(input.action==='due')return Response.json(await runDueSync(bindings,options));
        if(input.action==='confirm'){await applyConfirmedWriteToCache(bindings,principal,input.request,input.response,input.options);return Response.json({ok:true});}
        return Response.json(await readCachedMentor(bindings,principal,parseClientRequest(input.request)));
      }catch(error){const safe=safeError(error);return Response.json(errorEnvelope(crypto.randomUUID(),safe),{status:safe.status});}
    }};`,resolveDir:process.cwd(),loader:'ts',sourcefile:'redemption-cache-test-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-22',d1Databases:['DB']});db=await runtime.getD1Database('DB');
  for(const file of(await readdir('drizzle')).filter(file=>file.endsWith('.sql')).sort())for(const sql of(await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
});
after(async()=>{await runtime?.dispose();});
beforeEach(async()=>{
  await db.prepare('DROP TRIGGER IF EXISTS reject_financial_publication').run();
  for(const table of ['mentor_cache_snapshots','mentor_cache_sync_state','mentor_audit','mentor_files','auth_accounts'])await db.prepare('DELETE FROM '+table).run();
  for(const [account,actor]of [[A,1],[B,2]]as const)await db.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,'mentor','live','active',?)").bind(account,actor+'@example.test','Synthetic',actor,Date.now()).run();
  await command({action:'reset'});
});
async function command<T=Record<string,unknown>>(input:Record<string,unknown>){const response=await runtime.dispatchFetch('https://redemption-cache-test.invalid/run',{method:'POST',body:JSON.stringify(input)});return {status:response.status,body:await response.json() as T};}
async function action(action:string,extra:Record<string,unknown>={}){const result=await command<SyncResult>({action,...extra});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
async function stats(){return (await command<{calls:{operation:string;account:string;actor:number}[];logs:unknown[];held:boolean;now:number}>({action:'stats'})).body;}
async function state(account=A){return (await db.prepare('SELECT * FROM mentor_cache_sync_state WHERE account_id=?').bind(account).first()) as Record<string,number|string|null>;}
async function snapshot(account=A){return (await db.prepare("SELECT * FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(account).first()) as {snapshot_json:string;synced_at:number;refresh_after:number;hard_expires_at:number;generation:string};}
async function read<O extends Operation>(operation:O,payload:unknown={},extra:Record<string,unknown>={}):Promise<OperationResults[O]>{const result=await command<BridgeResponse<O>>({action:'read',request:{operation,payload},...extra});assert.equal(result.body.ok,true,JSON.stringify(result.body));if(!result.body.ok)throw Error('Cache read failed');return result.body.data;}
async function due(){const s=await state();await command({action:'clock',now:Number(s.next_redemption_sync_at)});}
async function control(value:Record<string,unknown>,extra:Record<string,unknown>={}){await command({action:'control',control:value,...extra});}
async function held(){for(let i=0;i<100;i++){if((await stats()).held)return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Source did not pause');}

test('only financial RPCs refresh pending status, with the daily and catalog schedules and source age unchanged',async()=>{
  assert.equal((await action('full')).status,'synced');const before=await snapshot(),times=await state(),count=(await stats()).calls.length;
  assert.equal(Number(times.next_private_sync_at)-before.synced_at,24*HOUR);assert.equal(Number(times.next_catalog_sync_at)-before.synced_at,48*HOUR);assert.equal(Number(times.next_redemption_sync_at)-before.synced_at,5*MINUTE);
  await due();await control({status:'processing',creditState:'refunded',balance:70,revision:2,amount:-30});
  const tick=(await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'1'}})).body;assert.equal(tick.status,'ok');assert.ok(tick.results.some(result=>result.refreshKind==='redemption_status'&&result.status==='synced'));
  assert.deepEqual((await stats()).calls.slice(count).map(item=>item.operation),['redemptions.list','balance.get','transactions.list']);
  const after=await snapshot(),later=await state();for(const field of ['synced_at','refresh_after','hard_expires_at'] as const)assert.equal(after[field],before[field]);
  assert.equal(later.next_private_sync_at,times.next_private_sync_at);assert.equal(later.next_catalog_sync_at,times.next_catalog_sync_at);assert.equal(Number(later.next_redemption_sync_at),(await stats()).now+5*MINUTE);
  assert.deepEqual(JSON.parse(after.snapshot_json).groups,JSON.parse(before.snapshot_json).groups);assert.deepEqual(JSON.parse(after.snapshot_json).profile,JSON.parse(before.snapshot_json).profile);
  const calls=(await stats()).calls.length;assert.equal((await read('balance.get')).balance,70);assert.equal((await read('transactions.list')).items[0].amount,-30);assert.equal((await read('redemptions.list')).items[0].status,'processing');assert.equal((await stats()).calls.length,calls);
});

test('terminal settlement stops polling, while pending/processing and incomplete terminal credit states remain unsettled',async()=>{
  for(const [status,creditState,expected]of [['pending','not_debited',true],['processing','refunded',true],['approved','debited',false],['rejected','refunded',false],['approved','not_debited',true],['rejected','reserved',true],['approved','unknown',true],['needs_review','debited',false]] as const){const result=await command<{unsettled:boolean}>({action:'predicate',items:[{status,creditState}]});assert.equal(result.body.unsettled,expected,`${status}/${creditState}`);}
  await action('full');await due();await control({status:'approved',creditState:'debited',balance:60,amount:-40});assert.equal((await action('target')).status,'synced');
  assert.equal((await state()).next_redemption_sync_at,null);assert.equal((await read('redemptions.list')).items[0].status,'approved');assert.equal((await read('balance.get')).balance,60);
  const before=(await stats()).calls.length;assert.equal((await action('target')).status,'not_due');assert.equal((await stats()).calls.length,before);
});

test('a partial financial refresh keeps every last-good financial field and retries without accelerating full collection',async()=>{
  await action('full');const before=await snapshot(),times=await state();await due();await control({status:'approved',creditState:'debited',balance:60,fail:'transactions.list'});
  const result=await action('target');assert.equal(result.status,'failed');assert.equal((await snapshot()).snapshot_json,before.snapshot_json);
  const after=await state();assert.equal(after.next_private_sync_at,times.next_private_sync_at);assert.equal(after.next_catalog_sync_at,times.next_catalog_sync_at);assert.equal(after.next_redemption_sync_at,(await stats()).now+15*MINUTE);
});

test('source authorization denial purges both namespaces and cancels polling only for that account',async()=>{
  await action('full');await action('full',{account:B,actor:2});await due();await control({fail:'redemptions.list',errorCode:'MENTOR_FORBIDDEN'});
  assert.equal((await action('target')).status,'denied');assert.equal((await state()).next_redemption_sync_at,null);
  const rows=await db.prepare('SELECT namespace FROM mentor_cache_snapshots WHERE account_id=?').bind(A).all();assert.equal(rows.results.length,0);assert.equal((await read('balance.get',{}, {account:B,actor:2})).balance,200);
});

test('inactive accounts never dispatch status reads and lose stale cache access',async()=>{
  await action('full');await due();const before=(await stats()).calls.length;await db.prepare("UPDATE auth_accounts SET status='disabled' WHERE id=?").bind(A).run();
  assert.equal((await action('target')).status,'denied');assert.equal((await stats()).calls.length,before);assert.equal((await state()).next_redemption_sync_at,null);
});

test('full private work takes precedence; stale or missing status snapshots fall back to complete collection',async()=>{
  await action('full');await due();await db.prepare("UPDATE mentor_cache_snapshots SET refresh_after=0 WHERE account_id=? AND namespace='private'").bind(A).run();const before=(await stats()).calls.length;
  assert.equal((await action('target')).needsFullSync,true);assert.equal((await stats()).calls.length,before);
  const tick=(await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'1'}})).body;assert.equal(tick.status,'ok');assert.ok((await stats()).calls.slice(before).some(item=>item.operation==='profile.get'));
  await due();await db.prepare("DELETE FROM mentor_cache_snapshots WHERE account_id=? AND namespace='private'").bind(A).run();assert.equal((await action('target')).needsFullSync,true);
  assert.equal((await command<DueSyncResult>({action:'due',bindings:{MENTOR_SYNC_ALLOWED_USER_IDS:'1'}})).body.status,'ok');assert.ok(await snapshot());
});

test('an expired older full-sync lease cannot overwrite a newer targeted confirmation',async()=>{
  await action('full');await due();await control({hold:'balance.get',balance:111,revision:2});const pending=action('full',{options:{force:true,namespaces:['private']}});await held();
  await db.prepare('UPDATE mentor_cache_sync_state SET lease_expires_at=0 WHERE account_id=?').bind(A).run();await control({status:'approved',creditState:'debited',balance:60,revision:3});
  assert.equal((await action('target')).status,'synced');await command({action:'release'});assert.equal((await pending).status,'superseded');
  assert.equal((await read('balance.get')).balance,60);assert.equal((await read('profile.get')).profile.country,'Country 1');
});

test('write invalidation fences an in-flight financial merge',async()=>{
  await action('full');await due();const before=await snapshot();await control({hold:'balance.get',balance:1});const pending=action('target');await held();
  await command({action:'invalidate'});await command({action:'release'});assert.equal((await pending).status,'superseded');assert.equal((await snapshot()).snapshot_json,before.snapshot_json);
});

test('generation CAS rejects a competing snapshot without overwriting its value',async()=>{
  await action('full');await due();await control({hold:'balance.get',balance:1});const pending=action('target');await held();
  const row=await snapshot(),replacement=JSON.parse(row.snapshot_json);replacement.balance.balance=777;
  await db.prepare("UPDATE mentor_cache_snapshots SET snapshot_json=?,generation=? WHERE account_id=? AND namespace='private'").bind(JSON.stringify(replacement),'b'.repeat(32),A).run();
  await command({action:'release'});assert.equal((await pending).status,'superseded');assert.equal((await read('balance.get')).balance,777);
  assert.equal((await state()).next_redemption_sync_at,(await stats()).now+5*MINUTE);
});

test('a database batch failure rolls back the entire financial merge and retains the snapshot generation',async()=>{
  await action('full');await due();const before=await snapshot();await control({status:'approved',creditState:'debited',balance:60});
  await db.prepare("CREATE TRIGGER reject_financial_publication BEFORE UPDATE OF snapshot_json ON mentor_cache_snapshots BEGIN SELECT RAISE(ABORT,'synthetic cache publication failure'); END").run();
  assert.equal((await action('target')).status,'failed');const after=await snapshot();assert.equal(after.snapshot_json,before.snapshot_json);assert.equal(after.generation,before.generation);
  assert.equal((await state()).next_redemption_sync_at,(await stats()).now+15*MINUTE);
});

test('bounded pagination uses only financial operations and rejects a partial or invalid collection',async()=>{
  await action('full');const record=(await read('redemptions.list')).items[0];await due();
  await control({pageSize:1,redemptions:[{...record,id:101,rewardId:Number(record.rewardId)},{...record,id:102,rewardId:Number(record.rewardId)}]});const before=(await stats()).calls.length;assert.equal((await action('target')).status,'synced');
  assert.deepEqual((await stats()).calls.slice(before).map(item=>item.operation),['redemptions.list','redemptions.list','balance.get','transactions.list']);
  const saved=await snapshot();await due();await control({badCursor:true});assert.equal((await action('target')).status,'failed');assert.equal((await snapshot()).snapshot_json,saved.snapshot_json);
});

test('a replayed intake cannot replace a newer approved status; a fresh redemption still merges',async()=>{
  await action('full');const initial=(await read('redemptions.list')).items[0],base=await snapshot(),completedAt=base.synced_at+1;
  const request={operation:'redemptions.create',payload:{rewardId:initial.rewardId,optionIds:[],comment:'',expectedPoints:initial.points},idempotencyKey:crypto.randomUUID()};
  const response={schemaVersion:'1.0',requestId:crypto.randomUUID(),ok:true,data:{redemption:initial}};
  await command({action:'confirm',request,response,options:{completedAt}});
  await action('full',{options:{force:true,namespaces:['private']}});await due();await control({status:'approved',creditState:'debited',balance:60});await action('target');
  await command({action:'confirm',request,response,options:{completedAt,replayed:true}});assert.equal((await read('redemptions.list')).items[0].status,'approved');
  const fresh:RedemptionDto={...initial,id:'999',requestReference:'SYNTHETIC-NEW'};
  await command({action:'confirm',request:{...request,idempotencyKey:crypto.randomUUID()},response:{...response,requestId:crypto.randomUUID(),data:{redemption:fresh}},options:{completedAt:(await stats()).now+1}});
  assert.equal((await read('redemptions.list')).items.find(item=>item.id==='999')?.status,'pending');
});

for(const [status,creditState,refresh]of [['processing','refunded','target'],['approved','debited','target'],['rejected','refunded','full']] as const){
  test(`a delayed first pending acknowledgement preserves ${status}/${creditState} from ${refresh} refresh and appends a new identity`,async()=>{
    await action('full');const initial=(await read('redemptions.list')).items[0];await due();await control({status,creditState,balance:60});
    assert.equal((await action(refresh,refresh==='full'?{options:{force:true,namespaces:['private']}}:{})).status,'synced');
    const progressed=(await read('redemptions.list')).items[0],completedAt=(await stats()).now+10_000;
    const request={operation:'redemptions.create',payload:{rewardId:initial.rewardId,optionIds:[],comment:'',expectedPoints:initial.points},idempotencyKey:crypto.randomUUID()};
    const response={schemaVersion:'1.0',requestId:crypto.randomUUID(),ok:true,data:{redemption:initial}};
    const acknowledgement=await command({action:'confirm',request,response,options:{completedAt,replayed:false}});assert.equal(acknowledgement.status,200);
    assert.deepEqual((await read('redemptions.list')).items.find(item=>item.id===initial.id),progressed);
    const fresh={...initial,id:'999',requestReference:'SYNTHETIC-FRESH'};
    assert.equal((await command({action:'confirm',request:{...request,idempotencyKey:crypto.randomUUID()},response:{...response,requestId:crypto.randomUUID(),data:{redemption:fresh}},options:{completedAt:completedAt+1,replayed:false}})).status,200);
    const items=(await read('redemptions.list')).items;assert.deepEqual(items.find(item=>item.id===initial.id),progressed);assert.deepEqual(items.find(item=>item.id===fresh.id),fresh);
  });
}

test('a conflicting redemption identity is rejected without replacing or duplicating the source record',async()=>{
  await action('full');const existing=(await read('redemptions.list')).items[0],before=await snapshot();
  for(const incoming of [{...existing,requestReference:'CONFLICTING-REFERENCE'},{...existing,id:'999'},{...existing,rewardId:'501'}]){
    const result=await command<BridgeResponse>({action:'confirm',request:{operation:'redemptions.create',payload:{rewardId:incoming.rewardId,optionIds:[],comment:'',expectedPoints:incoming.points},idempotencyKey:crypto.randomUUID()},response:{schemaVersion:'1.0',requestId:crypto.randomUUID(),ok:true,data:{redemption:incoming}},options:{completedAt:(await stats()).now+10_000,replayed:false}});
    assert.equal(result.status,409);assert.equal(result.body.ok,false);if(!result.body.ok)assert.equal(result.body.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await snapshot()).snapshot_json,before.snapshot_json);
  }
});

test('migration backfills only unsettled existing snapshots without changing their daily timestamps',async()=>{
  await action('full');const before=await snapshot(),times=await state();await db.prepare('UPDATE mentor_cache_sync_state SET next_redemption_sync_at=NULL WHERE account_id=?').bind(A).run();
  const sql=(await readFile('drizzle/0005_redemption_status_refresh.sql','utf8')).split('--> statement-breakpoint').at(-1)!;await db.prepare(sql).run();
  const after=await state();assert.equal(after.next_redemption_sync_at,before.synced_at+5*MINUTE);assert.equal(after.next_private_sync_at,times.next_private_sync_at);assert.equal((await snapshot()).synced_at,before.synced_at);
});

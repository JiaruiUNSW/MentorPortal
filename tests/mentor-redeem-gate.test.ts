import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import type { ClientRequest, Operation, OperationResults } from '../lib/contracts';
import type { Principal } from '../lib/runtime';
import type { StandaloneBindings } from '../lib/standalone';

const principal:Principal={accountId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',mentorUserId:17,email:'synthetic@example.test',displayName:'Synthetic mentor',role:'mentor',mode:'live'};
const input:ClientRequest<'redemptions.create'>={operation:'redemptions.create',payload:{rewardId:'41',optionIds:[],comment:'Synthetic request',expectedPoints:40},idempotencyKey:randomUUID()};
let directory:string,bundleDirectory:string,bindings:StandaloneBindings,calls:Operation[];
let impl:{
  createStandaloneBindings:typeof import('../lib/standalone').createStandaloneBindings;
  setBindingsProvider:typeof import('../lib/runtime').setBindingsProvider;
  handleAuth:typeof import('../lib/auth').handleAuth;
  executeMentor:typeof import('../lib/mentor-data/service').executeMentor;
  requireLiveWriteAccess:typeof import('../lib/mentor-data/validation').requireLiveWriteAccess;
  callFlow:typeof import('../lib/flow-bridge').callFlow;
};
let ui:{renderForm:(enabled:boolean|undefined,readOnly:boolean)=>string;renderStore:(enabled:boolean|undefined)=>string};
const require=createRequire(import.meta.url);
before(async()=>{
  bundleDirectory=await mkdtemp(join(tmpdir(),'mentor-redeem-gate-module-'));
  const server=await build({stdin:{contents:`export {createStandaloneBindings} from './lib/standalone';export {setBindingsProvider} from './lib/runtime';export {handleAuth} from './lib/auth';export {executeMentor} from './lib/mentor-data/service';export {requireLiveWriteAccess} from './lib/mentor-data/validation';export {callFlow} from './lib/flow-bridge';`,resolveDir:process.cwd(),loader:'ts',sourcefile:'redeem-gate-test.ts'},bundle:true,write:false,platform:'node',format:'cjs',target:'node24'});
  const serverPath=join(bundleDirectory,'server.cjs');await writeFile(serverPath,server.outputFiles[0].text);impl=require(serverPath);
  const client=await build({stdin:{contents:`
    import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import {RewardRequestForm,StoreView} from './components/mentor/credits';
    import {TestSessionContext} from './components/mentor/session';
    const detail={reward:{id:'41',name:'Synthetic reward',inStock:true,points:40,discountPoints:null,effectivePoints:40,productType:'Voucher',imageUrl:null},options:[]};
    function render(component,enabled,readOnly){const session={mode:'live',user:null,csrfToken:'',readOnly,...(enabled===undefined?{}:{redeemEnabled:enabled})};return renderToStaticMarkup(createElement(TestSessionContext.Provider,{value:{session,loading:false,error:null,refresh:async()=>{},accept:()=>{},logout:async()=>{}}},component));}
    export function renderForm(enabled,readOnly){return render(createElement(RewardRequestForm,{...detail,balance:100,onSaved:()=>{},onReview:async()=>detail}),enabled,readOnly);}
    export function renderStore(enabled){return render(createElement(StoreView),enabled,false);}
  `,resolveDir:process.cwd(),loader:'tsx',sourcefile:'redeem-gate-ui-test.tsx'},bundle:true,write:false,platform:'node',format:'cjs',target:'node24',jsx:'automatic',plugins:[{name:'test-only-component-exports',setup(build){
    build.onLoad({filter:/components\/mentor\/(credits|session)\.tsx$/},async args=>({contents:await readFile(args.path,'utf8')+(args.path.endsWith('credits.tsx')?'\nexport {RewardRequestForm};':'\nexport {SessionContext as TestSessionContext};'),loader:'tsx'}));
    build.onResolve({filter:/^next\/navigation$/},()=>({path:'unused-router',namespace:'redeem-gate-test'}));
    build.onLoad({filter:/.*/,namespace:'redeem-gate-test'},()=>({contents:'export function useRouter(){throw Error("No browser routing is used in this test")}',loader:'js'}));
  }}]});
  const clientPath=join(bundleDirectory,'ui.cjs');await writeFile(clientPath,client.outputFiles[0].text);ui=require(clientPath);
});
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'mentor-redeem-gate-'));
  bindings=impl.createStandaloneBindings({dataDir:directory,migrationsDir:resolve('drizzle'),env:{PORTAL_MODE:'live',MENTOR_LIVE_WRITES_ENABLED:'true',MENTOR_CACHE_ENABLED:'false',APP_ORIGIN:'https://fixture.example.test',MENTOR_BRIDGE_KEY:'synthetic-test-bridge-key-at-least-32-characters',MENTOR_READ_URL:'https://fixture.logic.azure.com/read',MENTOR_PROFILE_URL:'https://fixture.logic.azure.com/profile',MENTOR_REDEEM_URL:'https://fixture.logic.azure.com/redeem'}});
  impl.setBindingsProvider(()=>bindings);calls=[];
});
afterEach(async()=>{bindings?.close();if(directory)await rm(directory,{recursive:true,force:true});});
after(async()=>{if(bundleDirectory)await rm(bundleDirectory,{recursive:true,force:true});});
function hasCode(code:string){return(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;}
async function count(table:string){return Number((await bindings.DB.prepare('SELECT COUNT(*) AS n FROM '+table).first<{n:number}>())?.n);}
const profile={id:17,version:'1',displayName:'Synthetic mentor',preferredName:'Synthetic',communicationEmail:'synthetic@example.test',country:'Australia',phoneNumber:'0400000000',communicationChannels:[],programs:[],stream:'',otherStream:'',wwcc:'WWC12345E',wwccExpiryDate:'2029-01-01',dateOfBirth:null};
const fetcher:typeof fetch=async(_url,init)=>{
  const sent=JSON.parse(String(init?.body));calls.push(sent.operation);
  let data;
  if(sent.operation==='profile.get')data={profile,choices:{communicationChannels:[],programs:[],streams:[]}};
  else if(sent.operation==='profile.update')data={profile:{...profile,country:sent.payload.country,version:'2'}};
  else if(sent.operation==='rewards.get')data={reward:{id:41,name:'Synthetic reward',inStock:true,points:40,discountPoints:null,effectivePoints:40,productType:'Voucher',imageUrl:null},options:[]};
  else if(sent.operation==='redemptions.create')data={redemption:{id:91,requestReference:sent.requestId,rewardId:41,rewardName:'Synthetic reward',optionIds:[],comment:'Synthetic request',points:40,status:'pending',creditState:'not_debited',createdAt:new Date().toISOString()}};
  else if(sent.operation==='redemptions.list')data={items:[],nextCursor:null};
  else throw Error('Unexpected synthetic operation');
  return Response.json({schemaVersion:'1.0',requestId:sent.requestId,ok:true,data});
};

test('explicit false blocks redemption before any claim, audit, resource lock, or Flow call',async()=>{
  bindings.MENTOR_REDEEM_ENABLED='false';
  await assert.rejects(impl.executeMentor(bindings,principal,input,randomUUID(),{fetcher}),error=>hasCode('DRAFT_NOT_CONFIGURED')(error)&&error instanceof Error&&/Reward requests are temporarily unavailable/.test(error.message));
  assert.deepEqual(calls,[]);for(const table of ['mentor_requests','mentor_audit','mentor_resource_locks'])assert.equal(await count(table),0);
  await assert.rejects(impl.callFlow(bindings,principal,input,randomUUID(),undefined,fetcher),hasCode('DRAFT_NOT_CONFIGURED'));
  assert.deepEqual(calls,[]);assert.equal(await count('mentor_audit'),0);
});

test('the independent pause also prevents local demo redemption state changes',async()=>{
  bindings.PORTAL_MODE='demo';bindings.MENTOR_REDEEM_ENABLED='false';
  await assert.rejects(impl.executeMentor(bindings,{...principal,mode:'demo'},input),hasCode('DRAFT_NOT_CONFIGURED'));
  assert.equal(await count('mentor_requests'),0);assert.equal(await count('mentor_demo_state'),0);
});

test('a paused request does not consume its key and succeeds unchanged when enabled',async()=>{
  bindings.MENTOR_REDEEM_ENABLED='false';await assert.rejects(impl.executeMentor(bindings,principal,input,randomUUID(),{fetcher}),hasCode('DRAFT_NOT_CONFIGURED'));
  bindings.MENTOR_REDEEM_ENABLED='true';const response=await impl.executeMentor(bindings,principal,input,randomUUID(),{fetcher});assert.equal(response.ok,true);
  if(response.ok)assert.equal((response.data as OperationResults['redemptions.create']).redemption.points,40);
  assert.equal(await count('mentor_requests'),1);assert.deepEqual(calls,['profile.get','rewards.get','redemptions.create']);
});

test('unset retains redemption behavior and true never bypasses the global write gate',async()=>{
  assert.equal(bindings.MENTOR_REDEEM_ENABLED,undefined);
  assert.equal((await impl.callFlow(bindings,principal,input,randomUUID(),undefined,fetcher)).ok,true);
  bindings.MENTOR_LIVE_WRITES_ENABLED='false';bindings.MENTOR_REDEEM_ENABLED='true';calls=[];
  await assert.rejects(impl.executeMentor(bindings,principal,{...input,idempotencyKey:randomUUID()},randomUUID(),{fetcher}),hasCode('DRAFT_NOT_CONFIGURED'));
  assert.deepEqual(calls,[]);assert.equal(await count('mentor_requests'),0);
});

test('ordinary editing remains governed by the global switch while reward history stays readable',async()=>{
  bindings.MENTOR_REDEEM_ENABLED='false';
  const operations:Operation[]=['attendance.save','reports.week1.save','reports.meetup.save','reports.completion.save','expenses.save','attachments.upload','attachments.delete','profile.update','tickets.create','tickets.update'];
  for(const operation of operations)assert.doesNotThrow(()=>impl.requireLiveWriteAccess(bindings,operation));
  const response=await impl.executeMentor(bindings,principal,{operation:'profile.update',idempotencyKey:randomUUID(),payload:{expectedVersion:'1',country:'New Zealand',phoneNumber:'0400000000',communicationChannels:[],programs:[],stream:'',otherStream:'',under18:false,wwcc:'WWC12345E',wwccExpiryDate:'2029-01-01'}},randomUUID(),{fetcher});assert.equal(response.ok,true);assert.deepEqual(calls,['profile.get','profile.update']);
  bindings.MENTOR_LIVE_WRITES_ENABLED='false';for(const operation of operations)assert.throws(()=>impl.requireLiveWriteAccess(bindings,operation),hasCode('DRAFT_NOT_CONFIGURED'));
  assert.equal((await impl.callFlow(bindings,principal,{operation:'redemptions.list',payload:{}},randomUUID(),undefined,fetcher)).ok,true);
});

test('session publishes the independent capability without changing global readOnly semantics',async()=>{
  for(const [mode,global,flag,readOnly,redeemEnabled]of [['live','true',undefined,false,true],['live','true','false',false,false],['live','false','true',true,true],['live','false','false',true,false],['demo','false',undefined,false,true],['demo','false','false',false,false]]as const){
    bindings.PORTAL_MODE=mode;bindings.MENTOR_LIVE_WRITES_ENABLED=global;bindings.MENTOR_REDEEM_ENABLED=flag;
    const response=await impl.handleAuth(new Request('https://fixture.example.test/api/auth/session'),'session');assert.equal(response.status,401);
    const body=await response.json() as {readOnly:boolean;redeemEnabled:boolean};assert.equal(body.readOnly,readOnly);assert.equal(body.redeemEnabled,redeemEnabled);
  }
});

test('the Credit Store displays maintenance and disables only redemption submission',()=>{
  const form=ui.renderForm(false,false);assert.match(form,/Reward requests are temporarily unavailable/);assert.match(form,/<button\b[^>]*\sdisabled=""[^>]*>Redemption temporarily unavailable<\/button>/);
  const store=ui.renderStore(false);assert.match(store,/Credit Store/);assert.match(store,/Your reward requests/);assert.match(store,/You can still browse rewards and view existing requests/);
  for(const enabled of [undefined,true]){const active=ui.renderForm(enabled,false);assert.doesNotMatch(active,/temporarily unavailable/);assert.match(active,/Request reward · 40 points/);assert.doesNotMatch(active,/<button\b[^>]*\sdisabled=""/);}
  assert.match(ui.renderForm(true,true),/<button\b[^>]*\sdisabled=""/);
});

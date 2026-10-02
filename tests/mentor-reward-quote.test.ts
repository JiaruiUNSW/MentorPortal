import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { ClientRequest, OperationResults } from '../lib/contracts';
import type { Principal } from '../lib/runtime';
import type { StandaloneBindings } from '../lib/standalone';
import type { CatalogSnapshot, PrivateSnapshot } from '../lib/mentor-cache/types';

type Detail = OperationResults['rewards.get'];
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const principal: Principal = { accountId: ACCOUNT, mentorUserId: 17, email: 'synthetic@example.test', displayName: 'Synthetic mentor', role: 'mentor', mode: 'live' };
const other: Principal = { ...principal, accountId: OTHER, mentorUserId: 18, email: 'other@example.test' };
let impl: {
  createStandaloneBindings: typeof import('../lib/standalone').createStandaloneBindings;
  executeMentor: typeof import('../lib/mentor-data/service').executeMentor;
  parseClientRequest: typeof import('../lib/mentor-data/validation').parseClientRequest;
  createDemoState: typeof import('../lib/mentor-data/demo').createDemoState;
  writeDemo: typeof import('../lib/mentor-data/demo').writeDemo;
  captureRewardQuoteBase: typeof import('../lib/mentor-cache/reward-quote').captureRewardQuoteBase;
  mergeRewardQuote: typeof import('../lib/mentor-cache/reward-quote').mergeRewardQuote;
  queueRewardCatalogRefresh: typeof import('../lib/mentor-cache/reward-quote').queueRewardCatalogRefresh;
  snapshotFor: typeof import('../lib/mentor-cache/store').snapshotFor;
  stateFor: typeof import('../lib/mentor-cache/store').stateFor;
  ensureState: typeof import('../lib/mentor-cache/store').ensureState;
  claimLease: typeof import('../lib/mentor-cache/store').claimLease;
  publishSnapshots: typeof import('../lib/mentor-cache/store').publishSnapshots;
  cacheConfig: typeof import('../lib/mentor-cache/config').cacheConfig;
  clearVersionConflictRetry: typeof import('../components/mentor/hooks').clearVersionConflictRetry;
};
let directory: string, bindings: StandaloneBindings, fresh: Detail;
let bundleDirectory: string | undefined;
let calls: { operation: string; payload: Record<string, unknown> }[], charges: number[];
let onFreshRead: (() => Promise<void>) | undefined;

function detail(id = '41', points = 40): Detail {
  return { reward: { id, name: `Synthetic reward ${id}`, inStock: true, points, discountPoints: null, effectivePoints: points, productType: 'Voucher', imageUrl: null }, options: [] };
}
function profile(actor = 17): OperationResults['profile.get'] {
  return { profile: { id: String(actor), version: '1', displayName: 'Synthetic mentor', preferredName: 'Synthetic', communicationEmail: 'synthetic@example.test', country: 'Australia', phoneNumber: '0400000000', communicationChannels: [], programs: [], stream: '', otherStream: '', wwcc: 'SYNTHETIC', wwccExpiryDate: null, dateOfBirth: null }, choices: { communicationChannels: [], programs: [], streams: [] } };
}
function privateData(): PrivateSnapshot {
  const balance = { balance: 500, totalCredit: 500, reserved: 0, roundCount: 1, milestone: 600, milestoneRound: 2 };
  const p = profile();
  return { schemaVersion: 1, bootstrap: { mentor: { id: '17', displayName: 'Synthetic mentor', preferredName: 'Synthetic', communicationEmail: 'synthetic@example.test' }, balance, groups: [], tasks: [], mode: 'live', previewLabel: null }, profile: p, balance, groups: [], transactions: [], tickets: [], redemptions: [] };
}
function hasCode(code: string) { return (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function request(expectedPoints: number, key = randomUUID()): ClientRequest<'redemptions.create'> {
  return { operation: 'redemptions.create', payload: { rewardId: '41', optionIds: [], comment: 'Synthetic request', expectedPoints }, idempotencyKey: key };
}

before(async () => {
  const bundle = await build({ stdin: { contents: `
    export {createStandaloneBindings} from './lib/standalone';
    export {executeMentor} from './lib/mentor-data/service';
    export {parseClientRequest} from './lib/mentor-data/validation';
    export {createDemoState,writeDemo} from './lib/mentor-data/demo';
    export {captureRewardQuoteBase,mergeRewardQuote,queueRewardCatalogRefresh} from './lib/mentor-cache/reward-quote';
    export {snapshotFor,stateFor,ensureState,claimLease,publishSnapshots} from './lib/mentor-cache/store';
    export {cacheConfig} from './lib/mentor-cache/config';
    export {clearVersionConflictRetry} from './components/mentor/hooks';
  `, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'reward-quote-test.ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24', plugins: [{ name: 'unused-router-for-pure-retry-test', setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next/navigation', namespace: 'quote-test' }));
    build.onLoad({ filter: /.*/, namespace: 'quote-test' }, () => ({ contents: 'export function useRouter(){throw new Error("No browser is used in this test")}', loader: 'js' }));
  } }] });
  bundleDirectory = await mkdtemp(join(tmpdir(), 'mentor-quote-module-'));
  const modulePath = join(bundleDirectory, 'quote-test.mjs');
  await writeFile(modulePath, bundle.outputFiles[0].text, { mode: 0o600 });
  impl = await import(pathToFileURL(modulePath).href);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mentor-quote-test-'));
  bindings = impl.createStandaloneBindings({ dataDir: directory, migrationsDir: resolve('drizzle'), env: { PORTAL_MODE: 'live', MENTOR_LIVE_WRITES_ENABLED: 'true', MENTOR_CACHE_ENABLED: 'true', MENTOR_SYNC_ALLOWED_USER_IDS: '17,18', MENTOR_BRIDGE_KEY: 'synthetic-quote-key-with-at-least-32-characters', MENTOR_READ_URL: 'https://quote-fixture.logic.azure.com/read', MENTOR_REDEEM_URL: 'https://quote-fixture.logic.azure.com/redeem' } });
  calls = []; charges = []; fresh = detail(); onFreshRead = undefined;
  const timestamp = Date.now() - 3_600_000;
  for (const actor of [principal, other]) {
    await bindings.DB.prepare("INSERT INTO auth_accounts (id,email,display_name,mentor_user_id,role,mode,status,created_at) VALUES (?,?,?,?,'mentor','live','active',?)").bind(actor.accountId, actor.email, actor.displayName, actor.mentorUserId, timestamp).run();
    await impl.ensureState(bindings.DB, actor, timestamp);
    await bindings.DB.prepare("UPDATE mentor_cache_sync_state SET authorization_state='authorized',invalidation_version=7,next_private_sync_at=?,next_catalog_sync_at=?,next_redemption_sync_at=? WHERE account_id=? AND mentor_user_id=?").bind(timestamp + 86_400_000, timestamp + 172_800_000, timestamp + 100_000_000, actor.accountId, actor.mentorUserId).run();
    for (const [namespace, value, ttl] of [['private', privateData(), 86_400_000], ['catalog', { schemaVersion: 1, rewards: [detail(), detail('42', 15)] }, 172_800_000]] as const) {
      await bindings.DB.prepare('INSERT INTO mentor_cache_snapshots (account_id,mentor_user_id,namespace,generation,snapshot_json,synced_at,refresh_after,hard_expires_at,invalidation_version) VALUES (?,?,?,?,?,?,?,?,7)').bind(actor.accountId, actor.mentorUserId, namespace, randomUUID().replaceAll('-', ''), JSON.stringify(value), timestamp, timestamp + ttl, timestamp + 259_200_000).run();
    }
  }
});
afterEach(async () => { bindings?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
after(async () => { if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true }); });

const sourceFetch: typeof fetch = async (_url, init) => {
  const input = JSON.parse(String(init?.body));
  calls.push({ operation: input.operation, payload: input.payload });
  const envelope = { schemaVersion: '1.0', requestId: input.requestId };
  if (input.operation === 'profile.get') {
    const value = profile(input.actor.userId);
    return Response.json({ ...envelope, ok: true, data: { ...value, profile: { ...value.profile, id: input.actor.userId } } });
  }
  if (input.operation === 'rewards.get') {
    const captured = structuredClone(fresh);
    await onFreshRead?.();
    return Response.json({ ...envelope, ok: true, data: { reward: { ...captured.reward, id: Number(captured.reward.id) }, options: captured.options.map(option => ({ ...option, id: Number(option.id), rewardId: Number(option.rewardId) })) } });
  }
  if (input.operation === 'redemptions.create') {
    // Models the independently required native Flow final-intake guard and source-derived charge.
    if (input.payload.expectedPoints !== fresh.reward.effectivePoints) return Response.json({ ...envelope, ok: false, error: { code: 'VERSION_CONFLICT', message: 'Synthetic quote changed', retryable: false } }, { status: 409 });
    charges.push(fresh.reward.effectivePoints);
    return Response.json({ ...envelope, ok: true, data: { redemption: { id: 91, requestReference: 'SYNTHETIC-QUOTE', rewardId: 41, rewardName: fresh.reward.name, optionIds: input.payload.optionIds, comment: input.payload.comment, points: fresh.reward.effectivePoints, status: 'pending', creditState: 'not_debited', createdAt: new Date().toISOString() } } });
  }
  throw new Error(`Unexpected synthetic operation: ${input.operation}`);
};
function execute(input: ClientRequest<'redemptions.create'>) { return impl.executeMentor(bindings, principal, input, randomUUID(), { fetcher: sourceFetch }); }
async function catalog(actor = principal) { return (await impl.snapshotFor(bindings.DB, actor, 'catalog'))!; }

for (const expectedPoints of [undefined, NaN, Infinity, -1, '40']) test(`invalid quote ${String(expectedPoints)} is rejected by the request boundary`, () => {
  assert.throws(() => impl.parseClientRequest({ ...request(40), payload: { rewardId: '41', optionIds: [], comment: '', expectedPoints } }), hasCode('VALIDATION_ERROR'));
  assert.equal(calls.length, 0);
});

test('same-price quote dispatches once and source data determines the acknowledged points', async () => {
  fresh.reward.points = 100; fresh.reward.discountPoints = 40;
  const response = await execute(request(40));
  assert.ok(response.ok);
  if (response.ok) assert.equal((response.data as OperationResults['redemptions.create']).redemption.points, 40);
  assert.deepEqual(charges, [40]);
  assert.deepEqual(calls.map(call => call.operation), ['profile.get', 'rewards.get', 'redemptions.create']);
  const sent = calls.at(-1)!.payload;
  assert.equal(sent.expectedPoints, 40);
  assert.equal('points' in sent, false, 'The browser quote must never be forwarded as a debit field');
});

test('a stale quote never dispatches the business write and changes only that account reward/options', async () => {
  const before = await catalog(), privateBefore = await impl.snapshotFor(bindings.DB, principal, 'private'), otherBefore = await catalog(other), stateBefore = (await impl.stateFor(bindings.DB, principal))!;
  fresh = detail('41', 75);
  fresh.options = [{ id: '61', rewardId: '41', label: 'Blue', type: 'Color', inStock: true, extraCost: 0 }];
  await assert.rejects(execute(request(40)), hasCode('VERSION_CONFLICT'));
  assert.deepEqual(charges, []);
  assert.equal(calls.some(call => call.operation === 'redemptions.create'), false);
  const after = await catalog(), value = JSON.parse(after.snapshot_json) as CatalogSnapshot;
  assert.deepEqual(value.rewards[0], fresh);
  assert.deepEqual(value.rewards[1], JSON.parse(before.snapshot_json).rewards[1]);
  for (const field of ['synced_at', 'refresh_after', 'hard_expires_at', 'invalidation_version'] as const) assert.equal(after[field], before[field]);
  assert.notEqual(after.generation, before.generation);
  assert.deepEqual(await impl.snapshotFor(bindings.DB, principal, 'private'), privateBefore);
  assert.deepEqual(await catalog(other), otherBefore);
  const stateAfter = (await impl.stateFor(bindings.DB, principal))!;
  for (const field of ['next_private_sync_at', 'next_catalog_sync_at', 'next_redemption_sync_at', 'invalidation_version'] as const) assert.equal(stateAfter[field], stateBefore[field]);
});

for (const unavailable of ['reward', 'missing-option', 'option-stock', 'option-cost'] as const) test(`fresh ${unavailable} changes require review without a business dispatch`, async () => {
  const input = request(40);
  if (unavailable === 'reward') fresh.reward.inStock = false;
  else {
    input.payload.optionIds = ['61'];
    if (unavailable !== 'missing-option') fresh.options = [{ id: '61', rewardId: '41', label: 'Blue', type: 'Color', inStock: unavailable !== 'option-stock', extraCost: unavailable === 'option-cost' ? 5 : 0 }];
  }
  await assert.rejects(execute(input), hasCode('VERSION_CONFLICT'));
  assert.deepEqual(charges, []);
  assert.equal(calls.some(call => call.operation === 'redemptions.create'), false);
  assert.deepEqual((JSON.parse((await catalog()).snapshot_json) as CatalogSnapshot).rewards[0], fresh);
});

test('a mismatched source reward ID is refused before comparing or merging', async () => {
  const before = await catalog(); fresh = detail('42', 75);
  await assert.rejects(execute(request(40)), hasCode('OWNERSHIP_DENIED'));
  assert.equal(calls.some(call => call.operation === 'redemptions.create'), false);
  assert.deepEqual(await catalog(), before);
});

test('concurrent catalog publication wins; conflict queues only catalog without overwriting newer data', async () => {
  const before = await catalog(), stateBefore = (await impl.stateFor(bindings.DB, principal))!;
  const newer = { schemaVersion: 1, rewards: [detail('41', 99), detail('42', 16)] };
  fresh = detail('41', 75);
  onFreshRead = async () => { await bindings.DB.prepare("UPDATE mentor_cache_snapshots SET generation='newer-generation',snapshot_json=? WHERE account_id=? AND mentor_user_id=? AND namespace='catalog'").bind(JSON.stringify(newer), ACCOUNT, 17).run(); };
  await assert.rejects(execute(request(40)), hasCode('VERSION_CONFLICT'));
  const after = await catalog(), stateAfter = (await impl.stateFor(bindings.DB, principal))!;
  assert.deepEqual(JSON.parse(after.snapshot_json), newer);
  assert.equal(after.generation, 'newer-generation');
  for (const field of ['synced_at', 'refresh_after', 'hard_expires_at'] as const) assert.equal(after[field], before[field]);
  assert.equal(stateAfter.next_private_sync_at, stateBefore.next_private_sync_at);
  assert.equal(stateAfter.next_redemption_sync_at, stateBefore.next_redemption_sync_at);
  assert.ok(stateAfter.next_catalog_sync_at <= Date.now());
});

test('quote merge fences a previously running sync lease without promoting catalog freshness', async () => {
  const lease = (await impl.claimLease(bindings.DB, principal, Date.now(), 60_000))!;
  const base = (await impl.captureRewardQuoteBase(bindings, principal))!;
  assert.equal(await impl.mergeRewardQuote(bindings, principal, base, detail('41', 75)), true);
  assert.equal(await impl.publishSnapshots(bindings.DB, principal, lease, { catalog: JSON.parse(base.row.snapshot_json) }, impl.cacheConfig(bindings), Date.now()), false);
  assert.equal((JSON.parse((await catalog()).snapshot_json) as CatalogSnapshot).rewards[0].reward.effectivePoints, 75);
});

for (const change of ['disabled', 'remapped'] as const) test(`${change} identities cannot receive a quote cache update`, async () => {
  const before = await catalog(), base = (await impl.captureRewardQuoteBase(bindings, principal))!;
  const sql = change === 'disabled' ? "UPDATE auth_accounts SET status='disabled' WHERE id=?" : "UPDATE auth_accounts SET mentor_user_id=19 WHERE id=?";
  await bindings.DB.prepare(sql).bind(ACCOUNT).run();
  await assert.rejects(impl.mergeRewardQuote(bindings, principal, base, detail('41', 75)), hasCode('MENTOR_FORBIDDEN'));
  assert.deepEqual(await catalog(), before);
});

test('a successful quoted request replays the old result after source price changes without fresh repricing', async () => {
  const input = request(40);
  const first = await execute(input); assert.ok(first.ok);
  fresh = detail('41', 90);
  const before = calls.length;
  const replay = await execute(input);
  assert.ok(replay.ok);
  assert.equal(replay.replayed, true);
  if (replay.ok) assert.equal((replay.data as OperationResults['redemptions.create']).redemption.points, 40);
  assert.deepEqual(calls.slice(before).map(call => call.operation), ['profile.get']);
  assert.deepEqual(charges, [40]);
});

test('the native final-intake quote guard closes a price change after backend preflight', async () => {
  onFreshRead = async () => { fresh = detail('41', 80); };
  await assert.rejects(execute(request(40)), hasCode('VERSION_CONFLICT'));
  assert.equal(calls.filter(call => call.operation === 'redemptions.create').length, 1);
  assert.deepEqual(charges, []);
});

test('demo stale quote cannot reserve credit or create a redemption', () => {
  const demo = impl.createDemoState({ ...principal, mode: 'demo' });
  const reward = demo.rewards[0], before = structuredClone(demo);
  const input = { ...request(reward.effectivePoints + 1), payload: { rewardId: reward.id, optionIds: [], comment: '', expectedPoints: reward.effectivePoints + 1 } } as ClientRequest<'redemptions.create'>;
  assert.throws(() => impl.writeDemo(demo, input, { requestId: randomUUID(), now: new Date().toISOString(), files: [] }), hasCode('VERSION_CONFLICT'));
  assert.deepEqual(demo, before);
});

test('retry reset retains non-conflict, pending, successful and another intent keys', () => {
  const keys = new Map([['intent', 'original-key'], ['other', 'other-key']]);
  for (const code of ['PARTIAL_WRITE', 'UPSTREAM_UNAVAILABLE', 'REQUEST_IN_PROGRESS', 'RESPONSE_UNCONFIRMED', undefined]) {
    assert.equal(impl.clearVersionConflictRetry(keys, { signature: 'intent', key: 'original-key', code }, false), false);
    assert.equal(keys.get('intent'), 'original-key');
  }
  assert.equal(impl.clearVersionConflictRetry(keys, { signature: 'intent', key: 'original-key', code: 'VERSION_CONFLICT' }, true), false);
  assert.equal(impl.clearVersionConflictRetry(keys, null, false), false);
  assert.equal(impl.clearVersionConflictRetry(keys, { signature: 'intent', key: 'older-key', code: 'VERSION_CONFLICT' }, false), false);
  assert.equal(keys.get('intent'), 'original-key');
  assert.equal(impl.clearVersionConflictRetry(keys, { signature: 'intent', key: 'original-key', code: 'VERSION_CONFLICT' }, false), true);
  assert.equal(keys.has('intent'), false);
  assert.equal(keys.get('other'), 'other-key');
});


test('a zero-point source quote is valid and is not treated as a missing quote', async () => {
  fresh = detail('41', 0);
  const response = await execute(impl.parseClientRequest(request(0)) as ClientRequest<'redemptions.create'>);
  assert.ok(response.ok);
  assert.deepEqual(charges, [0]);
});

test('fresh reward preflight shares the write budget and an expired preflight retains a safe same-key retry', async () => {
  const input = request(40);
  onFreshRead = async () => { await new Promise(resolve => setTimeout(resolve, 300)); };
  await assert.rejects(impl.executeMentor(bindings, principal, input, randomUUID(), { fetcher: sourceFetch, requestBudgetMs: 200, claimLeaseMs: 600, heartbeatMs: 50 }), hasCode('UPSTREAM_UNAVAILABLE'));
  assert.equal(calls.some(call => call.operation === 'redemptions.create'), false);
  assert.equal(calls.some(call => call.operation === 'rewards.get'), true);
  const claim = await bindings.DB.prepare('SELECT state,request_id FROM mentor_requests WHERE idempotency_key=?').bind(input.idempotencyKey).first<{ state: string; request_id: string }>();
  assert.equal(claim?.state, 'preflight_retry');
  await assert.rejects(execute(input), hasCode('REQUEST_IN_PROGRESS'));
  // Advance only this synthetic claim past the existing retry backoff.
  await bindings.DB.prepare('UPDATE mentor_requests SET lease_expires_at=0 WHERE idempotency_key=?').bind(input.idempotencyKey).run();
  onFreshRead = undefined;
  const retried = await execute(input);
  assert.ok(retried.ok);
  assert.equal(retried.requestId, claim?.request_id);
  assert.deepEqual(charges, [40]);
});

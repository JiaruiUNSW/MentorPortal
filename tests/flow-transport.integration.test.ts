import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const ORIGINAL_ORIGIN = 'https://transport-fixture.logic.azure.com';
const REDIRECT_ORIGIN = 'https://untrusted-redirect.invalid';
const BRIDGE_KEY = 'synthetic-only-transport-bridge-key-32-characters';
const BALANCE = { balance: 80, totalCredit: 120, roundCount: 2, milestone: 200, milestoneRound: 5 };
const redirects = [301, 302, 303, 307, 308] as const;

interface ObservedRequest {
  origin: string;
  path: string;
  method: string;
  bridgeKey: string | null;
  requestId: string | null;
  payload: Record<string, unknown> | null;
}
interface ResultEnvelope {
  schemaVersion: '1.0';
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; retryable: boolean };
}

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare['getD1Database']>>;
const observed: ObservedRequest[] = [];

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { callFlow } from './lib/flow-bridge';
        import { parseClientRequest } from './lib/mentor-data/validation';
        import { errorEnvelope, safeError } from './lib/mentor-data/errors';
        export default { async fetch(request, env) {
          const status = new URL(request.url).searchParams.get('status') || '200';
          const requestId = crypto.randomUUID();
          const endpoint = ${JSON.stringify(ORIGINAL_ORIGIN)} + '/invoke?status=' + status;
          const principal = {
            accountId: '00000000-0000-4000-8000-000000000001',
            email: 'transport-fixture@example.test', displayName: 'Synthetic transport test',
            mentorUserId: 1, role: 'mentor', mode: 'live'
          };
          const bindings = {
            ...env, PORTAL_MODE: 'live', MENTOR_LIVE_WRITES_ENABLED: 'true',
            MENTOR_BRIDGE_KEY: ${JSON.stringify(BRIDGE_KEY)},
            MENTOR_READ_URL: endpoint, MENTOR_TICKET_URL: endpoint
          };
          try {
            const operation = parseClientRequest(await request.json());
            // Deliberately omit the fetcher argument: exercise workerd's native fetch.
            const result = await callFlow(bindings, principal, operation, requestId);
            return Response.json(result);
          } catch (error) {
            const safe = safeError(error);
            return Response.json(errorEnvelope(requestId, safe), { status: safe.status });
          }
        }};
      `,
      resolveDir: process.cwd(),
      sourcefile: 'flow-transport-test-worker.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-05-22',
    d1Databases: ['DB'],
    // All outbound hosts are intercepted here. No request can reach a real Flow.
    outboundService: async (request) => {
      const url = new URL(request.url);
      const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
      observed.push({
        origin: url.origin, path: url.pathname, method: request.method,
        bridgeKey: request.headers.get('x-mentor-bridge-key'),
        requestId: request.headers.get('x-mentor-request-id'), payload,
      });
      if (url.origin !== ORIGINAL_ORIGIN) {
        return new Response('Synthetic redirect target: reaching this host is a test failure.', { status: 200 });
      }
      const status = Number(url.searchParams.get('status') || 200);
      if ((redirects as readonly number[]).includes(status)) {
        return new Response('Synthetic redirect body is deliberately not a Flow envelope.', {
          status,
          headers: { Location: `${REDIRECT_ORIGIN}/capture`, 'Content-Type': 'text/plain' },
        });
      }
      return Response.json({
        schemaVersion: '1.0', requestId: payload?.requestId, ok: true, data: BALANCE,
      });
    },
  });
  database = await runtime.getD1Database('DB');
  const migrations = (await readdir('drizzle')).filter((path) => path.endsWith('.sql')).sort();
  assert.ok(migrations.length > 0, 'Production D1 migrations are required for this transport test.');
  for (const migration of migrations) {
    const sql = await readFile(`drizzle/${migration}`, 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
});

after(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  observed.length = 0;
  await database.prepare('DELETE FROM mentor_audit').run();
});

async function invoke(status: number, operation: 'balance.get' | 'tickets.create') {
  const response = await runtime.dispatchFetch(`https://local-transport-test.invalid/invoke?status=${status}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(operation === 'balance.get'
      ? { operation, payload: {} }
      : { operation, payload: { title: 'Synthetic ticket', description: 'Transport-only fixture' }, idempotencyKey: randomUUID() }),
  });
  return { response, body: await response.json() as ResultEnvelope };
}

function assertSingleOriginalRequest() {
  assert.equal(observed.length, 1, 'Native fetch must contact only the original endpoint once.');
  assert.equal(observed[0].origin, ORIGINAL_ORIGIN);
  assert.equal(observed[0].path, '/invoke');
  assert.equal(observed[0].method, 'POST');
  assert.equal(observed[0].bridgeKey, BRIDGE_KEY);
  assert.equal(observed.filter((request) => request.origin === REDIRECT_ORIGIN).length, 0,
    'A redirect must never receive the bridge credential or any forwarded request.');
}

test('default native fetch reaches the Flow endpoint and validates a successful balance DTO', async () => {
  const { response, body } = await invoke(200, 'balance.get');
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.schemaVersion, '1.0');
  assert.deepEqual(body.data, { ...BALANCE, reserved: 0 });
  assertSingleOriginalRequest();
  assert.equal(body.requestId, observed[0].requestId);
  assert.equal(observed[0].payload?.operation, 'balance.get');
  const count = await database.prepare("SELECT count(*) AS n FROM mentor_audit WHERE outcome='live_dispatch'").first<{ n: number }>();
  assert.equal(count?.n, 1, 'The native transport runs after a real D1 dispatch audit.');
});

for (const status of redirects) {
  test(`read HTTP ${status} is rejected without following Location or forwarding the bridge key`, async () => {
    const { response, body } = await invoke(status, 'balance.get');
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(body.data, undefined);
    assertSingleOriginalRequest();
  });
  test(`write HTTP ${status} has an uncertain outcome and is never redirected or retried`, async () => {
    const { response, body } = await invoke(status, 'tickets.create');
    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'PARTIAL_WRITE');
    assert.equal(body.error?.retryable, false);
    assert.equal(body.data, undefined);
    assertSingleOriginalRequest();
  });
}

import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ORIGIN = "https://worker-limits.test";
const SETUP_TOKEN = randomBytes(32).toString("base64url");
const PASSWORD = "A synthetic test passphrase 914!";
const UNICODE_PASSWORD = "研究邀请账户🔐".repeat(5) + " passphrase 914!";
const CAP_MESSAGE = "Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).";
type FailureMode = "cap" | "operation-error" | "other-not-supported" | "requested-mismatch";
let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { hashPassword, verifyPassword } from './lib/auth/crypto';
        import { GET as session } from './app/api/auth/session/route';
        import { POST as setup } from './app/api/auth/setup/route';
        import { POST as login } from './app/api/auth/login/route';
        import { POST as logout } from './app/api/auth/logout/route';
        import { POST as activate } from './app/api/auth/activate/route';
        import { GET as accounts } from './app/api/admin/accounts/route';
        import { POST as invite } from './app/api/admin/invites/route';
        const routes = {
          'GET /api/auth/session': session,
          'POST /api/auth/setup': setup,
          'POST /api/auth/login': login,
          'POST /api/auth/logout': logout,
          'POST /api/auth/activate': activate,
          'GET /api/admin/accounts': accounts,
          'POST /api/admin/invites': invite,
        };
        export default { async fetch(request) {
          const subtle = crypto.subtle;
          const descriptor = Object.getOwnPropertyDescriptor(subtle, 'deriveBits');
          const nativeDeriveBits = subtle.deriveBits.bind(subtle);
          const mode = request.headers.get('x-test-crypto-error') || 'cap';
          let rejectedCalls = 0;
          Object.defineProperty(subtle, 'deriveBits', { configurable: true, value: async (...args) => {
            const algorithm = args[0];
            if (algorithm && typeof algorithm === 'object' && algorithm.name === 'PBKDF2' && algorithm.iterations > 100000) {
              rejectedCalls++;
              const message = 'Pbkdf2 failed: iteration counts above 100000 are not supported (requested ' + algorithm.iterations + ').';
              if (mode === 'operation-error') throw new DOMException(message, 'OperationError');
              if (mode === 'other-not-supported') throw new DOMException('The requested digest algorithm is unsupported.', 'NotSupportedError');
              if (mode === 'requested-mismatch') throw new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600001).', 'NotSupportedError');
              throw new DOMException(message, 'NotSupportedError');
            }
            return nativeDeriveBits(...args);
          }});
          try {
            let response;
            const path = new URL(request.url).pathname;
            if (path === '/') {
              // This root belongs only to the isolated test Worker, not the application's router.
              const input = await request.json();
              try {
                const result = input.operation === 'verify'
                  ? { verified: await verifyPassword(input.password, input.hash) }
                  : { hash: await hashPassword(input.password) };
                response = Response.json(result);
              } catch (error) {
                response = Response.json({ exception: { name: error.name, message: error.message } }, { status: 500 });
              }
            } else {
              const handler = routes[request.method + ' ' + path];
              response = handler ? await handler(request) : new Response('Not found', { status: 404 });
            }
            response.headers.set('X-Test-Native-Rejections', String(rejectedCalls));
            return response;
          } finally {
            if (descriptor) Object.defineProperty(subtle, 'deriveBits', descriptor);
            else delete subtle.deriveBits;
          }
        }};
      `,
      resolveDir: process.cwd(),
      sourcefile: "auth-worker-limits-harness.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-05-22",
    d1Databases: ["DB"],
    bindings: { PORTAL_MODE: "live", APP_ORIGIN: ORIGIN, SETUP_TOKEN },
  });
  database = await runtime.getD1Database("DB");
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.length > 0, "Generate the production D1 migrations before testing.");
  for (const migration of migrations) {
    const sql = await readFile(`drizzle/${migration}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
});

after(async () => { await runtime?.dispose(); });

beforeEach(async () => {
  await database.batch(["auth_sessions", "auth_invites", "auth_setup", "auth_accounts", "auth_rate_limits"].map((table) => database.prepare(`DELETE FROM ${table}`)));
});

interface AuthBody {
  user?: { accountId: string; email: string; role: string; mentorUserId: number } | null;
  csrfToken?: string;
  error?: { code: string; message: string };
  exception?: { name: string; message: string };
  activationUrl?: string;
  items?: Array<{ accountId: string }>;
  hash?: string;
  verified?: boolean;
}

class Client {
  private readonly cookies = new Map<string, string>();
  private csrf = "";

  async request(path: string, body?: unknown, failureMode: FailureMode = "cap") {
    const response = await runtime.dispatchFetch(`${ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        "x-test-crypto-error": failureMode,
        ...(body === undefined ? {} : { origin: ORIGIN, "content-type": "application/json", "x-csrf-token": this.csrf }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const result = await response.json() as AuthBody;
    if (result.csrfToken) this.csrf = result.csrfToken;
    return { response, body: result, nativeRejections: Number(response.headers.get("x-test-native-rejections")) };
  }

  seed() { return this.request("/api/auth/session"); }
}

function assertStandardHash(storedHash: string, password: string): void {
  const parts = storedHash.split("$");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "pbkdf2-sha256");
  assert.equal(parts[1], "600000");
  const salt = Buffer.from(parts[2], "base64url");
  assert.equal(salt.byteLength, 24);
  assert.equal(Buffer.from(parts[3], "base64url").byteLength, 32);
  assert.equal(parts[3], pbkdf2Sync(Buffer.from(password, "utf8"), salt, 600_000, 32, "sha256").toString("base64url"));
}

async function persistentCounts() {
  return database.prepare(`SELECT
    (SELECT COUNT(*) FROM auth_accounts) AS accounts,
    (SELECT COUNT(*) FROM auth_sessions) AS sessions,
    (SELECT COUNT(*) FROM auth_setup) AS setup,
    (SELECT COUNT(*) FROM auth_invites) AS invites`).first<{ accounts: number; sessions: number; setup: number; invites: number }>();
}

test("forced Workers cap preserves standard 600000-round hashes for Unicode passwords exceeding the HMAC block size", async () => {
  assert.ok(Buffer.byteLength(UNICODE_PASSWORD, "utf8") > 64);
  assert.ok([...UNICODE_PASSWORD].length <= 128);
  const result = await new Client().request("/", { operation: "hash", password: UNICODE_PASSWORD });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.nativeRejections, 1, "The test must reject native PBKDF2 before accepting the fallback output.");
  assert.ok(result.body.hash);
  assertStandardHash(result.body.hash, UNICODE_PASSWORD);
});

test("fallback verifies a pre-existing independently generated hash and returns false for the wrong password", async () => {
  const salt = Buffer.from(Array.from({ length: 24 }, (_, index) => index));
  const digest = pbkdf2Sync(Buffer.from(PASSWORD, "utf8"), salt, 600_000, 32, "sha256");
  const legacyHash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${digest.toString("base64url")}`;
  const client = new Client();
  const valid = await client.request("/", { operation: "verify", password: PASSWORD, hash: legacyHash });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.nativeRejections, 1);
  assert.equal(valid.body.verified, true);
  const invalid = await client.request("/", { operation: "verify", password: "A different synthetic passphrase 915!", hash: legacyHash });
  assert.equal(invalid.response.status, 200);
  assert.equal(invalid.nativeRejections, 1);
  assert.equal(invalid.body.verified, false);
});

test("synthetic unknown-account login completes the capped KDF and returns 401 without creating auth records", async () => {
  const client = new Client();
  assert.equal((await client.seed()).response.status, 401);
  const beforeCounts = await persistentCounts();
  const result = await client.request("/api/auth/login", { email: `probe-${randomUUID()}@example.invalid`, password: PASSWORD });
  assert.equal(result.response.status, 401, JSON.stringify(result.body));
  assert.equal(result.body.error?.code, "INVALID_CREDENTIALS");
  assert.equal(result.nativeRejections, 1);
  assert.deepEqual(await persistentCounts(), beforeCounts);
  assert.equal(result.response.headers.getSetCookie().length, 0);
  const rate = await database.prepare("SELECT SUM(hits) AS hits FROM auth_rate_limits").first<{ hits: number }>();
  assert.equal(rate!.hits, 2, "Only the source and synthetic-email rate counters should advance.");
});

test("real auth routes complete setup, administrator invitation, activation and login under the Worker cap", async () => {
  const admin = new Client();
  await admin.seed();
  const setup = await admin.request("/api/auth/setup", { setupToken: SETUP_TOKEN, email: "admin@worker-limits.invalid", displayName: "Test Administrator", password: PASSWORD });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  assert.equal(setup.nativeRejections, 1);
  assert.equal(setup.body.user?.role, "admin");
  assert.equal(setup.body.user?.mentorUserId, 0);
  assert.equal((await admin.request("/api/admin/accounts")).response.status, 200);
  const invitation = await admin.request("/api/admin/invites", { email: "mentor@worker-limits.invalid", displayName: "Invited Test Mentor", mentorUserId: 73 });
  assert.equal(invitation.response.status, 201, JSON.stringify(invitation.body));
  assert.ok(invitation.body.activationUrl);
  const activationUrl = new URL(invitation.body.activationUrl);
  assert.equal(activationUrl.search, "");
  const token = new URLSearchParams(activationUrl.hash.slice(1)).get("token");
  assert.ok(token);

  const mentor = new Client();
  await mentor.seed();
  const activation = await mentor.request("/api/auth/activate", { token, password: UNICODE_PASSWORD });
  assert.equal(activation.response.status, 201, JSON.stringify(activation.body));
  assert.equal(activation.nativeRejections, 1);
  assert.equal(activation.body.user?.mentorUserId, 73);
  assert.equal(activation.body.user?.role, "mentor");
  const account = await database.prepare("SELECT password_hash FROM auth_accounts WHERE id = ?").bind(activation.body.user!.accountId).first<{ password_hash: string }>();
  assert.ok(account?.password_hash);
  assertStandardHash(account.password_hash, UNICODE_PASSWORD);
  assert.equal((await mentor.request("/api/auth/logout", {})).response.status, 200);
  const login = await mentor.request("/api/auth/login", { email: "mentor@worker-limits.invalid", password: UNICODE_PASSWORD });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  assert.equal(login.nativeRejections, 1);
  assert.equal(login.body.user?.accountId, activation.body.user?.accountId);
  assert.equal((await mentor.seed()).response.status, 200);
  assert.deepEqual(await persistentCounts(), { accounts: 2, sessions: 3, setup: 1, invites: 1 });
});

for (const scenario of [
  { mode: "operation-error", name: "OperationError", message: CAP_MESSAGE },
  { mode: "other-not-supported", name: "NotSupportedError", message: "The requested digest algorithm is unsupported." },
  { mode: "requested-mismatch", name: "NotSupportedError", message: CAP_MESSAGE.replace("requested 600000", "requested 600001") },
] satisfies Array<{ mode: FailureMode; name: string; message: string }>) {
  test(`does not fall back for ${scenario.mode}`, async () => {
    const result = await new Client().request("/", { operation: "hash", password: PASSWORD }, scenario.mode);
    assert.equal(result.nativeRejections, 1);
    assert.equal(result.response.status, 500, "An unrelated cryptographic error must propagate instead of silently selecting another implementation.");
    assert.deepEqual(result.body.exception, { name: scenario.name, message: scenario.message });
    assert.equal(result.body.hash, undefined);
    assert.deepEqual(await persistentCounts(), { accounts: 0, sessions: 0, setup: 0, invites: 0 });
  });
}

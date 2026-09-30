import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ORIGIN = "https://portal.test";
const SETUP_SECRET = randomBytes(32).toString("base64url");
const PASSWORD = "A long test-only passphrase 739!";
let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { AuthService } from './lib/auth/service';
        import { hashPassword, verifyPassword } from './lib/auth/crypto';
        const routes = {
          'GET /api/auth/session':'session', 'POST /api/auth/login':'login',
          'POST /api/auth/demo':'demo', 'POST /api/auth/activate':'activate',
          'POST /api/auth/logout':'logout', 'POST /api/auth/setup':'setup',
          'GET /api/admin/accounts':'accounts', 'GET /api/admin/invites':'invites',
          'POST /api/admin/invites':'createInvite', 'POST /api/admin/invites/revoke':'revokeInvite',
          'POST /api/admin/accounts/revoke':'revokeAccount'
        };
        export default { async fetch(request, env) {
          const url = new URL(request.url);
          const mode = url.pathname.startsWith('/live/') ? 'live' : 'demo';
          const path = '/' + url.pathname.split('/').slice(2).join('/');
          const now = request.headers.get('x-test-now');
          const appOrigin = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.origin : '${ORIGIN}';
          const service = new AuthService(env.DB, {mode, appOrigin, setupToken:env.SETUP_TOKEN, now:now ? () => Number(now) : undefined});
          try {
            if (path === '/test/password') {
              const body = await request.json();
              return service.json(body.hash ? {verified:await verifyPassword(body.password,body.hash)} : {hash:await hashPassword(body.password)});
            }
            const action = routes[request.method+' '+path];
            if (!action) return new Response('Not found',{status:404});
            return await service[action](request);
          } catch (error) { return service.errorResponse(error); }
        }};
      `,
      resolveDir: process.cwd(),
      sourcefile: "auth-test-worker.ts",
      loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-05-22", d1Databases: ["DB"], bindings: { SETUP_TOKEN: SETUP_SECRET } });
  database = await runtime.getD1Database("DB");
  const migrations = (await readdir("drizzle")).filter((path) => path.endsWith(".sql")).sort();
  assert.ok(migrations.length > 0, "Run db:generate before testing the production schema.");
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
  user?: { accountId: string; email: string; displayName: string; mentorUserId: number; role: string; mode: string } | null;
  mode?: string;
  csrfToken?: string;
  error?: { code: string; message: string };
  invite?: { inviteId: string; expiresAt: number };
  activationUrl?: string;
  items?: Array<Record<string, unknown>>;
  hash?: string;
  verified?: boolean;
}

class Client {
  cookies = new Map<string, string>();
  csrf = "";
  readonly mode: "demo" | "live";
  constructor(mode: "demo" | "live" = "demo") { this.mode = mode; }

  cookieHeader(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "); }

  async request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await runtime.dispatchFetch(`${ORIGIN}/${this.mode}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: this.cookieHeader(), ...(body === undefined ? {} : { origin: ORIGIN, "content-type": "application/json", "x-csrf-token": this.csrf }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const value = await response.json() as AuthBody;
    if (value.csrfToken) this.csrf = value.csrfToken;
    return { response, body: value };
  }

  async seed() { return this.request("/api/auth/session"); }
  async demo() { await this.seed(); return this.request("/api/auth/demo", {}); }
}

async function makeAdmin(mode: "demo" | "live" = "live") {
  const client = new Client(mode);
  await client.seed();
  const result = await client.request("/api/auth/setup", { setupToken: SETUP_SECRET, email: "admin@example.test", displayName: "Account Administrator", password: PASSWORD });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.user?.role, "admin");
  assert.equal(result.body.user?.mentorUserId, 0);
  return client;
}

async function invite(admin: Client, email = "mentor@example.test", mentorUserId = 43) {
  const result = await admin.request("/api/admin/invites", { email, displayName: "Invited Mentor", mentorUserId });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.ok(result.body.activationUrl);
  const url = new URL(result.body.activationUrl);
  assert.equal(url.search, "", "Invitation secrets stay out of request/query logs.");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(token);
  return { token, inviteId: result.body.invite!.inviteId };
}

test("Worker password hashing matches the independent standard PBKDF2 vector and rejects wrong/malformed credentials", async () => {
  const client = new Client();
  const first = await client.request("/test/password", { password: PASSWORD });
  const second = await client.request("/test/password", { password: PASSWORD });
  assert.equal(first.response.status, 200);
  assert.notEqual(first.body.hash, second.body.hash, "Each password gets a unique salt.");
  const [algorithm, iterations, salt, digest] = first.body.hash!.split("$");
  assert.equal(algorithm, "pbkdf2-sha256");
  assert.equal(Number(iterations), 600_000);
  assert.equal(pbkdf2Sync(PASSWORD, Buffer.from(salt, "base64url"), 600_000, 32, "sha256").toString("base64url"), digest);
  assert.equal((await client.request("/test/password", { password: PASSWORD, hash: first.body.hash })).body.verified, true);
  assert.equal((await client.request("/test/password", { password: "A different long passphrase", hash: first.body.hash })).body.verified, false);
  assert.equal((await client.request("/test/password", { password: PASSWORD, hash: first.body.hash!.replace("600000", "1") })).body.verified, false);
});

test("anonymous session seeds HttpOnly secure CSRF; cross-origin or missing-CSRF mutations have no side effects", async () => {
  const client = new Client();
  const seed = await client.seed();
  assert.equal(seed.response.status, 401);
  assert.equal(seed.body.user, null);
  assert.equal(seed.body.mode, "demo");
  assert.match(seed.response.headers.get("cache-control")!, /no-store/);
  assert.match(seed.response.headers.getSetCookie().join(";"), /__Host-mentor_csrf=.*HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
  const foreign = await client.request("/api/auth/demo", {}, { origin: "https://unrelated.test" });
  assert.equal(foreign.response.status, 403);
  assert.equal(foreign.body.error?.code, "ORIGIN_INVALID");
  const noToken = await client.request("/api/auth/demo", {}, { "x-csrf-token": "" });
  assert.equal(noToken.response.status, 403);
  assert.equal(noToken.body.error?.code, "CSRF_INVALID");
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_accounts").first<{count:number}>())!.count, 0);
});

test("demo accounts are isolated, cannot administer accounts, and cannot become live sessions", async () => {
  const one = new Client();
  const two = new Client();
  const a = await one.demo();
  const b = await two.demo();
  assert.equal(a.response.status, 200);
  assert.equal(a.body.user?.displayName, "Alex Morgan");
  assert.notEqual(a.body.user?.accountId, b.body.user?.accountId);
  assert.equal((await one.request("/api/admin/accounts")).response.status, 403);
  const live = new Client("live");
  live.cookies = new Map(one.cookies);
  live.csrf = one.csrf;
  assert.equal((await live.seed()).response.status, 401);
  assert.equal((await live.request("/api/auth/demo", {})).response.status, 404);
  const wrongMode = await live.request("/api/auth/login", { email: a.body.user!.email, password: PASSWORD });
  assert.equal(wrongMode.response.status, 401);
});

test("CSRF is bound to a session and rotated on sign-in", async () => {
  const one = new Client();
  await one.seed();
  const oldCsrf = one.csrf;
  await one.request("/api/auth/demo", {});
  const two = new Client();
  await two.demo();
  assert.equal((await one.request("/api/auth/logout", {}, { "x-csrf-token": oldCsrf })).response.status, 403);
  assert.equal((await one.request("/api/auth/logout", {}, { "x-csrf-token": two.csrf })).response.status, 403);
  assert.equal((await one.seed()).response.status, 200);
});

test("expired sessions and copied cookies after logout are rejected by persistent session checks", async () => {
  const client = new Client();
  await client.demo();
  const copied = new Client();
  copied.cookies = new Map(client.cookies);
  copied.csrf = client.csrf;
  const expiry = await database.prepare("SELECT expires_at FROM auth_sessions").first<{expires_at:number}>();
  const expired = await runtime.dispatchFetch(`${ORIGIN}/demo/api/auth/session`, { headers: { cookie: client.cookieHeader(), "x-test-now": String(expiry!.expires_at) } });
  assert.equal(expired.status, 401, "Expiry is exclusive at the exact stored deadline.");
  assert.equal((await client.request("/api/auth/logout", {})).response.status, 200);
  assert.equal((await copied.seed()).response.status, 401);
  const revoked = await database.prepare("SELECT revoked_at FROM auth_sessions").first<{revoked_at:number|null}>();
  assert.notEqual(revoked!.revoked_at, null);
});

test("setup requires the environment secret, creates only a minimal admin, and can happen only once", async () => {
  const client = new Client("live");
  await client.seed();
  const denied = await client.request("/api/auth/setup", { setupToken: "incorrect", email: "admin@example.test", displayName: "Admin", password: PASSWORD });
  assert.equal(denied.response.status, 403);
  const admin = await makeAdmin();
  const repeated = await admin.request("/api/auth/setup", { setupToken: SETUP_SECRET, email: "another@example.test", displayName: "Another Admin", password: PASSWORD });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error?.code, "SETUP_COMPLETE");
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_accounts WHERE role = 'admin'").first<{count:number}>())!.count, 1);
});

test("an invitation fixes email and Mentor mapping, activates once, and stores only a token digest", async () => {
  const admin = await makeAdmin();
  const invitation = await invite(admin);
  const client = new Client("live");
  await client.seed();
  const forged = await client.request("/api/auth/activate", { token: invitation.token, password: PASSWORD, mentorUserId: 999, role: "admin" });
  assert.equal(forged.response.status, 400);
  const activated = await client.request("/api/auth/activate", { token: invitation.token, password: PASSWORD });
  assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
  assert.equal(activated.body.user?.mentorUserId, 43);
  assert.equal(activated.body.user?.role, "mentor");
  assert.equal(activated.body.user?.email, "mentor@example.test");
  const replay = await client.request("/api/auth/activate", { token: invitation.token, password: PASSWORD });
  assert.equal(replay.response.status, 410);
  const stored = await database.prepare("SELECT token_hash,accepted_at FROM auth_invites WHERE id = ?").bind(invitation.inviteId).first<{token_hash:string;accepted_at:number|null}>();
  assert.match(stored!.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored!.token_hash, invitation.token);
  assert.notEqual(stored!.accepted_at, null);
});

test("concurrent invitation redemption has one winner and one persistent account", async () => {
  const admin = await makeAdmin();
  const invitation = await invite(admin);
  const one = new Client("live");
  const two = new Client("live");
  await Promise.all([one.seed(), two.seed()]);
  const results = await Promise.all([one.request("/api/auth/activate", { token: invitation.token, password: PASSWORD }), two.request("/api/auth/activate", { token: invitation.token, password: PASSWORD })]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 410]);
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_accounts WHERE role = 'mentor'").first<{count:number}>())!.count, 1);
});

test("expired, revoked, reissued and wrong-mode invitations cannot activate", async () => {
  const admin = await makeAdmin();
  const expired = await invite(admin, "expired@example.test", 1);
  await database.prepare("UPDATE auth_invites SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.inviteId).run();
  const revoked = await invite(admin, "revoked@example.test", 2);
  assert.equal((await admin.request("/api/admin/invites/revoke", { inviteId: revoked.inviteId })).response.status, 200);
  const old = await invite(admin, "reissued@example.test", 3);
  const replacement = await invite(admin, "reissued@example.test", 3);
  const client = new Client("live");
  await client.seed();
  for (const token of [expired.token, revoked.token, old.token]) {
    assert.equal((await client.request("/api/auth/activate", { token, password: PASSWORD })).response.status, 410);
  }
  const demo = new Client();
  await demo.seed();
  assert.equal((await demo.request("/api/auth/activate", { token: replacement.token, password: PASSWORD })).response.status, 410);
});

test("account revocation invalidates all sessions and prevents subsequent password login", async () => {
  const admin = await makeAdmin();
  const invitation = await invite(admin);
  const first = new Client("live");
  await first.seed();
  const activation = await first.request("/api/auth/activate", { token: invitation.token, password: PASSWORD });
  const second = new Client("live");
  await second.seed();
  assert.equal((await second.request("/api/auth/login", { email: " MENTOR@example.test ", password: PASSWORD })).response.status, 200);
  assert.equal((await admin.request("/api/admin/accounts/revoke", { accountId: activation.body.user!.accountId })).response.status, 200);
  assert.equal((await first.seed()).response.status, 401);
  assert.equal((await second.seed()).response.status, 401);
  const login = await second.request("/api/auth/login", { email: "mentor@example.test", password: PASSWORD });
  assert.equal(login.response.status, 401);
  assert.equal(login.body.error?.code, "INVALID_CREDENTIALS");
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_sessions WHERE account_id = ? AND revoked_at IS NULL").bind(activation.body.user!.accountId).first<{count:number}>())!.count, 0);
});

test("D1 throttles repeated login attempts, returns Retry-After and accepts no forged forwarded identity", async () => {
  const client = new Client("live");
  await client.seed();
  let result: Awaited<ReturnType<Client["request"]>> | undefined;
  for (let attempt = 0; attempt < 11; attempt++) {
    result = await client.request("/api/auth/login", { email: "absent@example.test", password: PASSWORD }, { "x-forwarded-for": `192.0.2.${attempt + 1}` });
  }
  assert.equal(result!.response.status, 429);
  assert.equal(result!.body.error?.code, "RATE_LIMITED");
  assert.ok(Number(result!.response.headers.get("retry-after")) > 0);
});

test("JSON input is checked by actual size and admin-only account fields are never accepted by login", async () => {
  const client = new Client("live");
  await client.seed();
  const oversized = await client.request("/api/auth/login", { email: "x".repeat(9000), password: PASSWORD });
  assert.equal(oversized.response.status, 413);
  const forged = await client.request("/api/auth/login", { email: "mentor@example.test", password: PASSWORD, mode: "demo" });
  assert.equal(forged.response.status, 400);
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_accounts").first<{count:number}>())!.count, 0);
});

test("loopback HTTP uses separate development cookies and insecure public origins fail closed", async () => {
  const seed = await runtime.dispatchFetch("http://localhost/demo/api/auth/session");
  assert.equal(seed.status, 401);
  const csrfCookie = seed.headers.getSetCookie().find((cookie) => cookie.startsWith("mentor_csrf_dev="));
  assert.ok(csrfCookie);
  assert.match(csrfCookie, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(csrfCookie, /; Secure/);
  const body = await seed.json() as AuthBody;
  const login = await runtime.dispatchFetch("http://localhost/demo/api/auth/demo", { method: "POST", headers: { origin: "http://localhost", cookie: csrfCookie.split(";")[0], "content-type": "application/json", "x-csrf-token": body.csrfToken! }, body: "{}" });
  assert.equal(login.status, 200);
  assert.ok(login.headers.getSetCookie().some((cookie) => cookie.startsWith("mentor_session_dev=")));
  const insecure = await runtime.dispatchFetch("http://portal.test/demo/api/auth/session");
  assert.equal(insecure.status, 503);
});

test("concurrent bootstrap requests cannot create a second administrator", async () => {
  const one = new Client("live");
  const two = new Client("live");
  await Promise.all([one.seed(), two.seed()]);
  const results = await Promise.all([one.request("/api/auth/setup", { setupToken: SETUP_SECRET, email: "first@example.test", displayName: "First", password: PASSWORD }), two.request("/api/auth/setup", { setupToken: SETUP_SECRET, email: "second@example.test", displayName: "Second", password: PASSWORD })]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
  assert.equal((await database.prepare("SELECT count(*) AS count FROM auth_accounts WHERE role = 'admin'").first<{count:number}>())!.count, 1);
});

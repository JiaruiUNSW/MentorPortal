import assert from "node:assert/strict";
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import type { PortalBindings } from "../lib/runtime";

type Harness = Pick<typeof import("../lib/auth/security"), "cookieNames" | "requestSource"> &
  Pick<typeof import("../lib/auth"), "handleAuth"> &
  Pick<typeof import("../lib/runtime"), "setBindingsProvider"> &
  Pick<typeof import("../lib/standalone/sqlite"), "SqliteDatabase">;
type AuthAction = Parameters<Harness["handleAuth"]>[1];
const PUBLIC_ORIGIN = "https://mentor.proxy.example.invalid";
const INTERNAL_ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "Synthetic proxy test passphrase 403!";
const EMAIL = "mentor.proxy@example.invalid";
let harness: Harness;
let database: InstanceType<Harness["SqliteDatabase"]>;
let directory: string;
let bindings: PortalBindings;

before(async () => {
  // Bundle the actual server entrypoints in memory. No HTTP endpoint or runtime
  // selection flag is added to the application, and Request has no Worker cf.
  const bundle = await build({
    stdin: {
      contents: `
        export { cookieNames, requestSource } from './lib/auth/security';
        export { handleAuth } from './lib/auth';
        export { setBindingsProvider } from './lib/runtime';
        export { SqliteDatabase } from './lib/standalone/sqlite';
      `,
      resolveDir: process.cwd(), sourcefile: "auth-proxy-node-harness.ts", loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "node", target: "node24",
  });
  harness = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as Harness;
  directory = await mkdtemp(join(tmpdir(), "mentor-auth-proxy-test-"));
  database = new harness.SqliteDatabase(join(directory, "synthetic.sqlite"));
  database.migrate(resolve("drizzle"));
  harness.setBindingsProvider(() => bindings);
});

after(async () => {
  database?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.batch(["auth_sessions", "auth_invites", "auth_setup", "auth_accounts", "auth_rate_limits"].map((table) => database.prepare(`DELETE FROM ${table}`)));
  bindings = { DB: database as unknown as D1Database, PORTAL_MODE: "live", APP_ORIGIN: PUBLIC_ORIGIN } as PortalBindings;
});

interface AuthBody {
  user?: { accountId: string; email: string; mentorUserId: number; role: string; mode: string } | null;
  csrfToken?: string;
  readOnly?: boolean;
  error?: { code: string; message: string };
}

class Client {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly ip: string;
  readonly internalOrigin: string;
  constructor(ip: string, internalOrigin = INTERNAL_ORIGIN) { this.ip = ip; this.internalOrigin = internalOrigin; }

  async call(action: AuthAction, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const request = new Request(`${this.internalOrigin}/api/auth/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        "x-real-ip": this.ip,
        ...(body === undefined ? {} : { origin: PUBLIC_ORIGIN, "content-type": "application/json", "x-csrf-token": this.csrf }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal("cf" in request, false, "Exercise Node Request rather than trusted Worker metadata.");
    const response = await harness.handleAuth(request, action);
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0];
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const value = await response.json() as AuthBody;
    if (value.csrfToken) this.csrf = value.csrfToken;
    return { response, body: value };
  }
}

function assertSecureCookies(response: Response): void {
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.length > 0);
  for (const cookie of cookies) {
    assert.match(cookie, /^__Host-mentor_(session|csrf)=/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly;/);
    assert.match(cookie, /; SameSite=Lax;/);
    assert.match(cookie, /; Secure$/);
    assert.doesNotMatch(cookie, /; Domain=/i);
  }
}

async function seedMentor() {
  const salt = randomBytes(24);
  const hash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${pbkdf2Sync(PASSWORD, salt, 600_000, 32, "sha256").toString("base64url")}`;
  const id = randomUUID();
  await database.prepare("INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) VALUES (?,?,?,?,73,'mentor','live','active',?,NULL)")
    .bind(id, EMAIL, "Synthetic proxy mentor", hash, Date.now()).run();
  return id;
}

test("HTTPS APP_ORIGIN keeps secure host cookies and persistent login/CSRF behind an internal HTTP URL", async () => {
  bindings.TRUST_PROXY = "true";
  const id = await seedMentor();
  const client = new Client("192.0.2.10");
  const seed = await client.call("session", undefined, { "x-forwarded-proto": "http", "x-forwarded-host": "attacker.invalid" });
  assert.equal(seed.response.status, 401);
  assert.equal(seed.body.readOnly, true);
  assertSecureCookies(seed.response);
  assert.ok(client.cookies.has("__Host-mentor_csrf"));
  assert.equal(client.cookies.has("mentor_csrf_dev"), false);
  const oldCsrf = client.csrf;
  const login = await client.call("login", { email: EMAIL, password: PASSWORD });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  assertSecureCookies(login.response);
  assert.equal(login.body.user?.accountId, id);
  assert.equal(login.body.user?.mentorUserId, 73);
  assert.equal(login.body.user?.role, "mentor");
  assert.equal(login.body.readOnly, true);
  assert.notEqual(client.csrf, oldCsrf);
  assert.equal(client.cookies.has("__Host-mentor_csrf"), false);
  assert.ok(client.cookies.has("__Host-mentor_session"));
  assert.equal((await client.call("session")).response.status, 200);
  const rejected = await client.call("logout", {}, { "x-csrf-token": oldCsrf });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.body.error?.code, "CSRF_INVALID");
  assert.equal((await client.call("session")).response.status, 200);
  const logout = await client.call("logout", {});
  assert.equal(logout.response.status, 200);
  assertSecureCookies(logout.response);
  assert.equal(client.cookies.has("__Host-mentor_session"), false);
  assert.ok(client.cookies.has("__Host-mentor_csrf"));
  assert.equal((await client.call("session")).response.status, 401);
});

test("configured public Origin and CSRF remain mandatory despite spoofed forwarding headers", async () => {
  bindings.TRUST_PROXY = "true";
  const client = new Client("192.0.2.10");
  await client.call("session");
  for (const origin of ["https://attacker.invalid", INTERNAL_ORIGIN]) {
    const result = await client.call("login", { email: EMAIL, password: PASSWORD }, { origin, "x-forwarded-host": new URL(PUBLIC_ORIGIN).host, "x-forwarded-proto": "https" });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error?.code, "ORIGIN_INVALID");
  }
  const noToken = await client.call("login", { email: EMAIL, password: PASSWORD }, { "x-csrf-token": "" });
  assert.equal(noToken.response.status, 403);
  assert.equal(noToken.body.error?.code, "CSRF_INVALID");
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM auth_rate_limits").first<{ count: number }>())!.count, 0);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM auth_accounts").first<{ count: number }>())!.count, 0);
});

test("no configuration preserves loopback cookies and ignores spoofed forwarding headers", () => {
  const request = new Request(`${INTERNAL_ORIGIN}/api/auth/session`, { headers: { "x-real-ip": "192.0.2.10", "x-forwarded-for": "192.0.2.11", "x-forwarded-proto": "https", "x-forwarded-host": "attacker.invalid" } });
  assert.deepEqual(harness.cookieNames(request), { session: "mentor_session_dev", csrf: "mentor_csrf_dev", secure: false });
  assert.equal(harness.requestSource(request), "local-development");
  assert.equal(harness.requestSource(request, { trustProxy: true }), "local-development");
  assert.equal(harness.requestSource(request, { trustProxy: true, appOrigin: INTERNAL_ORIGIN }), "local-development");
  assert.equal(harness.requestSource(request, { trustProxy: true, appOrigin: "https://localhost" }), "local-development");
  const external = new Request(`${PUBLIC_ORIGIN}/api/auth/session`, { headers: request.headers });
  assert.equal(harness.cookieNames(external).secure, true);
  assert.equal(harness.requestSource(external), "unidentified-source");
  assert.equal(harness.requestSource(external, { appOrigin: PUBLIC_ORIGIN }), "unidentified-source");
  assert.equal(harness.requestSource(external, { trustProxy: true }), "unidentified-source");
});

test("an invalid APP_ORIGIN cannot select a cookie scope or permit proxy trust", async () => {
  for (const origin of ["http://portal.invalid", `${PUBLIC_ORIGIN}/wrong-path`, `${PUBLIC_ORIGIN}/?query=yes`, `${PUBLIC_ORIGIN}/#fragment`, "https://user:password@portal.invalid", "not a URL"]) {
    const request = new Request(`${INTERNAL_ORIGIN}/api/auth/session`);
    assert.throws(() => harness.cookieNames(request, origin), { code: "AUTH_UNAVAILABLE" });
    assert.throws(() => harness.requestSource(request, { trustProxy: true, appOrigin: origin }), { code: "AUTH_UNAVAILABLE" });
  }
  bindings.APP_ORIGIN = "http://portal.invalid";
  const response = await new Client("192.0.2.10").call("session");
  assert.equal(response.response.status, 503);
  assert.equal(response.body.error?.code, "AUTH_UNAVAILABLE");
  assert.equal(response.response.headers.getSetCookie().length, 0);
});

test("trusted proxy accepts one strict IP, normalizes IPv6, and never falls back to other client headers", () => {
  const source = (ip: string | null) => harness.requestSource(new Request(`${INTERNAL_ORIGIN}/api/auth/login`, { headers: {
    ...(ip === null ? {} : { "x-real-ip": ip }), "x-forwarded-for": "192.0.2.80", "cf-connecting-ip": "192.0.2.81",
  } }), { trustProxy: true, appOrigin: PUBLIC_ORIGIN });
  for (const address of ["0.0.0.0", "192.0.2.10", "255.255.255.255", "2001:db8::1", "::1", "::", "::ffff:192.0.2.128"]) {
    assert.notEqual(isIP(address), 0);
    const normalized = source(address);
    assert.notEqual(isIP(normalized), 0);
  }
  assert.equal(source("2001:0DB8:0000:0000:0000:0000:0000:0001"), source("2001:db8::1"));
  assert.equal(source("::FFFF:192.0.2.128"), source("::ffff:c000:280"));
  for (const invalid of [null, "", "unknown", "192.0.2.1, 198.51.100.1", "192.0.2.1:443", "192.0.2", "192.0.2.01", "256.0.0.1", "-1.0.0.1", "0x7f.0.0.1", "2130706433", "192.0. 2.1", "[2001:db8::1]", "[2001:db8::1]:443", "fe80::1%eth0", "2001:::1", "2001:db8:1:2:3:4:5:6:7", "::ffff:192.0.2.999", "::ffff:192.0.2.01"]) {
    assert.equal(source(invalid), "unidentified-source", String(invalid));
  }
  const duplicate = new Request(`${INTERNAL_ORIGIN}/api/auth/login`);
  duplicate.headers.append("x-real-ip", "192.0.2.10");
  duplicate.headers.append("x-real-ip", "192.0.2.11");
  assert.equal(harness.requestSource(duplicate, { trustProxy: true, appOrigin: PUBLIC_ORIGIN }), "unidentified-source");
  const worker = new Request(`${PUBLIC_ORIGIN}/api/auth/login`, { headers: { "cf-connecting-ip": "192.0.2.82", "x-real-ip": "192.0.2.83" } });
  Object.defineProperty(worker, "cf", { value: { colo: "synthetic" } });
  assert.equal(harness.requestSource(worker, { trustProxy: true, appOrigin: PUBLIC_ORIGIN }), "192.0.2.82", "Preserve the established Worker metadata boundary.");
  assert.equal(harness.cookieNames(worker, PUBLIC_ORIGIN).secure, true);
  const insecureWorker = new Request("http://portal.invalid/api/auth/session");
  Object.defineProperty(insecureWorker, "cf", { value: { colo: "synthetic" } });
  assert.throws(() => harness.cookieNames(insecureWorker, PUBLIC_ORIGIN), { code: "AUTH_UNAVAILABLE" }, "A configured HTTPS origin must not upgrade a known insecure Worker edge request.");
});

test("explicit server TRUST_PROXY separates two Node clients' persistent login limits", async () => {
  bindings.TRUST_PROXY = "true";
  const one = new Client("192.0.2.10"); const two = new Client("198.51.100.20");
  await one.call("session"); await two.call("session");
  for (const [label, client] of [["one", one], ["two", two]] as const) {
    for (let index = 0; index < 10; index++) {
      const result = await client.call("login", { email: `${label}-${index}@example.invalid`, password: PASSWORD });
      assert.equal(result.response.status, 401, `${label} attempt ${index + 1}`);
      assert.equal(result.body.error?.code, "INVALID_CREDENTIALS");
    }
    const limited = await client.call("login", { email: `${label}-limit@example.invalid`, password: PASSWORD });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error?.code, "RATE_LIMITED");
    assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  }
  for (const ip of [one.ip, two.ip]) {
    const prefix = createHash("sha256").update(`live:login:ip:${ip}`).digest("hex");
    const row = await database.prepare("SELECT hits FROM auth_rate_limits WHERE key LIKE ?").bind(`${prefix}:%`).first<{ hits: number }>();
    assert.equal(row?.hits, 11);
  }
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM auth_accounts").first<{ count: number }>())!.count, 0);
});

test("without exact server opt-in, changing proxy headers cannot evade the shared source limit", async () => {
  bindings.TRUST_PROXY = "TRUE"; // Only the literal server binding 'true' opts in.
  const one = new Client("192.0.2.10"); const two = new Client("198.51.100.20");
  await one.call("session"); await two.call("session");
  for (let index = 0; index < 10; index++) {
    const result = await one.call("login", { email: `untrusted-${index}@example.invalid`, password: PASSWORD }, {
      "x-real-ip": `192.0.2.${index + 1}`, "x-forwarded-for": `198.51.100.${index + 1}`, "cf-connecting-ip": `203.0.113.${index + 1}`, "x-trust-proxy": "true",
    });
    assert.equal(result.response.status, 401);
  }
  const blocked = await two.call("login", { email: "untrusted-second@example.invalid", password: PASSWORD });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.error?.code, "RATE_LIMITED");
});

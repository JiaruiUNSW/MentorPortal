import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, pbkdf2Sync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import type { AuthService } from "../lib/auth/service";
import type { StandaloneBindings } from "../lib/standalone/index";

const ORIGIN = "https://portal.example.test";
const ISSUER = "https://usso.example.test/application/o/mentor-portal/";
const PROVIDER_ORIGIN = new URL(ISSUER).origin;
const CALLBACK = `${ORIGIN}/api/auth/usso/callback`;
const CLIENT_ID = "mentor-portal-test-client";
const CLIENT_SECRET = randomBytes(32).toString("base64url");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
let implementation: {
  createStandaloneBindings: typeof import("../lib/standalone/index").createStandaloneBindings;
  AuthService: typeof import("../lib/auth/service").AuthService;
};
let directory: string;
let bindings: StandaloneBindings;
let service: AuthService;
let provider: Provider;
let password: string;
let accountA: string;
let accountB: string;

interface TokenOptions {
  subject?: string;
  issuer?: string;
  audience?: string;
  nonce?: string;
  expired?: boolean;
  unsigned?: boolean;
  wrongSignature?: boolean;
  algorithm?: string;
}
class Provider {
  private readonly grants = new Map<string, { authorization: URL; options: TokenOptions }>();
  readonly requests: Array<{ url: string; method: string }> = [];
  tokenRequests = 0;
  jwksRequests = 0;
  metadataOverride: Record<string, unknown> = {};
  onToken?: () => Promise<void>;

  callback(authorizationUrl: string, options: TokenOptions = {}): string {
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.origin, PROVIDER_ORIGIN);
    assert.equal(authorization.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("response_mode"), "query");
    assert.equal(authorization.searchParams.get("redirect_uri"), CALLBACK);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(authorization.searchParams.get("scope")!.split(" ").sort(), ["email", "openid", "profile"]);
    assert.ok(authorization.searchParams.get("nonce"));
    const code = randomUUID();
    this.grants.set(code, { authorization, options });
    const callback = new URL(CALLBACK);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    return callback.href;
  }

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.requests.push({ url: url.href, method: init?.method ?? "GET" });
    assert.equal(url.origin, PROVIDER_ORIGIN, "Tests must never make outbound provider requests.");
    assert.equal(init?.redirect, "error", "OIDC transport must never follow a redirect with client credentials.");
    if (url.href === `${ISSUER}.well-known/openid-configuration`) return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${PROVIDER_ORIGIN}/application/o/authorize/`,
      token_endpoint: `${PROVIDER_ORIGIN}/application/o/token/`,
      jwks_uri: `${ISSUER}jwks/`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      ...this.metadataOverride,
    });
    if (url.href === `${ISSUER}jwks/`) {
      this.jwksRequests++;
      return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test-signing-key", use: "sig", alg: "RS256" }] });
    }
    assert.equal(url.href, `${PROVIDER_ORIGIN}/application/o/token/`);
    this.tokenRequests++;
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    assert.match(authorization, /^Basic /);
    const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":");
    assert.equal(decodeURIComponent(credentials[0]), CLIENT_ID);
    assert.equal(decodeURIComponent(credentials[1]) === CLIENT_SECRET, true, "Token exchange must use this application's server-side credentials.");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), CALLBACK);
    const grant = this.grants.get(form.get("code") ?? "");
    if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
    this.grants.delete(form.get("code")!);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    assert.equal(challenge, grant.authorization.searchParams.get("code_challenge"), "PKCE verifier must match this exact authorization transaction.");
    if (this.onToken) await this.onToken();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: grant.options.issuer ?? ISSUER,
      sub: grant.options.subject ?? "approved-subject-a",
      aud: grant.options.audience ?? CLIENT_ID,
      iat: now,
      exp: grant.options.expired ? now - 120 : now + 300,
      nonce: grant.options.nonce ?? grant.authorization.searchParams.get("nonce"),
      email: "mentor-a@example.invalid",
      email_verified: true,
      roles: ["admin"],
    };
    const header = Buffer.from(JSON.stringify({ alg: grant.options.unsigned ? "none" : grant.options.algorithm ?? "RS256", kid: "test-signing-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = grant.options.unsigned ? "" : sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), grant.options.wrongSignature ? wrongKeys.privateKey : keys.privateKey).toString("base64url");
    return Response.json({ token_type: "Bearer", access_token: "synthetic-access-token", expires_in: 300, id_token: `${header}.${payload}.${signature}` });
  };
}

function makeService(mode: "live" | "demo" = "live", enabled = true): AuthService {
  return new implementation.AuthService(bindings.DB, { mode, appOrigin: ORIGIN, usso: { enabled, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, ussoFetch: provider.fetcher });
}

before(async () => {
  const bundle = await build({ stdin: { contents: "export { createStandaloneBindings } from './lib/standalone/index'; export { AuthService } from './lib/auth/service';", resolveDir: process.cwd(), sourcefile: "usso-test-bundle.ts", loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
  implementation = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mentor-usso-test-"));
  bindings = implementation.createStandaloneBindings({ dataDir: directory, migrationsDir: resolve("drizzle"), env: {} });
  provider = new Provider();
  service = makeService();
  password = randomBytes(24).toString("base64url");
  const salt = randomBytes(24);
  const hash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 600_000, 32, "sha256").toString("base64url")}`;
  accountA = randomUUID(); accountB = randomUUID();
  for (const [id, email, mentorId] of [[accountA, "mentor-a@example.invalid", 101], [accountB, "mentor-b@example.invalid", 102]]) {
    await bindings.DB.prepare("INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) VALUES (?,?,'Synthetic Mentor',?,?,'mentor','live','active',?,NULL)").bind(id, email, hash, mentorId, Date.now()).run();
  }
});
afterEach(async () => { bindings?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

interface AuthBody { user?: { accountId: string; role: string; mentorUserId: number } | null; csrfToken?: string; error?: { code: string }; usso?: { enabled: boolean; linked: boolean }; authorizationUrl?: string }
class Client {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly service: AuthService;
  constructor(authService = service) { this.service = authService; }
  cookieHeader(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "); }
  async call(action: "session" | "login" | "logout" | "ussoStart" | "ussoCallback", body?: unknown, url?: string, headers?: Record<string, string>) {
    const request = new Request(url ?? `${ORIGIN}/api/auth/${action}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: this.cookieHeader(), ...(body === undefined ? {} : { origin: ORIGIN, "content-type": "application/json", "x-csrf-token": this.csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let response: Response;
    try { response = await this.service[action](request); } catch (error) { response = this.service.errorResponse(error); }
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0], split = pair.indexOf("="), name = pair.slice(0, split), value = pair.slice(split + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const value = response.status === 303 ? {} : await response.json() as AuthBody;
    if (value.csrfToken) this.csrf = value.csrfToken;
    return { response, body: value };
  }
  async passwordLogin(email = "mentor-a@example.invalid") {
    await this.call("session");
    const result = await this.call("login", { email, password });
    assert.equal(result.response.status, 200);
    return result;
  }
  async start(intent: "login" | "link") {
    await this.call("session");
    const result = await this.call("ussoStart", { intent });
    assert.equal(result.response.status, 200, "USSO authorization should start with verified metadata.");
    assert.ok(result.body.authorizationUrl);
    return result.body.authorizationUrl;
  }
  callback(url: string) { return this.call("ussoCallback", undefined, url); }
}

async function mapSubject(subject = "approved-subject-a", accountId = accountA) {
  await bindings.DB.prepare("INSERT INTO auth_oidc_identities (issuer,subject,account_id,created_at) VALUES (?,?,?,?)").bind(ISSUER, subject, accountId, Date.now()).run();
}
async function count(table: "auth_accounts" | "auth_sessions" | "auth_oidc_identities" | "auth_oidc_transactions") {
  return bindings.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>("count");
}

test("USSO starts only with CSRF/origin and a live configuration; linking requires an authenticated portal session", async () => {
  const client = new Client();
  await client.call("session");
  assert.equal((await client.call("ussoStart", { intent: "login" }, undefined, { origin: "https://unrelated.example.test" })).response.status, 403);
  assert.equal((await client.call("ussoStart", { intent: "login" }, undefined, { "x-csrf-token": "" })).response.status, 403);
  assert.equal((await client.call("ussoStart", { intent: "link" })).response.status, 401);
  assert.equal((await client.call("ussoStart", { intent: "login", returnTo: "https://unrelated.example.test" })).response.status, 400);
  assert.equal(provider.requests.length, 0);
  const demo = new Client(makeService("demo"));
  assert.equal((await demo.call("session")).body.usso?.enabled, false);
  assert.equal((await demo.call("ussoStart", { intent: "login" })).response.status, 503);
  const started = await client.call("ussoStart", { intent: "login" });
  assert.equal(started.response.status, 200);
  assert.match(started.response.headers.getSetCookie().join(";"), /__Host-mentor_usso=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const authorization = new URL(started.body.authorizationUrl!);
  const row = await bindings.DB.prepare("SELECT * FROM auth_oidc_transactions").first<Record<string, unknown>>();
  assert.equal(row!.state_hash, createHash("sha256").update(authorization.searchParams.get("state")!).digest("hex"));
  assert.notEqual(row!.browser_hash, client.cookies.get("__Host-mentor_usso"));
  assert.equal(row!.account_id, null);
});

test("self-service linking and later USSO login preserve account, local password, role and SharePoint User ID", async () => {
  const client = new Client();
  const original = await client.passwordLogin();
  const oldSession = client.cookies.get("__Host-mentor_session");
  const oldHash = await bindings.DB.prepare("SELECT password_hash FROM auth_accounts WHERE id=?").bind(accountA).first<string>("password_hash");
  const url = await client.start("link");
  assert.equal(new URL(url).searchParams.get("prompt"), "login");
  const linked = await client.callback(provider.callback(url));
  assert.equal(linked.response.status, 303);
  assert.equal(linked.response.headers.get("location"), `${ORIGIN}/?usso=linked`);
  assert.notEqual(client.cookies.get("__Host-mentor_session"), oldSession);
  assert.equal((await client.call("session")).body.usso?.linked, true);
  assert.equal(await bindings.DB.prepare("SELECT account_id FROM auth_oidc_identities WHERE issuer=? AND subject=?").bind(ISSUER, "approved-subject-a").first<string>("account_id"), accountA);
  assert.equal(await bindings.DB.prepare("SELECT password_hash FROM auth_accounts WHERE id=?").bind(accountA).first<string>("password_hash") === oldHash, true);
  await client.call("logout", {});
  const signedIn = await client.callback(provider.callback(await client.start("login")));
  assert.equal(signedIn.response.headers.get("location"), `${ORIGIN}/`);
  const current = (await client.call("session")).body.user;
  assert.equal(current?.accountId, original.body.user?.accountId);
  assert.equal(current?.mentorUserId, 101);
  assert.equal(current?.role, "mentor", "Directory roles must not grant portal administration.");
  assert.ok(provider.jwksRequests >= 2, "ID-token signatures must actually be checked with the provider JWKS.");
  await client.call("logout", {});
  assert.equal((await client.passwordLogin()).body.user?.accountId, accountA);
});

test("a valid USSO identity with a matching email is not auto-linked or auto-provisioned", async () => {
  const client = new Client();
  const result = await client.callback(provider.callback(await client.start("login"), { subject: "new-unapproved-subject" }));
  assert.equal(result.response.headers.get("location"), `${ORIGIN}/login?usso=unmapped`);
  assert.equal(await count("auth_accounts"), 2);
  assert.equal(await count("auth_sessions"), 0);
  assert.equal(await count("auth_oidc_identities"), 0);
});

test("state is browser-bound, expires and is consumed once without another browser clearing the valid transaction", async () => {
  await mapSubject();
  const client = new Client(), stranger = new Client();
  const callback = provider.callback(await client.start("login"));
  const staleCookies = client.cookieHeader();
  assert.equal((await stranger.callback(callback)).response.headers.get("location"), `${ORIGIN}/login?usso=expired`);
  const corrupted = new URL(callback); corrupted.searchParams.set("state", randomBytes(32).toString("base64url"));
  await client.callback(corrupted.href);
  assert.ok(client.cookies.has("__Host-mentor_usso"), "Invalid callbacks must not clear another active transaction's cookie.");
  assert.equal(await count("auth_oidc_transactions"), 1);
  assert.equal((await client.callback(callback)).response.headers.get("location"), `${ORIGIN}/`);
  const calls = provider.tokenRequests;
  const replay = await client.call("ussoCallback", undefined, callback, { cookie: staleCookies });
  assert.equal(replay.response.headers.get("location"), `${ORIGIN}/login?usso=expired`);
  assert.equal(provider.tokenRequests, calls);
  const expired = provider.callback(await client.start("login"));
  await bindings.DB.prepare("UPDATE auth_oidc_transactions SET expires_at=?").bind(Date.now() - 1).run();
  assert.equal((await client.callback(expired)).response.headers.get("location"), `${ORIGIN}/login?usso=expired`);
  assert.equal(provider.tokenRequests, calls);
});

test("linking cannot survive logout, a replacement portal session or revocation during token exchange", async () => {
  const client = new Client();
  await client.passwordLogin();
  const callback = provider.callback(await client.start("link"));
  await client.call("logout", {});
  await client.passwordLogin();
  assert.equal((await client.callback(callback)).response.headers.get("location"), `${ORIGIN}/login?usso=link-session-expired`);
  assert.equal(provider.tokenRequests, 0);
  assert.equal(await count("auth_oidc_identities"), 0);
  const duringExchange = provider.callback(await client.start("link"));
  provider.onToken = async () => { await bindings.DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE account_id=?").bind(Date.now(), accountA).run(); };
  assert.equal((await client.callback(duringExchange)).response.headers.get("location"), `${ORIGIN}/login?usso=link-session-expired`);
  assert.equal(await count("auth_oidc_identities"), 0);
});

test("linking cannot steal another account's identity or replace an existing account's subject", async () => {
  await mapSubject("belongs-to-b", accountB);
  const client = new Client();
  await client.passwordLogin();
  const conflict = await client.callback(provider.callback(await client.start("link"), { subject: "belongs-to-b" }));
  assert.equal(conflict.response.headers.get("location"), `${ORIGIN}/login?usso=link-conflict`);
  assert.equal((await client.call("session")).body.user?.accountId, accountA);
  await mapSubject("already-linked-a", accountA);
  const replacement = await client.callback(provider.callback(await client.start("link"), { subject: "replacement-a" }));
  assert.equal(replacement.response.headers.get("location"), `${ORIGIN}/login?usso=link-conflict`);
  assert.equal(await count("auth_oidc_identities"), 2);
  assert.equal(await bindings.DB.prepare("SELECT subject FROM auth_oidc_identities WHERE account_id=?").bind(accountA).first<string>("subject"), "already-linked-a");
});

test("issuer, audience, expiry, nonce, signature and signing algorithm failures cannot create sessions", async () => {
  await mapSubject();
  const client = new Client();
  for (const options of [
    { issuer: "https://unrelated.example.test/" },
    { audience: "some-other-application" },
    { expired: true },
    { nonce: "not-this-transaction" },
    { wrongSignature: true },
    { unsigned: true },
    { algorithm: "HS256" },
  ] satisfies TokenOptions[]) {
    const result = await client.callback(provider.callback(await client.start("login"), options));
    assert.equal(result.response.headers.get("location"), `${ORIGIN}/login?usso=failed`, `Token validation failure ${Object.keys(options)[0]} must be rejected.`);
    assert.equal(await count("auth_sessions"), 0);
    assert.equal(await count("auth_oidc_transactions"), 0);
  }
});

test("untrusted discovery endpoints fail closed and OAuth errors never redirect outside the portal", async () => {
  const client = new Client();
  await client.call("session");
  for (const override of [{ issuer: "https://unrelated.example.test/" }, { token_endpoint: "https://unrelated.example.test/token" }, { code_challenge_methods_supported: ["plain"] }]) {
    provider.metadataOverride = override;
    const result = await client.call("ussoStart", { intent: "login" });
    assert.equal(result.response.status, 503);
    assert.equal(await count("auth_oidc_transactions"), 0);
  }
  provider.metadataOverride = {};
  const authorization = new URL(await client.start("login"));
  const callback = new URL(CALLBACK);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "https://unrelated.example.test/");
  callback.searchParams.set("returnTo", "https://unrelated.example.test/");
  const result = await client.callback(callback.href);
  assert.equal(result.response.headers.get("location"), `${ORIGIN}/login?usso=failed`);
  assert.equal(provider.tokenRequests, 0);
  assert.equal(await count("auth_oidc_transactions"), 0);
});

test("disabled mapped accounts remain disabled and disabling USSO leaves password login available", async () => {
  await mapSubject();
  const client = new Client();
  const callback = provider.callback(await client.start("login"));
  await bindings.DB.prepare("UPDATE auth_accounts SET status='disabled',disabled_at=? WHERE id=?").bind(Date.now(), accountA).run();
  assert.equal((await client.callback(callback)).response.headers.get("location"), `${ORIGIN}/login?usso=unmapped`);
  assert.equal(await count("auth_sessions"), 0);
  const localOnly = new Client(makeService("live", false));
  const result = await localOnly.passwordLogin("mentor-b@example.invalid");
  assert.equal(result.body.user?.accountId, accountB);
  assert.equal(result.body.usso?.enabled, false);
});

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, before, beforeEach, test } from "node:test";
import { build } from "esbuild";
import type { StandaloneBindings } from "../lib/standalone/index";
import type { AuthService } from "../lib/auth/service";

const ORIGIN = "https://standalone.test";
const SETUP_TOKEN = randomBytes(32).toString("base64url");
const PASSWORD = "Synthetic standalone password 951!";
const migrationsDir = resolve("drizzle");
let implementation: {
  createStandaloneBindings: typeof import("../lib/standalone/index").createStandaloneBindings;
  AuthService: typeof import("../lib/auth/service").AuthService;
};
let moduleUrl: string;
let directory: string;
let bindings: StandaloneBindings;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `export { createStandaloneBindings } from './lib/standalone/index'; export { AuthService } from './lib/auth/service'; export { claimRequest } from './lib/mentor-data/store';`,
      resolveDir: process.cwd(), sourcefile: "standalone-test-bundle.ts", loader: "ts",
    },
    bundle: true, write: false, platform: "node", format: "esm", target: "node24",
  });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
  implementation = await import(moduleUrl);
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mentor-standalone-test-"));
  bindings = implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir, env: { APP_ORIGIN: ORIGIN, SETUP_TOKEN } });
});

afterEach(async () => { bindings?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

test("Node bindings initialize durable migrations, WAL, safe defaults and native value binding", async () => {
  assert.equal(bindings.PORTAL_MODE, "live");
  assert.equal(bindings.MENTOR_LIVE_WRITES_ENABLED, "false");
  assert.equal(bindings.MENTOR_CACHE_ENABLED, "true");
  assert.equal(await bindings.DB.prepare("PRAGMA journal_mode").first<string>("journal_mode"), "wal");
  assert.equal(await bindings.DB.prepare("PRAGMA busy_timeout").first<number>("timeout"), 5000);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));
  assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM _portal_migrations").first<number>("count"), files.length);
  await bindings.DB.exec("CREATE TABLE binding_test (id INTEGER PRIMARY KEY, value TEXT, flag INTEGER)");
  const hostileValue = "value'); DROP TABLE auth_accounts; --";
  const inserted = await bindings.DB.prepare("INSERT INTO binding_test(value,flag) VALUES (?,?) RETURNING id,value,flag").bind(hostileValue, true).all<{ id: number; value: string; flag: number }>();
  assert.equal(inserted.meta.changes, 1);
  assert.deepEqual(inserted.results, [{ id: 1, value: hostileValue, flag: 1 }]);
  assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM auth_accounts").first<number>("count"), 0);
  assert.deepEqual(await bindings.DB.prepare("SELECT value,flag FROM binding_test").raw({ columnNames: true }), [["value", "flag"], [hostileValue, 1]]);
  await assert.rejects(bindings.DB.prepare("SELECT 1; DELETE FROM binding_test").run(), /exactly one/);
  assert.throws(() => bindings.DB.prepare("SELECT ?").bind(undefined), /bind values/);
});

test("batch exposes INSERT RETURNING and affected counts while rolling back all earlier writes on failure", async () => {
  await bindings.DB.exec("CREATE TABLE transaction_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const result = await bindings.DB.batch<{ id: number }>([
    bindings.DB.prepare("INSERT INTO transaction_test(id,value) VALUES (?,?) RETURNING id").bind(1, "first"),
    bindings.DB.prepare("INSERT INTO transaction_test(id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING RETURNING id").bind(1, "duplicate"),
    bindings.DB.prepare("UPDATE transaction_test SET value=? WHERE id=? RETURNING id").bind("updated", 1),
  ]);
  assert.deepEqual(result.map((item) => item.meta.changes), [1, 0, 1]);
  assert.deepEqual(result.map((item) => item.results), [[{ id: 1 }], [], [{ id: 1 }]]);
  await assert.rejects(bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO transaction_test(id,value) VALUES (2,'must roll back') RETURNING id"),
    bindings.DB.prepare("INSERT INTO transaction_test(id,value) VALUES (1,'conflict')"),
  ]), /UNIQUE constraint/);
  assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM transaction_test WHERE id=2").first<number>("count"), 0);
  await assert.rejects(bindings.DB.exec("INSERT INTO transaction_test VALUES (3,'also roll back'); INSERT INTO no_such_table VALUES (4);"));
  assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM transaction_test WHERE id=3").first<number>("count"), 0);
  await assert.rejects(bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO transaction_test VALUES (3,'cannot commit early')"),
    bindings.DB.prepare("; /* caller must not release the batch */ COMMIT"),
  ]), /Transaction control/);
  assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM transaction_test WHERE id=3").first<number>("count"), 0);
});

test("migration replay is idempotent and changed or failed migrations cannot be marked applied", async () => {
  const initial = await bindings.DB.prepare("SELECT * FROM _portal_migrations ORDER BY name").all();
  const second = implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir, env: {} });
  assert.deepEqual((await second.DB.prepare("SELECT * FROM _portal_migrations ORDER BY name").all()).results, initial.results);
  second.close();
  const copiedMigrations = join(directory, "migrations");
  await cp(migrationsDir, copiedMigrations, { recursive: true });
  const first = (await readdir(copiedMigrations)).filter((name) => name.endsWith(".sql")).sort()[0];
  await appendFile(join(copiedMigrations, first), "\n-- unexpected historical edit\n");
  assert.throws(() => implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir: copiedMigrations, env: {} }), /missing or has changed/);
  await writeFile(join(copiedMigrations, first), await readFile(join(migrationsDir, first)));
  await writeFile(join(copiedMigrations, "9999_failed_test.sql"), "CREATE TABLE migration_rollback_probe(id INTEGER); INSERT INTO missing_migration_target VALUES (1);");
  assert.throws(() => implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir: copiedMigrations, env: {} }), /no such table/);
  assert.equal(await bindings.DB.prepare("SELECT name FROM sqlite_master WHERE name='migration_rollback_probe'").first(), null);
  assert.equal(await bindings.DB.prepare("SELECT name FROM _portal_migrations WHERE name='9999_failed_test.sql'").first(), null);
});

test("separate Node threads racing the same persistent idempotency key produce one claim", async () => {
  const accountId = randomUUID(), idempotencyKey = randomUUID();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createStandaloneBindings, claimRequest } = await import(workerData.moduleUrl);
      const bindings = createStandaloneBindings({ dataDir: workerData.dataDir, migrationsDir: workerData.migrationsDir, env: {} });
      parentPort.postMessage({ready:true});
      parentPort.once('message', async () => {
        try {
          const principal = {accountId:workerData.accountId,email:'thread@example.invalid',displayName:'Thread',mentorUserId:77,role:'mentor',mode:'live'};
          const request = {operation:'tickets.create',payload:{title:'Synthetic claim',description:'Concurrent storage test'},idempotencyKey:workerData.idempotencyKey};
          const claim = await claimRequest(bindings.DB,principal,request,crypto.randomUUID());
          parentPort.postMessage({claimed:true,requestId:claim.row.request_id});
        } catch(error) { parentPort.postMessage({claimed:false,code:error.code,message:error.message}); }
        finally { bindings.close(); parentPort.close(); }
      });
    })().catch(error => { parentPort.postMessage({fatal:error.message}); parentPort.close(); });
  `;
  const workers = [0, 1].map(() => new Worker(workerSource, { eval: true, workerData: { moduleUrl, dataDir: join(directory, "data"), migrationsDir, accountId, idempotencyKey } }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message) => message.ready ? resolve() : reject(new Error(message.fatal ?? "Thread setup failed")));
    })));
    const results = await Promise.all(workers.map((worker) => new Promise<{ claimed: boolean; code?: string }>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
      worker.postMessage("claim");
    })));
    assert.equal(results.filter((result) => result.claimed).length, 1);
    assert.deepEqual(results.filter((result) => !result.claimed).map((result) => result.code), ["REQUEST_IN_PROGRESS"]);
    assert.equal(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM mentor_requests WHERE account_id=? AND idempotency_key=?").bind(accountId, idempotencyKey).first<number>("count"), 1);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
});

interface AuthBody { user?: { accountId: string; role: string; mentorUserId: number } | null; csrfToken?: string; error?: { code: string }; activationUrl?: string }
class AuthClient {
  private readonly service: AuthService;
  private readonly cookies = new Map<string, string>();
  private csrf = "";
  constructor(service: AuthService) { this.service = service; }
  async call(action: "session" | "setup" | "createInvite" | "activate" | "logout" | "login", body?: unknown) {
    const request = new Request(`${ORIGIN}/api/auth/${action}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "), ...(body === undefined ? {} : { origin: ORIGIN, "content-type": "application/json", "x-csrf-token": this.csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let response: Response;
    try { response = await this.service[action](request); } catch (error) { response = this.service.errorResponse(error); }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0], separator = pair.indexOf("="), name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value); else this.cookies.delete(name);
    }
    const value = await response.json() as AuthBody;
    if (value.csrfToken) this.csrf = value.csrfToken;
    return { response, body: value };
  }
}

test("unchanged authentication completes setup, invitation, activation and persistent login on real SQLite", async () => {
  const service = new implementation.AuthService(bindings.DB, { mode: "live", appOrigin: ORIGIN, setupToken: SETUP_TOKEN });
  const admin = new AuthClient(service);
  await admin.call("session");
  const setup = await admin.call("setup", { email: "admin@standalone.invalid", displayName: "Local Test Admin", setupToken: SETUP_TOKEN, password: PASSWORD });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  assert.equal(setup.body.user?.role, "admin");
  const invited = await admin.call("createInvite", { email: "mentor@standalone.invalid", displayName: "Local Test Mentor", mentorUserId: 42 });
  assert.equal(invited.response.status, 201);
  const token = new URLSearchParams(new URL(invited.body.activationUrl!).hash.slice(1)).get("token");
  const mentor = new AuthClient(service);
  await mentor.call("session");
  const activation = await mentor.call("activate", { token, password: PASSWORD });
  assert.equal(activation.response.status, 201, JSON.stringify(activation.body));
  assert.equal(activation.body.user?.mentorUserId, 42);
  assert.equal((await mentor.call("logout", {})).response.status, 200);
  bindings.close();
  bindings = implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir, env: {} });
  const fresh = new AuthClient(new implementation.AuthService(bindings.DB, { mode: "live", appOrigin: ORIGIN }));
  await fresh.call("session");
  const login = await fresh.call("login", { email: "mentor@standalone.invalid", password: PASSWORD });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user?.accountId, activation.body.user?.accountId);
});

test("private file bucket roundtrips metadata, bytes and Web streams with atomic complete overwrites", async () => {
  const key = `demo/${randomUUID()}/file_${randomUUID()}`;
  const content = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await bindings.BUCKET.put(key, content, { httpMetadata: { contentType: "image/png" }, customMetadata: { sha256: "synthetic-checksum" } });
  const object = await bindings.BUCKET.get(key);
  assert.ok(object);
  assert.equal(object.size, content.length);
  assert.equal(object.httpMetadata?.contentType, "image/png");
  assert.equal(object.customMetadata?.sha256, "synthetic-checksum");
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), content);
  assert.deepEqual(new Uint8Array(await new Response(object.body as unknown as BodyInit).arrayBuffer()), content);
  const objectPath = join(directory, "data", "objects", `${createHash("sha256").update(key).digest("hex")}.object`);
  assert.equal((await stat(objectPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "data", "objects"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "data", "portal.sqlite"))).mode & 0o777, 0o600);
  const alternatives = [new Uint8Array(2048).fill(1), new Uint8Array(4096).fill(2)];
  await Promise.all(alternatives.map((bytes) => bindings.BUCKET.put(key, bytes)));
  const final = new Uint8Array(await (await bindings.BUCKET.get(key))!.arrayBuffer());
  assert.ok(alternatives.some((bytes) => Buffer.from(bytes).equals(Buffer.from(final))));
  assert.equal((await readdir(join(directory, "data", "objects"))).filter((name) => name.startsWith(".upload-")).length, 0);
  await bindings.BUCKET.delete(key);
  assert.equal(await bindings.BUCKET.get(key), null);
  await bindings.BUCKET.delete(key);
});

test("bucket traversal, symbolic links and corrupted objects cannot expose files outside storage", async () => {
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "outside synthetic content", { mode: 0o600 });
  for (const key of ["../outside.txt", "/tmp/outside", "live/../outside", "live//file", "live\\..\\outside", "live/%2e%2e/outside", "live/file\0x"]) {
    await assert.rejects(bindings.BUCKET.put(key, "x"), /key is invalid/);
    await assert.rejects(bindings.BUCKET.get(key), /key is invalid/);
    await assert.rejects(bindings.BUCKET.delete(key), /key is invalid/);
  }
  const key = "demo/account/file_symlink";
  const path = join(directory, "data", "objects", `${createHash("sha256").update(key).digest("hex")}.object`);
  await symlink(outside, path);
  await assert.rejects(bindings.BUCKET.get(key));
  await bindings.BUCKET.put(key, "new private content");
  assert.equal(await readFile(outside, "utf8"), "outside synthetic content");
  assert.equal(await (await bindings.BUCKET.get(key))!.text(), "new private content");
  await appendFile(path, "tamper");
  await assert.rejects(bindings.BUCKET.get(key), /could not be verified/);
});

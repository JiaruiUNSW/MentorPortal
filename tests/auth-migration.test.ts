import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { build } from "esbuild";

type RecordRow = Record<string, unknown>;
interface ExportFixture {
  schemaVersion: number;
  tables: { auth_accounts: RecordRow[]; auth_setup: RecordRow[]; auth_invites: RecordRow[] };
}
interface CommandResult { code: number; stdout: string; stderr: string }
const PASSWORD = "Synthetic migration password 674!";
const INVITE_TOKEN = randomBytes(32).toString("base64url");
const migrationsDir = resolve("drizzle");
let workspace: string;
let directory: string;
let cliFile: string;
let fixture: ExportFixture;
let implementation: {
  createStandaloneBindings: typeof import("../lib/standalone/index").createStandaloneBindings;
  AuthService: typeof import("../lib/auth/service").AuthService;
};

function standardHash(): string {
  const salt = randomBytes(24);
  return `pbkdf2-sha256$600000$${salt.toString("base64url")}$${pbkdf2Sync(PASSWORD, salt, 600_000, 32, "sha256").toString("base64url")}`;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "mentor-auth-migration-test-"));
  cliFile = join(workspace, "import-auth.mjs");
  const cli = await build({ entryPoints: ["scripts/import-auth.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
  await writeFile(cliFile, cli.outputFiles[0].text, { mode: 0o600 });
  const support = await build({ stdin: { contents: "export { createStandaloneBindings } from './lib/standalone/index'; export { AuthService } from './lib/auth/service';", resolveDir: process.cwd(), sourcefile: "auth-migration-test-support.ts", loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
  implementation = await import(`data:text/javascript;base64,${Buffer.from(support.outputFiles[0].text).toString("base64")}`);
  const adminId = randomUUID(), mentorId = randomUUID(), now = Date.now();
  fixture = {
    schemaVersion: 1,
    tables: {
      auth_accounts: [
        { id: adminId, email: "admin@migration.invalid", display_name: "Synthetic Admin", password_hash: standardHash(), mentor_user_id: 0, role: "admin", mode: "live", status: "active", created_at: now - 2000, disabled_at: null },
        { id: mentorId, email: "mentor@migration.invalid", display_name: "Synthetic Mentor", password_hash: standardHash(), mentor_user_id: 74, role: "mentor", mode: "live", status: "active", created_at: now - 1000, disabled_at: null },
      ],
      auth_setup: [{ key: "first-admin:live", account_id: adminId, created_at: now - 2000 }],
      auth_invites: [{ id: randomUUID(), token_hash: createHash("sha256").update(INVITE_TOKEN).digest("hex"), email: "mentor@migration.invalid", display_name: "Synthetic Mentor", mentor_user_id: 74, mode: "live", created_by_account_id: adminId, created_at: now - 2000, expires_at: now + 3600_000, accepted_at: now - 1000, revoked_at: null, activated_account_id: mentorId }],
    },
  };
});

after(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });
beforeEach(async () => { directory = await mkdtemp(join(workspace, "case-")); });
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function assertPrivateOutput(result: CommandResult, input: ExportFixture): void {
  const output = result.stdout + result.stderr;
  const sensitive = [PASSWORD, INVITE_TOKEN, ...input.tables.auth_accounts.map((row) => row.password_hash), ...input.tables.auth_invites.map((row) => row.token_hash)].filter((value): value is string => typeof value === "string");
  for (const secret of sensitive) assert.equal(output.includes(secret), false, "The CLI output must not contain private fixture passwords, hashes or tokens.");
}

async function runImport(input: ExportFixture, dataDir = join(directory, "data")): Promise<CommandResult> {
  const exportFile = join(directory, `private-export-${randomUUID()}.json`);
  await writeFile(exportFile, JSON.stringify(input), { mode: 0o600 });
  const result = await new Promise<CommandResult>((resolveCommand, reject) => {
    execFile(process.execPath, [cliFile, exportFile, "--apply"], {
      cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { NODE_ENV: "test", PATH: process.env.PATH, DATA_DIR: dataDir, MIGRATIONS_DIR: migrationsDir, PORTAL_MODE: "live" },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolveCommand({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  assertPrivateOutput(result, input);
  return result;
}

async function counts(dataDir = join(directory, "data")) {
  const file = join(dataDir, "portal.sqlite");
  try { await access(file); } catch { return { accounts: 0, setup: 0, invites: 0, sessions: 0 }; }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { ...db.prepare("SELECT (SELECT COUNT(*) FROM auth_accounts) AS accounts, (SELECT COUNT(*) FROM auth_setup) AS setup, (SELECT COUNT(*) FROM auth_invites) AS invites, (SELECT COUNT(*) FROM auth_sessions) AS sessions").get() };
  } finally { db.close(); }
}

test("private CLI import preserves two standard hashes, supports login and repeats idempotently without importing sessions", async () => {
  const imported = await runImport(fixture);
  assert.equal(imported.code, 0, "A valid reviewed account export should import successfully.");
  assert.deepEqual(JSON.parse(imported.stdout.trim()), { event: "account_migration_complete", imported: { auth_accounts: 2, auth_setup: 1, auth_invites: 1 }, sessionsImported: 0 });
  assert.deepEqual(await counts(), { accounts: 2, setup: 1, invites: 1, sessions: 0 });
  const repeated = await runImport(fixture);
  assert.equal(repeated.code, 0);
  assert.deepEqual(JSON.parse(repeated.stdout.trim()).imported, { auth_accounts: 0, auth_setup: 0, auth_invites: 0 });
  assert.deepEqual(await counts(), { accounts: 2, setup: 1, invites: 1, sessions: 0 });
  const bindings = implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir, env: {} });
  try {
    const rows = (await bindings.DB.prepare("SELECT id,password_hash FROM auth_accounts ORDER BY id").all<{ id: string; password_hash: string }>()).results;
    for (const row of rows) assert.equal(row.password_hash === fixture.tables.auth_accounts.find((account) => account.id === row.id)!.password_hash, true, "Migration must preserve the original hash byte for byte.");
    const origin = "https://migration.test";
    const service = new implementation.AuthService(bindings.DB, { mode: "live", appOrigin: origin });
    const seed = await service.session(new Request(`${origin}/api/auth/session`));
    const csrf = (await seed.json() as { csrfToken: string }).csrfToken;
    const cookie = seed.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await service.login(new Request(`${origin}/api/auth/login`, { method: "POST", headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ email: "mentor@migration.invalid", password: PASSWORD }) }));
    assert.equal(response.status, 200);
    const user = (await response.json() as { user: { accountId: string; mentorUserId: number; role: string } }).user;
    assert.equal(user.accountId, fixture.tables.auth_accounts[1].id);
    assert.equal(user.mentorUserId, 74);
    assert.equal(user.role, "mentor");
  } finally { bindings.close(); }
});

test("a conflicting destination identity rolls back earlier account inserts and preserves the destination", async () => {
  const bindings = implementation.createStandaloneBindings({ dataDir: join(directory, "data"), migrationsDir, env: {} });
  const existingId = randomUUID();
  try {
    await bindings.DB.prepare("INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) VALUES (?,?,'Existing destination',?,999,'mentor','live','active',?,NULL)").bind(existingId, fixture.tables.auth_accounts[1].email, fixture.tables.auth_accounts[1].password_hash, Date.now()).run();
  } finally { bindings.close(); }
  const beforeCounts = await counts();
  const result = await runImport(fixture);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await counts(), beforeCounts);
  const db = new DatabaseSync(join(directory, "data", "portal.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT id,mentor_user_id,display_name FROM auth_accounts").get()!;
    assert.equal(row.id, existingId);
    assert.equal(row.mentor_user_id, 999);
    assert.equal(row.display_name, "Existing destination");
    assert.equal(db.prepare("SELECT id FROM auth_accounts WHERE id=?").get(fixture.tables.auth_accounts[0].id as string), undefined);
  } finally { db.close(); }
});

test("invalid source mappings are rejected atomically, including an accepted invitation linked to the wrong account", async () => {
  const cases: Array<(input: ExportFixture) => void> = [
    (input) => { input.tables.auth_accounts[1].mentor_user_id = 0; },
    (input) => { input.tables.auth_setup[0].account_id = input.tables.auth_accounts[1].id; },
    (input) => { input.tables.auth_invites[0].activated_account_id = input.tables.auth_accounts[0].id; },
    (input) => { input.tables.auth_invites[0].mentor_user_id = 75; },
    (input) => { input.tables.auth_invites[0].created_by_account_id = input.tables.auth_accounts[1].id; },
  ];
  for (const [index, corrupt] of cases.entries()) {
    const input = structuredClone(fixture);
    corrupt(input);
    const dataDir = join(directory, `mapping-${index}`);
    const result = await runImport(input, dataDir);
    assert.notEqual(result.code, 0, `Bad mapping case ${index} must be rejected before any account becomes available.`);
    assert.deepEqual(await counts(dataDir), { accounts: 0, setup: 0, invites: 0, sessions: 0 });
  }
});

test("pending invitations and non-timestamp invitation states cannot be imported as completed invitations", async () => {
  for (const [index, acceptedAt] of [null, "pending"].entries()) {
    const input = structuredClone(fixture);
    input.tables.auth_invites[0].accepted_at = acceptedAt;
    input.tables.auth_invites[0].revoked_at = null;
    input.tables.auth_invites[0].activated_account_id = acceptedAt === null ? null : input.tables.auth_accounts[1].id;
    const dataDir = join(directory, `pending-${index}`);
    const result = await runImport(input, dataDir);
    assert.notEqual(result.code, 0, "Only accepted or revoked invitations with valid timestamps may cross the migration boundary.");
    assert.deepEqual(await counts(dataDir), { accounts: 0, setup: 0, invites: 0, sessions: 0 });
  }
});

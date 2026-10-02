import { readFile } from "node:fs/promises";
import { getStandaloneBindings } from "../lib/standalone";
import { emailInput, mentorIdInput, nameInput } from "../lib/auth/validation";

const path = process.argv[2];
if (!path || !process.argv.includes("--apply")) throw new Error("Usage: import-auth <private-export.json> --apply");
let input: { schemaVersion?: number; tables?: Record<string, Record<string, unknown>[]> };
try { input = JSON.parse(await readFile(path, "utf8")); }
catch { throw new Error("The private account export could not be read as JSON."); }
if (input.schemaVersion !== 1 || !input.tables) throw new Error("Invalid account migration format.");
const columns = {
  auth_accounts: ["id", "email", "display_name", "password_hash", "mentor_user_id", "role", "mode", "status", "created_at", "disabled_at"],
  auth_setup: ["key", "account_id", "created_at"],
  auth_invites: ["id", "token_hash", "email", "display_name", "mentor_user_id", "mode", "created_by_account_id", "created_at", "expires_at", "accepted_at", "revoked_at", "activated_account_id"],
} as const;
if (Object.keys(input.tables).some(name => !(name in columns))) throw new Error("Only account bootstrap and invitation records can be imported.");
const accounts = input.tables.auth_accounts;
if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 1000) throw new Error("Invalid account count.");
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^pbkdf2-sha256\$600000\$[A-Za-z0-9_-]{32}\$[A-Za-z0-9_-]{43}$/;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
for (const account of accounts) {
  if (account.mode !== "live" || !id.test(String(account.id)) || !hash.test(String(account.password_hash)) || !["admin", "mentor"].includes(String(account.role)) || !["active", "disabled"].includes(String(account.status))) throw new Error("Invalid live account record.");
  if (!Number.isSafeInteger(account.mentor_user_id) || (account.role === "admin" ? account.mentor_user_id !== 0 : Number(account.mentor_user_id) <= 0)) throw new Error("Invalid source identity mapping.");
  if (emailInput(account.email) !== account.email || nameInput(account.display_name) !== account.display_name || !timestamp(account.created_at) || !nullableTimestamp(account.disabled_at)) throw new Error("Account fields are not in the canonical stored format.");
  if (account.role === "mentor") mentorIdInput(account.mentor_user_id);
}
if (accounts.filter(row => row.role === "admin").length !== 1) throw new Error("Exactly one existing administrator is required for this migration.");
const knownIds = new Set(accounts.map(row => row.id));
if (knownIds.size !== accounts.length || new Set(accounts.map(row => row.email)).size !== accounts.length) throw new Error("Duplicate account records are not accepted.");
if (input.tables.auth_setup?.length !== 1) throw new Error("The existing administrator bootstrap record is required.");
for (const setup of input.tables.auth_setup ?? []) if (setup.key !== "first-admin:live" || !timestamp(setup.created_at) || !accounts.some(row => row.id === setup.account_id && row.role === "admin")) throw new Error("Invalid administrator bootstrap mapping.");
for (const invite of input.tables.auth_invites ?? []) {
  if (invite.mode !== "live" || !id.test(String(invite.id)) || !/^[a-f0-9]{64}$/.test(String(invite.token_hash)) || !accounts.some(row => row.id === invite.created_by_account_id && row.role === "admin")) throw new Error("Invitation account mapping is incomplete.");
  if (emailInput(invite.email) !== invite.email || nameInput(invite.display_name) !== invite.display_name || !timestamp(invite.created_at) || !timestamp(invite.expires_at) || Number(invite.expires_at) <= Number(invite.created_at) || !nullableTimestamp(invite.accepted_at) || !nullableTimestamp(invite.revoked_at)) throw new Error("Invalid invitation fields.");
  mentorIdInput(invite.mentor_user_id);
  if (invite.accepted_at !== null) {
    const target = accounts.find(row => row.id === invite.activated_account_id);
    if (!target || target.role !== "mentor" || target.email !== invite.email || target.mentor_user_id !== invite.mentor_user_id || Number(invite.accepted_at) < Number(invite.created_at) || Number(invite.accepted_at) >= Number(invite.expires_at)) throw new Error("Accepted invitation does not match its Mentor account.");
  } else if (invite.activated_account_id !== null) throw new Error("An unaccepted invitation cannot have an activated account.");
  if (invite.revoked_at !== null && Number(invite.revoked_at) < Number(invite.created_at)) throw new Error("Invalid invitation revocation time.");
  if (invite.accepted_at === null && invite.revoked_at === null) throw new Error("Outstanding invitations require a cutover decision before import.");
}

const bindings = getStandaloneBindings();
try {
  const statements: D1PreparedStatement[] = [];
  const counts: Record<string, number> = {};
  for (const [table, fields] of Object.entries(columns)) {
    const rows = input.tables[table] ?? [];
    if (!Array.isArray(rows) || rows.length > 2000) throw new Error("Migration table is too large.");
    counts[table] = 0;
    for (const row of rows) {
      if (Object.keys(row).length !== fields.length || fields.some(field => !(field in row))) throw new Error("Migration columns do not match the reviewed schema.");
      const key = table === "auth_setup" ? "key" : "id";
      const existing = await bindings.DB.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).bind(row[key]).first<Record<string, unknown>>();
      if (existing) {
        if (fields.some(field => existing[field] !== row[field])) throw new Error("Destination has a conflicting account record; nothing was overwritten.");
        continue;
      }
      statements.push(bindings.DB.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).bind(...fields.map(field => row[field])));
      counts[table]++;
    }
  }
  if (statements.length) await bindings.DB.batch(statements);
  console.log(JSON.stringify({ event: "account_migration_complete", imported: counts, sessionsImported: 0 }));
} finally { bindings.close(); }

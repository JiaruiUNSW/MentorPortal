import type { Principal } from "../runtime";
import { consumePasswordWork, hashPassword, hashToken, randomToken, secretEqual, verifyPassword } from "./crypto";
import { AuthError } from "./errors";
import { applicationOrigin, checkCsrf, checkOrigin, cookieNames, csrfForToken, getCookie, requestSource, setCookie } from "./security";
import { emailInput, identifierInput, invalid, mentorIdInput, nameInput, passwordInput, readAuthJson } from "./validation";

type Mode = Principal["mode"];
interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  mentor_user_id: number;
  role: Principal["role"];
  mode: Mode;
  status: "active" | "disabled";
  created_at: number;
}
interface SessionRow extends AccountRow {
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
}
interface InviteRow {
  id: string;
  email: string;
  display_name: string;
  mentor_user_id: number;
  mode: Mode;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}
interface ServiceOptions {
  mode: Mode;
  appOrigin?: string;
  trustProxy?: boolean;
  setupToken?: string;
  liveWritesEnabled?: boolean;
  now?: () => number;
}
type SessionContext = { principal: Principal; token: string; tokenHash: string };

const UNAUTHENTICATED = () => new AuthError(401, "UNAUTHENTICATED", "Please sign in to continue.");
const INVALID_INVITE = () => new AuthError(410, "INVITE_INVALID", "This invitation is unavailable or has expired. Ask your administrator for a new invitation.");
const GENERIC_LOGIN = () => new AuthError(401, "INVALID_CREDENTIALS", "The email or password is incorrect, or this account is unavailable.");

function principalFromRow(row: AccountRow): Principal {
  return { accountId: row.id, email: row.email, displayName: row.display_name, mentorUserId: row.mentor_user_id, role: row.role, mode: row.mode };
}

export class AuthService {
  private readonly db: D1Database;
  readonly mode: Mode;
  readonly readOnly: boolean;
  private readonly appOrigin?: string;
  private readonly trustProxy: boolean;
  private readonly setupToken?: string;
  private readonly clock: () => number;

  constructor(db: D1Database, options: ServiceOptions) {
    this.db = db;
    this.mode = options.mode;
    this.readOnly = options.mode === 'live' && options.liveWritesEnabled !== true;
    this.appOrigin = options.appOrigin;
    this.trustProxy = options.trustProxy === true;
    this.setupToken = options.setupToken;
    this.clock = options.now ?? Date.now;
  }

  json(value: unknown, status = 200, cookies: string[] = []): Response {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify(value), { status, headers });
  }

  errorResponse(error: unknown): Response {
    const known = error instanceof AuthError ? error : new AuthError(503, "AUTH_UNAVAILABLE", "Account access is temporarily unavailable. Please try again later.");
    const response = this.json({ error: { code: known.code, message: known.message }, mode: this.mode }, known.status);
    if (known.retryAfter) response.headers.set("Retry-After", String(known.retryAfter));
    return response;
  }

  private async sessionContext(request: Request): Promise<SessionContext | null> {
    const token = getCookie(request, cookieNames(request, this.appOrigin).session);
    if (!token) return null;
    const tokenHash = await hashToken(token);
    const row = await this.db.prepare(`SELECT a.*, s.token_hash, s.expires_at, s.revoked_at FROM auth_sessions s JOIN auth_accounts a ON a.id = s.account_id WHERE s.token_hash = ?`).bind(tokenHash).first<SessionRow>();
    if (!row || row.revoked_at !== null || row.expires_at <= this.clock() || row.status !== "active" || row.mode !== this.mode) return null;
    if ((row.role !== "mentor" && row.role !== "admin") || (row.role === "admin" ? row.mentor_user_id !== 0 : row.mentor_user_id <= 0)) return null;
    return { principal: principalFromRow(row), token, tokenHash };
  }

  async requireSession(request: Request): Promise<Principal> {
    const context = await this.sessionContext(request);
    if (!context) throw UNAUTHENTICATED();
    return context.principal;
  }

  async requireAdmin(request: Request): Promise<Principal> {
    const principal = await this.requireSession(request);
    if (principal.role !== "admin") throw new AuthError(403, "ADMIN_REQUIRED", "An account administrator is required for this action.");
    return principal;
  }

  async requireMutationProtection(request: Request): Promise<void> {
    checkOrigin(request, this.appOrigin);
    const context = await this.sessionContext(request);
    const token = context?.token ?? getCookie(request, cookieNames(request, this.appOrigin).csrf);
    await checkCsrf(request, token);
  }

  async session(request: Request): Promise<Response> {
    applicationOrigin(request, this.appOrigin);
    const context = await this.sessionContext(request);
    if (context) return this.json({ user: context.principal, mode: this.mode, readOnly: this.readOnly, csrfToken: await csrfForToken(context.token) });
    const token = getCookie(request, cookieNames(request, this.appOrigin).csrf) ?? randomToken();
    return this.json({ user: null, mode: this.mode, readOnly: this.readOnly, csrfToken: await csrfForToken(token), error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } }, 401, [setCookie(request, "csrf", token, 3600, this.appOrigin), setCookie(request, "session", "", 0, this.appOrigin)]);
  }

  private async rateLimit(request: Request, action: string, limit: number, windowSeconds: number, email?: string): Promise<void> {
    const now = this.clock();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;
    const subjects = [`ip:${requestSource(request, { trustProxy: this.trustProxy, appOrigin: this.appOrigin })}`];
    if (email) subjects.push(`email:${email}`);
    const keys = await Promise.all(subjects.map(async (subject) => `${await hashToken(`${this.mode}:${action}:${subject}`)}:${windowStart}`));
    const results = await this.db.batch<{ hits: number }>(keys.map((key) => this.db.prepare(`INSERT INTO auth_rate_limits (key, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(key, expiresAt)));
    const exceeded = results.some((result) => (result.results[0]?.hits ?? limit + 1) > limit);
    if (exceeded) throw new AuthError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", Math.max(1, Math.ceil((expiresAt - now) / 1000)));
  }

  private async finishLogin(request: Request, principal: Principal, status = 200): Promise<Response> {
    const now = this.clock();
    const maxAge = principal.role === "admin" ? 12 * 3600 : 7 * 24 * 3600;
    const token = randomToken();
    const tokenHash = await hashToken(token);
    const old = getCookie(request, cookieNames(request, this.appOrigin).session);
    const statements = [this.db.prepare(`INSERT INTO auth_sessions (token_hash, account_id, created_at, expires_at, revoked_at) SELECT ?, id, ?, ?, NULL FROM auth_accounts WHERE id = ? AND status = 'active' AND mode = ?`).bind(tokenHash, now, now + maxAge * 1000, principal.accountId, this.mode)];
    if (old) statements.push(this.db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).bind(now, await hashToken(old)));
    statements.push(this.db.prepare(`DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE expires_at < ? LIMIT 100)`).bind(now));
    statements.push(this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at < ? LIMIT 100)`).bind(now - 24 * 3600 * 1000));
    const results = await this.db.batch(statements);
    if (results[0].meta.changes !== 1) throw UNAUTHENTICATED();
    return this.json({ user: principal, mode: this.mode, readOnly: this.readOnly, csrfToken: await csrfForToken(token) }, status, [setCookie(request, "session", token, maxAge, this.appOrigin), setCookie(request, "csrf", "", 0, this.appOrigin)]);
  }

  async login(request: Request): Promise<Response> {
    await this.requireMutationProtection(request);
    const body = await readAuthJson(request, ["email", "password"]);
    const email = emailInput(body.email);
    const password = passwordInput(body.password);
    await this.rateLimit(request, "login", 10, 15 * 60, email);
    const account = await this.db.prepare(`SELECT * FROM auth_accounts WHERE email = ? AND mode = ?`).bind(email, this.mode).first<AccountRow>();
    if (!account?.password_hash) { await consumePasswordWork(password); throw GENERIC_LOGIN(); }
    const verified = await verifyPassword(password, account.password_hash);
    if (!verified || account.status !== "active") throw GENERIC_LOGIN();
    return this.finishLogin(request, principalFromRow(account));
  }

  async demo(request: Request): Promise<Response> {
    if (this.mode !== "demo") throw new AuthError(404, "DEMO_UNAVAILABLE", "Preview access is unavailable.");
    await this.requireMutationProtection(request);
    await readAuthJson(request, []);
    const current = await this.sessionContext(request);
    if (current?.principal.role === "mentor") return this.json({ user: current.principal, mode: this.mode, readOnly: this.readOnly, csrfToken: await csrfForToken(current.token) });
    await this.rateLimit(request, "demo", 20, 3600);
    const accountId = crypto.randomUUID();
    const principal: Principal = { accountId, email: `preview.${accountId}@example.invalid`, displayName: "Alex Morgan", mentorUserId: 1, role: "mentor", mode: "demo" };
    await this.db.prepare(`INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) VALUES (?,?,?,NULL,1,'mentor','demo','active',?,NULL)`).bind(accountId, principal.email, principal.displayName, this.clock()).run();
    return this.finishLogin(request, principal);
  }

  async logout(request: Request): Promise<Response> {
    await this.requireMutationProtection(request);
    await readAuthJson(request, []);
    const token = getCookie(request, cookieNames(request, this.appOrigin).session);
    if (token) await this.db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).bind(this.clock(), await hashToken(token)).run();
    const csrf = randomToken();
    return this.json({ user: null, mode: this.mode, readOnly: this.readOnly, csrfToken: await csrfForToken(csrf) }, 200, [setCookie(request, "session", "", 0, this.appOrigin), setCookie(request, "csrf", csrf, 3600, this.appOrigin)]);
  }

  async setup(request: Request): Promise<Response> {
    await this.requireMutationProtection(request);
    await this.rateLimit(request, "setup", 5, 3600);
    if (!this.setupToken || this.setupToken.length < 32) throw new AuthError(503, "AUTH_UNAVAILABLE", "Account setup is not enabled. Contact the portal owner.");
    const body = await readAuthJson(request, ["setupToken", "email", "displayName", "password"]);
    if (typeof body.setupToken !== "string" || body.setupToken.length > 512 || !await secretEqual(body.setupToken, this.setupToken)) throw new AuthError(403, "SETUP_DENIED", "The setup token is incorrect.");
    const email = emailInput(body.email);
    const displayName = nameInput(body.displayName);
    const password = passwordInput(body.password);
    const setupKey = `first-admin:${this.mode}`;
    if (await this.db.prepare(`SELECT key FROM auth_setup WHERE key = ?`).bind(setupKey).first()) throw new AuthError(409, "SETUP_COMPLETE", "The administrator account has already been created.");
    if (await this.db.prepare(`SELECT id FROM auth_accounts WHERE email = ? AND mode = ?`).bind(email, this.mode).first()) throw new AuthError(409, "ACCOUNT_EXISTS", "An account already uses this email. Choose a separate administrator email.");
    const accountId = crypto.randomUUID();
    const now = this.clock();
    const passwordHash = await hashPassword(password);
    let result: D1Result[];
    try {
      result = await this.db.batch([
        this.db.prepare(`INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) SELECT ?,?,?,?,0,'admin',?,'active',?,NULL WHERE NOT EXISTS (SELECT 1 FROM auth_setup WHERE key = ?) AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE role = 'admin' AND mode = ?)`).bind(accountId, email, displayName, passwordHash, this.mode, now, setupKey, this.mode),
        this.db.prepare(`INSERT INTO auth_setup (key,account_id,created_at) SELECT ?,id,? FROM auth_accounts WHERE id = ?`).bind(setupKey, now, accountId),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new AuthError(409, "ACCOUNT_EXISTS", "An account already uses this email. Choose a separate administrator email.");
      throw error;
    }
    if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) throw new AuthError(409, "SETUP_COMPLETE", "The administrator account has already been created.");
    return this.finishLogin(request, { accountId, email, displayName, mentorUserId: 0, role: "admin", mode: this.mode }, 201);
  }

  async activate(request: Request): Promise<Response> {
    await this.requireMutationProtection(request);
    await this.rateLimit(request, "activate", 10, 15 * 60);
    const body = await readAuthJson(request, ["token", "password"]);
    const token = identifierInput(body.token, "invitation token");
    const password = passwordInput(body.password);
    const tokenHash = await hashToken(token);
    const now = this.clock();
    const invite = await this.db.prepare(`SELECT * FROM auth_invites WHERE token_hash = ? AND mode = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).bind(tokenHash, this.mode, now).first<InviteRow>();
    if (!invite) throw INVALID_INVITE();
    const accountId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const activatedAt = this.clock();
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`INSERT INTO auth_accounts (id,email,display_name,password_hash,mentor_user_id,role,mode,status,created_at,disabled_at) SELECT ?,email,display_name,?,mentor_user_id,'mentor',mode,'active',?,NULL FROM auth_invites WHERE id = ? AND token_hash = ? AND mode = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).bind(accountId, passwordHash, activatedAt, invite.id, tokenHash, this.mode, activatedAt),
        this.db.prepare(`UPDATE auth_invites SET accepted_at = ?, activated_account_id = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = ?)`).bind(activatedAt, accountId, invite.id, activatedAt, accountId),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new AuthError(409, "ACCOUNT_EXISTS", "An account already uses this email or Mentor record. Contact your administrator.");
      throw error;
    }
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw INVALID_INVITE();
    return this.finishLogin(request, { accountId, email: invite.email, displayName: invite.display_name, mentorUserId: invite.mentor_user_id, role: "mentor", mode: this.mode }, 201);
  }

  async accounts(request: Request): Promise<Response> {
    await this.requireAdmin(request);
    const result = await this.db.prepare(`SELECT id AS accountId,email,display_name AS displayName,mentor_user_id AS mentorUserId,role,mode,status,created_at AS createdAt FROM auth_accounts WHERE mode = ? ORDER BY created_at DESC LIMIT 100`).bind(this.mode).all();
    return this.json({ items: result.results, nextCursor: null });
  }

  async invites(request: Request): Promise<Response> {
    await this.requireAdmin(request);
    const result = await this.db.prepare(`SELECT id AS inviteId,email,display_name AS displayName,mentor_user_id AS mentorUserId,mode,created_at AS createdAt,expires_at AS expiresAt,accepted_at AS acceptedAt,revoked_at AS revokedAt FROM auth_invites WHERE mode = ? ORDER BY created_at DESC LIMIT 100`).bind(this.mode).all();
    return this.json({ items: result.results, nextCursor: null });
  }

  async createInvite(request: Request): Promise<Response> {
    const admin = await this.requireAdmin(request);
    await this.requireMutationProtection(request);
    await this.rateLimit(request, "invite", 30, 3600);
    const body = await readAuthJson(request, ["email", "displayName", "mentorUserId", "expiresInHours"]);
    const email = emailInput(body.email);
    const displayName = nameInput(body.displayName);
    const mentorUserId = mentorIdInput(body.mentorUserId);
    const hours = body.expiresInHours ?? 72;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) return invalid("Invitation lifetime must be 1–168 hours.");
    const existing = await this.db.prepare(`SELECT id FROM auth_accounts WHERE mode = ? AND (email = ? OR (mode = 'live' AND mentor_user_id = ?)) LIMIT 1`).bind(this.mode, email, mentorUserId).first();
    if (existing) throw new AuthError(409, "ACCOUNT_EXISTS", "An account already uses this email or Mentor record.");
    const inviteId = crypto.randomUUID();
    const token = randomToken();
    const now = this.clock();
    const expiresAt = now + hours * 3600 * 1000;
    await this.db.batch([
      this.db.prepare(`UPDATE auth_invites SET revoked_at = ? WHERE mode = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`).bind(now, this.mode, email),
      this.db.prepare(`INSERT INTO auth_invites (id,token_hash,email,display_name,mentor_user_id,mode,created_by_account_id,created_at,expires_at,accepted_at,revoked_at,activated_account_id) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`).bind(inviteId, await hashToken(token), email, displayName, mentorUserId, this.mode, admin.accountId, now, expiresAt),
    ]);
    return this.json({ invite: { inviteId, email, displayName, mentorUserId, mode: this.mode, expiresAt }, activationUrl: `${applicationOrigin(request, this.appOrigin)}/activate#token=${token}` }, 201);
  }

  async revokeInvite(request: Request): Promise<Response> {
    await this.requireAdmin(request);
    await this.requireMutationProtection(request);
    const body = await readAuthJson(request, ["inviteId"]);
    const inviteId = identifierInput(body.inviteId, "invitation ID");
    const result = await this.db.prepare(`UPDATE auth_invites SET revoked_at = ? WHERE id = ? AND mode = ? AND accepted_at IS NULL`).bind(this.clock(), inviteId, this.mode).run();
    if (!result.meta.changes) throw new AuthError(404, "INVITE_NOT_FOUND", "This unused invitation was not found.");
    return this.json({ ok: true });
  }

  async revokeAccount(request: Request): Promise<Response> {
    await this.requireAdmin(request);
    await this.requireMutationProtection(request);
    const body = await readAuthJson(request, ["accountId"]);
    const accountId = identifierInput(body.accountId, "account ID");
    const now = this.clock();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE auth_accounts SET status = 'disabled', disabled_at = ? WHERE id = ? AND mode = ? AND role = 'mentor'`).bind(now, accountId, this.mode),
      this.db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM auth_accounts WHERE id = ? AND mode = ? AND role = 'mentor' AND status = 'disabled')`).bind(now, accountId, accountId, this.mode),
      this.db.prepare(`UPDATE auth_invites SET revoked_at = ? WHERE mode = ? AND accepted_at IS NULL AND revoked_at IS NULL AND email IN (SELECT email FROM auth_accounts WHERE id = ? AND mode = ? AND role = 'mentor' AND status = 'disabled')`).bind(now, this.mode, accountId, this.mode),
    ]);
    if (!results[0].meta.changes) throw new AuthError(404, "ACCOUNT_NOT_FOUND", "This Mentor account was not found.");
    return this.json({ ok: true });
  }
}

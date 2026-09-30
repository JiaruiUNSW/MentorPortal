import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const authAccounts = sqliteTable("auth_accounts", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  mentorUserId: integer("mentor_user_id").notNull(),
  role: text("role", { enum: ["mentor", "admin"] }).notNull(),
  mode: text("mode", { enum: ["demo", "live"] }).notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  disabledAt: integer("disabled_at"),
}, (table) => [
  uniqueIndex("auth_accounts_email_mode").on(table.email, table.mode),
  uniqueIndex("auth_accounts_live_mentor").on(table.mentorUserId).where(sql`${table.mode} = 'live' AND ${table.role} = 'mentor'`),
  check("auth_accounts_role", sql`${table.role} IN ('mentor', 'admin')`),
  check("auth_accounts_mode", sql`${table.mode} IN ('demo', 'live')`),
  check("auth_accounts_status", sql`${table.status} IN ('active', 'disabled')`),
  check("auth_accounts_mapping", sql`(${table.role} = 'admin' AND ${table.mentorUserId} = 0) OR (${table.role} = 'mentor' AND ${table.mentorUserId} > 0)`),
]);

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: text("account_id").notNull().references(() => authAccounts.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
}, (table) => [
  index("auth_sessions_account").on(table.accountId),
  index("auth_sessions_expiry").on(table.expiresAt),
]);

export const authInvites = sqliteTable("auth_invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  mentorUserId: integer("mentor_user_id").notNull(),
  mode: text("mode", { enum: ["demo", "live"] }).notNull(),
  createdByAccountId: text("created_by_account_id").notNull().references(() => authAccounts.id),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  acceptedAt: integer("accepted_at"),
  revokedAt: integer("revoked_at"),
  activatedAccountId: text("activated_account_id").references(() => authAccounts.id),
}, (table) => [
  index("auth_invites_email_mode").on(table.email, table.mode),
  index("auth_invites_expiry").on(table.expiresAt),
  check("auth_invites_mode", sql`${table.mode} IN ('demo', 'live')`),
  check("auth_invites_mapping", sql`${table.mentorUserId} > 0`),
]);

export const authSetup = sqliteTable("auth_setup", {
  key: text("key").primaryKey(),
  accountId: text("account_id").notNull().references(() => authAccounts.id),
  createdAt: integer("created_at").notNull(),
});

export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("auth_rate_limits_expiry").on(table.expiresAt)]);

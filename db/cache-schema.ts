import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Each namespace is a complete, account-scoped last-good snapshot. No shared personal catalog. */
export const mentorCacheSnapshots = sqliteTable('mentor_cache_snapshots', {
  accountId: text('account_id').notNull(),
  mentorUserId: integer('mentor_user_id').notNull(),
  namespace: text('namespace', { enum: ['private', 'catalog'] }).notNull(),
  generation: text('generation').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  syncedAt: integer('synced_at').notNull(),
  refreshAfter: integer('refresh_after').notNull(),
  hardExpiresAt: integer('hard_expires_at').notNull(),
  invalidationVersion: integer('invalidation_version').notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.mentorUserId, table.namespace] }),
  check('mentor_cache_namespace', sql`${table.namespace} IN ('private','catalog')`),
  check('mentor_cache_snapshot_mentor', sql`${table.mentorUserId} > 0`),
]);

/** A fenced lease serializes account syncs; an expired lease can be recovered after restart. */
export const mentorCacheSyncState = sqliteTable('mentor_cache_sync_state', {
  accountId: text('account_id').notNull(),
  mentorUserId: integer('mentor_user_id').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: integer('lease_expires_at').notNull().default(0),
  commitToken: text('commit_token'),
  invalidationVersion: integer('invalidation_version').notNull().default(0),
  nextPrivateSyncAt: integer('next_private_sync_at').notNull().default(0),
  nextCatalogSyncAt: integer('next_catalog_sync_at').notNull().default(0),
  nextRedemptionSyncAt: integer('next_redemption_sync_at'),
  authorizationState: text('authorization_state', { enum: ['unknown', 'authorized', 'denied'] }).notNull().default('unknown'),
  failureCount: integer('failure_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  lastAttemptAt: integer('last_attempt_at'),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.mentorUserId] }),
  index('mentor_cache_private_due').on(table.nextPrivateSyncAt),
  index('mentor_cache_catalog_due').on(table.nextCatalogSyncAt),
  index('mentor_cache_redemption_due').on(table.nextRedemptionSyncAt),
  check('mentor_cache_authorization_state', sql`${table.authorizationState} IN ('unknown','authorized','denied')`),
  check('mentor_cache_sync_mentor', sql`${table.mentorUserId} > 0`),
]);

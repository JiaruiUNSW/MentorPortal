import { integer, primaryKey, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Synthetic preview state is isolated by authenticated account; no shared fixture owner. */
export const mentorDemoState = sqliteTable('mentor_demo_state', {
  accountId: text('account_id').primaryKey(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull().default(0),
  mutationToken: text('mutation_token'),
  updatedAt: integer('updated_at').notNull(),
});

/** The unique key claims one intent; ambiguous live writes are never reclaimed by lease expiry. */
export const mentorRequests = sqliteTable('mentor_requests', {
  accountId: text('account_id').notNull(),
  mode: text('mode').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestId: text('request_id').notNull(),
  operation: text('operation').notNull(),
  payloadHash: text('payload_hash').notNull(),
  state: text('state').notNull(),
  leaseToken: text('lease_token').notNull(),
  leaseExpiresAt: integer('lease_expires_at').notNull(),
  responseJson: text('response_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.mode, t.idempotencyKey] })]);

/** Portal-only serialization; a dispatched/uncertain source write needs reconciliation. */
export const mentorResourceLocks = sqliteTable('mentor_resource_locks', {
  resourceKey: text('resource_key').primaryKey(),
  requestId: text('request_id').notNull(),
  ownerAccountId: text('owner_account_id').notNull(),
  leaseToken: text('lease_token').notNull(),
  leaseExpiresAt: integer('lease_expires_at').notNull(),
  state: text('state', { enum: ['pending', 'dispatched', 'uncertain'] }).notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('mentor_resource_request').on(t.requestId)]);

export const mentorFiles = sqliteTable('mentor_files', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  mode: text('mode').notNull(),
  parentKind: text('parent_kind').notNull(),
  parentId: text('parent_id'),
  groupId: text('group_id'),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  objectKey: text('object_key').notNull(),
  state: text('state').notNull(),
  requestId: text('request_id').notNull(),
  sourceAttachmentId: text('source_attachment_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('mentor_files_owner').on(t.accountId, t.mode, t.state)]);

export const mentorAudit = sqliteTable('mentor_audit', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  mode: text('mode').notNull(),
  requestId: text('request_id').notNull(),
  operation: text('operation').notNull(),
  entityId: text('entity_id'),
  outcome: text('outcome').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Durable acceptance is separate from the upstream write claim and its uncertainty fence. */
export const mentorAsyncJobs = sqliteTable('mentor_async_jobs', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  accountId: text('account_id').notNull(),
  mentorUserId: integer('mentor_user_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestId: text('request_id').notNull(),
  operation: text('operation').notNull(),
  groupId: text('group_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  requestJson: text('request_json').notNull(),
  attachmentsJson: text('attachments_json').notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'needs_review'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  canRetry: integer('can_retry').notNull().default(0),
  retryAfter: integer('retry_after').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseExpiresAt: integer('lease_expires_at').notNull().default(0),
  dispatchStartedAt: integer('dispatch_started_at'),
  responseJson: text('response_json'),
  errorJson: text('error_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('mentor_async_idempotency').on(t.accountId, t.idempotencyKey),
  index('mentor_async_due').on(t.status, t.sequence),
  index('mentor_async_group').on(t.groupId, t.status, t.sequence),
  index('mentor_async_owner').on(t.accountId, t.mentorUserId, t.sequence),
]);

/** Pin metadata and bytes until a known outcome; uncertain submissions retain their pins. */
export const mentorAsyncFiles = sqliteTable('mentor_async_files', {
  fileId: text('file_id').primaryKey().references(() => mentorFiles.id),
  jobId: text('job_id').notNull().references(() => mentorAsyncJobs.id, { onDelete: 'cascade' }),
  snapshotJson: text('snapshot_json').notNull(),
}, (t) => [index('mentor_async_files_job').on(t.jobId)]);

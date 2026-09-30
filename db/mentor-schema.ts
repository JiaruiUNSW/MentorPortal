import { integer, primaryKey, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/** Synthetic preview state is isolated by authenticated account; no shared fixture owner. */
export const mentorDemoState = sqliteTable('mentor_demo_state', {
  accountId: text('account_id').primaryKey(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull().default(0),
  mutationToken: text('mutation_token'),
  updatedAt: integer('updated_at').notNull(),
});

/** The unique key is the atomic claim; leases are only recoverable for demo writes. */
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

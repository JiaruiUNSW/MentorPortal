import type { OperationResults } from '../contracts';
import type { PortalBindings } from '../runtime';

export type CacheNamespace = 'private' | 'catalog';
export type CacheBindings = PortalBindings & {
  MENTOR_CACHE_ENABLED?: string;
  MENTOR_CACHE_PRIVATE_TTL_HOURS?: string;
  MENTOR_CACHE_CATALOG_TTL_HOURS?: string;
  MENTOR_CACHE_MAX_STALE_HOURS?: string;
  MENTOR_SYNC_ALLOWED_USER_IDS?: string;
};
export interface CacheConfig {
  enabled: boolean;
  privateTtlMs: number;
  catalogTtlMs: number;
  hardAgeMs: number;
  allowedUserIds: Set<number>;
}
export interface PrivateSnapshot {
  schemaVersion: 1;
  bootstrap: OperationResults['bootstrap'];
  profile: OperationResults['profile.get'];
  balance: OperationResults['balance.get'];
  groups: OperationResults['groups.get'][];
  transactions: OperationResults['transactions.list']['items'];
  tickets: OperationResults['tickets.get']['ticket'][];
  redemptions: OperationResults['redemptions.list']['items'];
}
export interface CatalogSnapshot {
  schemaVersion: 1;
  rewards: OperationResults['rewards.get'][];
}
export interface SnapshotRow {
  account_id: string;
  mentor_user_id: number;
  namespace: CacheNamespace;
  generation: string;
  snapshot_json: string;
  synced_at: number;
  refresh_after: number;
  hard_expires_at: number;
  invalidation_version: number;
}
export interface SyncState {
  account_id: string;
  mentor_user_id: number;
  lease_token: string | null;
  lease_expires_at: number;
  commit_token: string | null;
  invalidation_version: number;
  next_private_sync_at: number;
  next_catalog_sync_at: number;
  authorization_state: 'unknown' | 'authorized' | 'denied';
  failure_count: number;
  last_error_code: string | null;
  last_attempt_at: number | null;
}
export interface SyncLimits {
  maxPages: number;
  maxListItems: number;
  maxGroups: number;
  maxTickets: number;
  maxRewards: number;
  maxSnapshotBytes: number;
  maxRequests: number;
}
export interface SyncOptions {
  /** Tests may inject a synthetic HTTP adapter; production defaults to existing callFlow. */
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  force?: boolean;
  namespaces?: CacheNamespace[];
  leaseMs?: number;
  minimumRequestIntervalMs?: number;
  retryDelayMs?: number;
  limits?: Partial<SyncLimits>;
  maxAccounts?: number;
}
export interface SyncResult {
  accountId: string;
  mentorUserId: number;
  status: 'synced' | 'not_due' | 'busy' | 'disabled' | 'not_allowed' | 'denied' | 'failed' | 'superseded';
  namespaces: CacheNamespace[];
  syncedAt?: string;
  errorCode?: string;
}
export interface Lease {
  token: string;
  version: number;
  state: SyncState;
}

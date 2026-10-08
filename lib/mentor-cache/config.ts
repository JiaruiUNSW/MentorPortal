import { fail } from '../mentor-data/errors';
import type { RedemptionDto } from '../contracts';
import type { CacheBindings, CacheConfig, SyncLimits, SyncOptions } from './types';

const HOUR = 3_600_000;
export const REDEMPTION_REFRESH_INTERVAL_MS = 5 * 60_000;
export const SOURCE_AUTH_DENIALS = new Set(['MENTOR_FORBIDDEN', 'OWNERSHIP_DENIED', 'BRIDGE_UNAUTHORIZED']);
export function hasUnsettledRedemptions(items: RedemptionDto[]): boolean {
  return items.some(item => {
    if (item.status === 'needs_review') return false;
    if (item.status === 'approved' && item.creditState === 'debited') return false;
    if (item.status === 'rejected' && item.creditState === 'refunded') return false;
    return true; // Pending/processing, or an incomplete/unknown terminal credit state.
  });
}
function hours(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback * HOUR;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 72) fail('DRAFT_NOT_CONFIGURED', 'Cache intervals must be between one and 72 hours.', 503);
  return Number(value) * HOUR;
}
export function cacheConfig(bindings: CacheBindings): CacheConfig {
  const privateTtlMs = hours(bindings.MENTOR_CACHE_PRIVATE_TTL_HOURS, 24);
  const catalogTtlMs = hours(bindings.MENTOR_CACHE_CATALOG_TTL_HOURS, 48);
  const hardAgeMs = hours(bindings.MENTOR_CACHE_MAX_STALE_HOURS, 72);
  if (privateTtlMs > hardAgeMs || catalogTtlMs > hardAgeMs) fail('DRAFT_NOT_CONFIGURED', 'Cache refresh intervals cannot exceed the maximum snapshot age.', 503);
  return { enabled: bindings.MENTOR_CACHE_ENABLED === 'true', privateTtlMs, catalogTtlMs, hardAgeMs };
}
export const DEFAULT_LIMITS: SyncLimits = {
  maxPages: 40, maxListItems: 2000, maxGroups: 100, maxTickets: 500,
  maxRewards: 500, maxSnapshotBytes: 8 * 1024 * 1024, maxRequests: 1300,
};
export function syncLimits(options: SyncOptions): SyncLimits {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof SyncLimits]) fail('VALIDATION_ERROR', 'A synchronization limit is invalid.');
  }
  return limits;
}
export function duration(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('VALIDATION_ERROR', 'A synchronization timing option is invalid.');
  return value;
}

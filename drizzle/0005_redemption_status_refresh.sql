ALTER TABLE `mentor_cache_sync_state` ADD `next_redemption_sync_at` integer;--> statement-breakpoint
CREATE INDEX `mentor_cache_redemption_due` ON `mentor_cache_sync_state` (`next_redemption_sync_at`);
--> statement-breakpoint
-- Existing pending snapshots start polling without advancing their daily source timestamps.
UPDATE mentor_cache_sync_state
SET next_redemption_sync_at = (
  SELECT s.synced_at + 300000 FROM mentor_cache_snapshots s
  WHERE s.account_id=mentor_cache_sync_state.account_id
    AND s.mentor_user_id=mentor_cache_sync_state.mentor_user_id AND s.namespace='private'
)
WHERE authorization_state='authorized' AND EXISTS (
  SELECT 1 FROM mentor_cache_snapshots s,
    json_each(CASE WHEN json_valid(s.snapshot_json) THEN s.snapshot_json ELSE '{}' END,'$.redemptions') r
  WHERE s.account_id=mentor_cache_sync_state.account_id
    AND s.mentor_user_id=mentor_cache_sync_state.mentor_user_id AND s.namespace='private'
    AND coalesce(json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.status'),'')<>'needs_review'
    AND NOT (coalesce(json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.status'),'')='approved'
      AND coalesce(json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.creditState'),'')='debited')
    AND NOT (coalesce(json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.status'),'')='rejected'
      AND coalesce(json_extract(CASE WHEN json_valid(r.value) THEN r.value ELSE '{}' END,'$.creditState'),'')='refunded')
);

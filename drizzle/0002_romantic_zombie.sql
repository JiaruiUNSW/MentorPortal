CREATE TABLE `mentor_cache_snapshots` (
	`account_id` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`generation` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`synced_at` integer NOT NULL,
	`refresh_after` integer NOT NULL,
	`hard_expires_at` integer NOT NULL,
	`invalidation_version` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mentor_user_id`, `namespace`),
	CONSTRAINT "mentor_cache_namespace" CHECK("mentor_cache_snapshots"."namespace" IN ('private','catalog')),
	CONSTRAINT "mentor_cache_snapshot_mentor" CHECK("mentor_cache_snapshots"."mentor_user_id" > 0)
);
--> statement-breakpoint
CREATE TABLE `mentor_cache_sync_state` (
	`account_id` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer DEFAULT 0 NOT NULL,
	`commit_token` text,
	`invalidation_version` integer DEFAULT 0 NOT NULL,
	`next_private_sync_at` integer DEFAULT 0 NOT NULL,
	`next_catalog_sync_at` integer DEFAULT 0 NOT NULL,
	`authorization_state` text DEFAULT 'unknown' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_attempt_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mentor_user_id`),
	CONSTRAINT "mentor_cache_authorization_state" CHECK("mentor_cache_sync_state"."authorization_state" IN ('unknown','authorized','denied')),
	CONSTRAINT "mentor_cache_sync_mentor" CHECK("mentor_cache_sync_state"."mentor_user_id" > 0)
);
--> statement-breakpoint
CREATE INDEX `mentor_cache_private_due` ON `mentor_cache_sync_state` (`next_private_sync_at`);--> statement-breakpoint
CREATE INDEX `mentor_cache_catalog_due` ON `mentor_cache_sync_state` (`next_catalog_sync_at`);
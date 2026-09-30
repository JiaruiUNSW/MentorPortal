CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text,
	`mentor_user_id` integer NOT NULL,
	`role` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "auth_accounts_role" CHECK("auth_accounts"."role" IN ('mentor', 'admin')),
	CONSTRAINT "auth_accounts_mode" CHECK("auth_accounts"."mode" IN ('demo', 'live')),
	CONSTRAINT "auth_accounts_status" CHECK("auth_accounts"."status" IN ('active', 'disabled')),
	CONSTRAINT "auth_accounts_mapping" CHECK(("auth_accounts"."role" = 'admin' AND "auth_accounts"."mentor_user_id" = 0) OR ("auth_accounts"."role" = 'mentor' AND "auth_accounts"."mentor_user_id" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_email_mode` ON `auth_accounts` (`email`,`mode`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_live_mentor` ON `auth_accounts` (`mentor_user_id`) WHERE "auth_accounts"."mode" = 'live' AND "auth_accounts"."role" = 'mentor';--> statement-breakpoint
CREATE TABLE `auth_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`mode` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`activated_account_id` text,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activated_account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auth_invites_mode" CHECK("auth_invites"."mode" IN ('demo', 'live')),
	CONSTRAINT "auth_invites_mapping" CHECK("auth_invites"."mentor_user_id" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_token_hash_unique` ON `auth_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_invites_email_mode` ON `auth_invites` (`email`,`mode`);--> statement-breakpoint
CREATE INDEX `auth_invites_expiry` ON `auth_invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_expiry` ON `auth_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_account` ON `auth_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_setup` (
	`key` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mentor_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`mode` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`entity_id` text,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentor_demo_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`mutation_token` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentor_files` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`mode` text NOT NULL,
	`parent_kind` text NOT NULL,
	`parent_id` text,
	`group_id` text,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`state` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mentor_files_owner` ON `mentor_files` (`account_id`,`mode`,`state`);--> statement-breakpoint
CREATE TABLE `mentor_requests` (
	`account_id` text NOT NULL,
	`mode` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload_hash` text NOT NULL,
	`state` text NOT NULL,
	`lease_token` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mode`, `idempotency_key`)
);

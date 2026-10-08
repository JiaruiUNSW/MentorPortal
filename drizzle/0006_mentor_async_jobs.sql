CREATE TABLE `mentor_async_files` (
	`file_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `mentor_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `mentor_async_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mentor_async_files_job` ON `mentor_async_files` (`job_id`);--> statement-breakpoint
CREATE TABLE `mentor_async_jobs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`account_id` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`group_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`request_json` text NOT NULL,
	`attachments_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`can_retry` integer DEFAULT 0 NOT NULL,
	`retry_after` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer DEFAULT 0 NOT NULL,
	`dispatch_started_at` integer,
	`response_json` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mentor_async_jobs_id_unique` ON `mentor_async_jobs` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mentor_async_idempotency` ON `mentor_async_jobs` (`account_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `mentor_async_due` ON `mentor_async_jobs` (`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `mentor_async_group` ON `mentor_async_jobs` (`group_id`,`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `mentor_async_owner` ON `mentor_async_jobs` (`account_id`,`mentor_user_id`,`sequence`);
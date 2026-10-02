CREATE TABLE `mentor_resource_locks` (
	`resource_key` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`owner_account_id` text NOT NULL,
	`lease_token` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mentor_resource_request` ON `mentor_resource_locks` (`request_id`);
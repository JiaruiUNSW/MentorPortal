CREATE TABLE `__new_auth_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`role` text DEFAULT 'mentor' NOT NULL,
	`mode` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`activated_account_id` text,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activated_account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "auth_invites_mode" CHECK("__new_auth_invites"."mode" IN ('demo', 'live')),
	CONSTRAINT "auth_invites_role" CHECK("__new_auth_invites"."role" IN ('mentor', 'admin')),
	CONSTRAINT "auth_invites_mapping" CHECK(("__new_auth_invites"."role" = 'admin' AND "__new_auth_invites"."mentor_user_id" = 0) OR ("__new_auth_invites"."role" = 'mentor' AND "__new_auth_invites"."mentor_user_id" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_auth_invites`("id", "token_hash", "email", "display_name", "mentor_user_id", "role", "mode", "created_by_account_id", "created_at", "expires_at", "accepted_at", "revoked_at", "activated_account_id") SELECT "id", "token_hash", "email", "display_name", "mentor_user_id", 'mentor', "mode", "created_by_account_id", "created_at", "expires_at", "accepted_at", "revoked_at", "activated_account_id" FROM `auth_invites`;--> statement-breakpoint
DROP TABLE `auth_invites`;--> statement-breakpoint
ALTER TABLE `__new_auth_invites` RENAME TO `auth_invites`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_token_hash_unique` ON `auth_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_invites_email_mode` ON `auth_invites` (`email`,`mode`);--> statement-breakpoint
CREATE INDEX `auth_invites_expiry` ON `auth_invites` (`expires_at`);
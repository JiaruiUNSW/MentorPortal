CREATE TABLE `auth_oidc_identities` (
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oidc_identity_subject` ON `auth_oidc_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oidc_identity_account` ON `auth_oidc_identities` (`issuer`,`account_id`);--> statement-breakpoint
CREATE TABLE `auth_oidc_transactions` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`intent` text NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`account_id` text,
	`session_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_oidc_transaction_intent" CHECK("auth_oidc_transactions"."intent" IN ('login', 'link')),
	CONSTRAINT "auth_oidc_transaction_link" CHECK(("auth_oidc_transactions"."intent" = 'login' AND "auth_oidc_transactions"."account_id" IS NULL AND "auth_oidc_transactions"."session_hash" IS NULL) OR ("auth_oidc_transactions"."intent" = 'link' AND "auth_oidc_transactions"."account_id" IS NOT NULL AND "auth_oidc_transactions"."session_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `auth_oidc_transaction_expiry` ON `auth_oidc_transactions` (`expires_at`);
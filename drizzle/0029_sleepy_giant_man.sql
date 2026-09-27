CREATE TABLE `document_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`applies_to` text NOT NULL,
	`retain_years` integer NOT NULL,
	`effective_from` text NOT NULL,
	`superseded_at` text,
	`superseded_by_id` text,
	`note` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `retention_policies_company_idx` ON `document_retention_policies` (`company_id`,`applies_to`,`effective_from`);
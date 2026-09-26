CREATE TABLE `account_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`account_id` text NOT NULL,
	`chart_name` text NOT NULL,
	`external_code` text NOT NULL,
	`external_name` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_mappings_company_idx` ON `account_mappings` (`company_id`);--> statement-breakpoint
CREATE INDEX `account_mappings_chart_idx` ON `account_mappings` (`company_id`,`chart_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_mappings_unique` ON `account_mappings` (`company_id`,`account_id`,`chart_name`);
CREATE TABLE `company_size_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`financial_year_end` text NOT NULL,
	`kind` text NOT NULL,
	`choice` text,
	`count` integer,
	`decided_by` text NOT NULL,
	`note` text,
	`superseded_by_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `company_size_decisions_idx` ON `company_size_decisions` (`company_id`,`kind`,`financial_year_end`);--> statement-breakpoint
CREATE TABLE `statement_format_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`account_id` text NOT NULL,
	`item_code` text NOT NULL,
	`effective_from` text NOT NULL,
	`note` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `statement_format_mappings_idx` ON `statement_format_mappings` (`company_id`,`account_id`,`effective_from`);
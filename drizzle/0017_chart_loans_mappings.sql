CREATE TABLE `loans` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`lender_name` text NOT NULL,
	`loan_name` text NOT NULL,
	`kind` text DEFAULT 'term_loan' NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`account_id` text NOT NULL,
	`principal_minor` integer DEFAULT 0 NOT NULL,
	`drawdown_date` text,
	`maturity_date` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `loans_company_idx` ON `loans` (`company_id`);--> statement-breakpoint
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
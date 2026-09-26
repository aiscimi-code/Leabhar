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
CREATE INDEX `loans_company_idx` ON `loans` (`company_id`);
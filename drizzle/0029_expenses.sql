CREATE TABLE `expense_claim_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`line_type` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`account_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`units` integer,
	`rate_id` text,
	`rate_code` text,
	`rate_name` text,
	`rate_amount_minor` integer,
	`rate_per_units` integer,
	`business_use_basis_points` integer DEFAULT 10000 NOT NULL,
	`private_use_account_id` text,
	`document_id` text,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `expense_claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rate_id`) REFERENCES `expense_rates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`private_use_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expense_claim_lines_claim_idx` ON `expense_claim_lines` (`claim_id`);--> statement-breakpoint
CREATE TABLE `expense_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`claimant_type` text NOT NULL,
	`officer_id` text,
	`user_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`currency` text NOT NULL,
	`total_minor` integer NOT NULL,
	`business_minor` integer NOT NULL,
	`private_minor` integer DEFAULT 0 NOT NULL,
	`payable_account_id` text NOT NULL,
	`journal_entry_id` text,
	`approved_by` text,
	`approved_on` text,
	`rejected_by` text,
	`rejected_on` text,
	`rejection_reason` text,
	`reimbursement_journal_entry_id` text,
	`reimbursement_date` text,
	`reimbursed_by` text,
	`bank_transaction_id` text,
	`reversal_journal_entry_id` text,
	`reversal_reason` text,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`officer_id`) REFERENCES `company_officers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payable_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expense_claims_company_idx` ON `expense_claims` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `expense_claims_claimant_idx` ON `expense_claims` (`company_id`,`claimant_type`,`officer_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `expense_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`category` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`per_units` integer DEFAULT 1 NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`source_note` text,
	`source_url` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_rates_unique` ON `expense_rates` (`company_id`,`code`,`effective_from`);--> statement-breakpoint
CREATE INDEX `expense_rates_company_idx` ON `expense_rates` (`company_id`,`category`,`active`);--> statement-breakpoint
ALTER TABLE `bank_transactions` ADD `business_use_basis_points` integer;--> statement-breakpoint
ALTER TABLE `bank_transactions` ADD `private_use_account_id` text REFERENCES accounts(id);
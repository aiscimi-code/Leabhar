ALTER TABLE `invoices` ADD `bad_debt_relief_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `bad_debt_relief_journal_entry_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `bad_debt_relief_claimed_at` text;
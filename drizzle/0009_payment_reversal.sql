ALTER TABLE `payments` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversed_by` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversal_reason` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `reversal_journal_entry_id` text;
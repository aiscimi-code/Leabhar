ALTER TABLE `invoices` ADD `is_debit_note` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `debit_note_of_id` text;
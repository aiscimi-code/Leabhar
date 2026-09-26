CREATE TABLE `capital_good_intervals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`capital_good_id` text NOT NULL,
	`interval_number` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`proportion_bp` integer NOT NULL,
	`not_used` integer DEFAULT false NOT NULL,
	`baseline_bp` integer NOT NULL,
	`adjustment_minor` integer NOT NULL,
	`provision` text NOT NULL,
	`working` text NOT NULL,
	`recorded_by` text NOT NULL,
	`recorded_at` text NOT NULL,
	`journal_entry_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`capital_good_id`) REFERENCES `capital_goods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `capital_good_intervals_good_idx` ON `capital_good_intervals` (`capital_good_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `capital_good_intervals_unique` ON `capital_good_intervals` (`capital_good_id`,`interval_number`);--> statement-breakpoint
CREATE TABLE `capital_goods` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`description` text NOT NULL,
	`kind` text NOT NULL,
	`interval_count` integer NOT NULL,
	`initial_interval_start` text NOT NULL,
	`total_tax_incurred_minor` integer NOT NULL,
	`deducted_minor` integer NOT NULL,
	`source_invoice_ids` text NOT NULL,
	`registered_by` text NOT NULL,
	`registered_at` text NOT NULL,
	`disposed_on` text,
	`disposal_taxable` integer,
	`disposal_adjustment_minor` integer,
	`disposal_recorded_by` text,
	`disposal_journal_entry_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `capital_goods_company_idx` ON `capital_goods` (`company_id`);
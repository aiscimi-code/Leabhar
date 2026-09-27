CREATE TABLE `expected_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`recurring_bill_id` text NOT NULL,
	`expected_date` text NOT NULL,
	`expected_net_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'expected' NOT NULL,
	`invoice_id` text,
	`difference_minor` integer,
	`matched_at` text,
	`matched_by` text,
	`dismiss_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_bill_id`) REFERENCES `recurring_bills`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expected_bills_occurrence_unique` ON `expected_bills` (`recurring_bill_id`,`expected_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `expected_bills_invoice_unique` ON `expected_bills` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `expected_bills_company_idx` ON `expected_bills` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `recurring_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`expected_net_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`account_id` text,
	`tolerance_basis_points` integer DEFAULT 500 NOT NULL,
	`window_days` integer DEFAULT 10 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_bills_company_idx` ON `recurring_bills` (`company_id`,`active`);
CREATE TABLE `recurring_invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_invoice_id` text NOT NULL,
	`company_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`description` text NOT NULL,
	`net_minor` integer NOT NULL,
	`discount_basis_points` integer,
	`account_id` text NOT NULL,
	`vat_treatment_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`recurring_invoice_id`) REFERENCES `recurring_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_invoice_lines_template_idx` ON `recurring_invoice_lines` (`recurring_invoice_id`);--> statement-breakpoint
CREATE TABLE `recurring_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_invoices_company_idx` ON `recurring_invoices` (`company_id`,`active`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `recurring_invoice_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `recurring_date` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_recurring_occurrence_unique` ON `invoices` (`recurring_invoice_id`,`recurring_date`);
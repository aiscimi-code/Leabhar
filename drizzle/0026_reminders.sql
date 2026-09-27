CREATE TABLE `invoice_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`letter_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`outstanding_minor` integer NOT NULL,
	`days_overdue` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `reminder_letters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_reminders_invoice_idx` ON `invoice_reminders` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `reminder_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`level` integer NOT NULL,
	`as_of` text NOT NULL,
	`produced_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reminder_letters_customer_idx` ON `reminder_letters` (`company_id`,`customer_id`);
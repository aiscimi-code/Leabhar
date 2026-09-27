CREATE TABLE `customer_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`email` text,
	`phone` text,
	`is_billing` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customer_contacts_customer_idx` ON `customer_contacts` (`customer_id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `credit_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `due_date_source` text;--> statement-breakpoint
UPDATE `invoices` SET `due_date_source` = 'stated' WHERE `due_date` IS NOT NULL;

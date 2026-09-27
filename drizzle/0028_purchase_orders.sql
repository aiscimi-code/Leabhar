CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`company_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`net_minor` integer NOT NULL,
	`account_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `purchase_order_lines_order_idx` ON `purchase_order_lines` (`purchase_order_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`number` text NOT NULL,
	`order_date` text NOT NULL,
	`expected_date` text,
	`currency` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`cancelled_at` text,
	`cancel_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `purchase_orders_company_idx` ON `purchase_orders` (`company_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_number_unique` ON `purchase_orders` (`company_id`,`number`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `purchase_order_id` text;
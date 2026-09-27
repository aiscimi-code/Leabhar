CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`unit` text NOT NULL,
	`costing_method` text DEFAULT 'fifo' NOT NULL,
	`cost_of_sales_account_id` text,
	`stock_account_id` text,
	`active` integer DEFAULT true NOT NULL,
	`recorded_by` text NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cost_of_sales_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_company_code_unique` ON `items` (`company_id`,`code`);--> statement-breakpoint
CREATE TABLE `stock_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_locations_company_code_unique` ON `stock_locations` (`company_id`,`code`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`movement_date` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit_cost_minor` integer,
	`cost_minor` integer,
	`related_movement_id` text,
	`transfer_pair_id` text,
	`invoice_id` text,
	`invoice_line_id` text,
	`stocktake_id` text,
	`reason` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `stock_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_line_id`) REFERENCES `invoice_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_movements_item_idx` ON `stock_movements` (`item_id`,`movement_date`);--> statement-breakpoint
CREATE INDEX `stock_movements_company_idx` ON `stock_movements` (`company_id`,`movement_date`);--> statement-breakpoint
CREATE TABLE `stock_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`valuation_date` text NOT NULL,
	`value_minor` integer NOT NULL,
	`ledger_before_minor` integer NOT NULL,
	`journal_entry_id` text,
	`lines` text NOT NULL,
	`posted_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_valuations_company_idx` ON `stock_valuations` (`company_id`,`valuation_date`);--> statement-breakpoint
CREATE TABLE `stocktake_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`stocktake_id` text NOT NULL,
	`item_id` text NOT NULL,
	`counted_quantity_milli` integer NOT NULL,
	`book_quantity_milli` integer,
	`unit_cost_minor` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`stocktake_id`) REFERENCES `stocktakes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stocktake_lines_unique` ON `stocktake_lines` (`stocktake_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `stocktakes` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`location_id` text NOT NULL,
	`count_date` text NOT NULL,
	`counted_by` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`posted_by` text,
	`posted_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `stock_locations`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `partner_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`partner_id` text NOT NULL,
	`share_basis_points` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`recorded_by` text NOT NULL,
	`basis` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `partner_shares_partner_idx` ON `partner_shares` (`partner_id`);--> statement-breakpoint
CREATE TABLE `partners` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`tax_reference` text,
	`is_precedent_partner` integer DEFAULT false NOT NULL,
	`joined_on` text NOT NULL,
	`left_on` text,
	`capital_account_id` text,
	`current_account_id` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`capital_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `partners_company_idx` ON `partners` (`company_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `entity_type` text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `trade_commenced_on` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `trade_ceased_on` text;
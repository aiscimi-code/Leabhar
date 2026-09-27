CREATE TABLE `farm_partnership_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`register` text NOT NULL,
	`identifier` text NOT NULL,
	`registered_on` text NOT NULL,
	`ended_on` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `farm_partnership_registrations_company_idx` ON `farm_partnership_registrations` (`company_id`);--> statement-breakpoint
CREATE TABLE `grant_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`journal_line_id` text NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grant_receipts_line_unique` ON `grant_receipts` (`journal_line_id`);--> statement-breakpoint
CREATE INDEX `grant_receipts_grant_idx` ON `grant_receipts` (`grant_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`scheme` text NOT NULL,
	`payer` text NOT NULL,
	`reference` text,
	`kind` text NOT NULL,
	`awarded_minor` integer NOT NULL,
	`awarded_on` text NOT NULL,
	`fixed_asset_id` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fixed_asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `grants_company_idx` ON `grants` (`company_id`,`awarded_on`);--> statement-breakpoint
CREATE TABLE `share_farming_arrangements` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`counterparty` text NOT NULL,
	`land_provided_by` text NOT NULL,
	`parcel_ids` text DEFAULT '[]' NOT NULL,
	`output_share_basis_points` integer NOT NULL,
	`cost_share_basis_points` integer NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `share_farming_company_idx` ON `share_farming_arrangements` (`company_id`);
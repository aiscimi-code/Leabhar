CREATE TABLE `fixed_asset_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`fixed_asset_id` text NOT NULL,
	`transfer_date` text NOT NULL,
	`from_account_id` text NOT NULL,
	`to_account_id` text NOT NULL,
	`from_accumulated_account_id` text,
	`to_accumulated_account_id` text,
	`from_category` text,
	`to_category` text,
	`journal_entry_id` text NOT NULL,
	`reason` text NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fixed_asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_accumulated_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_accumulated_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fixed_asset_transfers_asset_idx` ON `fixed_asset_transfers` (`fixed_asset_id`,`transfer_date`);
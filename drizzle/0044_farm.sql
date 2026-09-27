CREATE TABLE `animal_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`enterprise_id` text NOT NULL,
	`name` text NOT NULL,
	`species` text NOT NULL,
	`stock_account_id` text NOT NULL,
	`change_account_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `farm_enterprises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `animal_groups_company_name_unique` ON `animal_groups` (`company_id`,`name`);--> statement-breakpoint
CREATE TABLE `animals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`tag_number` text NOT NULL,
	`species` text NOT NULL,
	`sex` text,
	`breed` text,
	`date_of_birth` text,
	`dam_tag` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `animals_company_tag_unique` ON `animals` (`company_id`,`tag_number`);--> statement-breakpoint
CREATE TABLE `crop_harvests` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`planting_id` text NOT NULL,
	`harvested_on` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit` text NOT NULL,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`planting_id`) REFERENCES `crop_plantings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `crop_harvests_planting_idx` ON `crop_harvests` (`planting_id`);--> statement-breakpoint
CREATE TABLE `crop_plantings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`enterprise_id` text NOT NULL,
	`parcel_id` text NOT NULL,
	`crop` text NOT NULL,
	`variety` text,
	`harvest_year` integer NOT NULL,
	`area_sqm` integer NOT NULL,
	`sown_on` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `farm_enterprises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parcel_id`) REFERENCES `land_parcels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `crop_plantings_company_idx` ON `crop_plantings` (`company_id`,`harvest_year`);--> statement-breakpoint
CREATE TABLE `farm_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`journal_line_id` text NOT NULL,
	`enterprise_id` text NOT NULL,
	`planting_id` text,
	`input_kind` text,
	`basis_points` integer NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `farm_enterprises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`planting_id`) REFERENCES `crop_plantings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `farm_allocations_line_idx` ON `farm_allocations` (`journal_line_id`);--> statement-breakpoint
CREATE INDEX `farm_allocations_enterprise_idx` ON `farm_allocations` (`enterprise_id`);--> statement-breakpoint
CREATE TABLE `farm_enterprises` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`started_on` text NOT NULL,
	`ended_on` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `farm_enterprises_company_name_unique` ON `farm_enterprises` (`company_id`,`name`);--> statement-breakpoint
CREATE TABLE `farm_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`trading_activity_id` text,
	`farm_name` text NOT NULL,
	`flock_number` text,
	`area_unit` text DEFAULT 'hectares' NOT NULL,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trading_activity_id`) REFERENCES `company_trading_activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `farm_profiles_company_unique` ON `farm_profiles` (`company_id`);--> statement-breakpoint
CREATE TABLE `land_parcels` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`reference` text NOT NULL,
	`name` text NOT NULL,
	`area_sqm` integer NOT NULL,
	`tenure` text NOT NULL,
	`held_from` text NOT NULL,
	`held_to` text,
	`counterparty` text,
	`annual_rent_minor` integer,
	`fixed_asset_id` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fixed_asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `land_parcels_company_idx` ON `land_parcels` (`company_id`,`reference`);--> statement-breakpoint
CREATE TABLE `livestock_events` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`group_id` text NOT NULL,
	`animal_id` text,
	`event_date` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`head_count` integer NOT NULL,
	`amount_minor` integer,
	`invoice_line_id` text,
	`related_event_id` text,
	`transfer_pair_id` text,
	`reason` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `animal_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `animals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_line_id`) REFERENCES `invoice_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `livestock_events_group_idx` ON `livestock_events` (`group_id`,`event_date`);--> statement-breakpoint
CREATE INDEX `livestock_events_animal_idx` ON `livestock_events` (`animal_id`);--> statement-breakpoint
CREATE TABLE `livestock_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`valuation_date` text NOT NULL,
	`value_minor` integer NOT NULL,
	`journal_entry_id` text,
	`lines` text NOT NULL,
	`posted_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `livestock_valuations_company_idx` ON `livestock_valuations` (`company_id`,`valuation_date`);
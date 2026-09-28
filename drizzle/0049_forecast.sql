-- The forecast tables were first created by a migration on main (66de8b7) that
-- was reverted (88581dd) and never released. A book that ran it holds these
-- tables in that earlier shape, with nothing but trial data; drop them so this
-- migration can create them as they are now. Children first.
DROP TABLE IF EXISTS `scenario_adjustments`;--> statement-breakpoint
DROP TABLE IF EXISTS `forecast_scenarios`;--> statement-breakpoint
DROP TABLE IF EXISTS `company_budget_lines`;--> statement-breakpoint
DROP TABLE IF EXISTS `company_budgets`;--> statement-breakpoint
DROP TABLE IF EXISTS `recurring_bank_patterns`;--> statement-breakpoint
DROP TABLE IF EXISTS `recurring_forecast_items`;--> statement-breakpoint
DROP TABLE IF EXISTS `forecast_snapshots`;--> statement-breakpoint
DROP TABLE IF EXISTS `forecast_settings`;--> statement-breakpoint
CREATE TABLE `company_budget_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_id` text NOT NULL,
	`company_id` text NOT NULL,
	`account_id` text NOT NULL,
	`month_start` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `company_budgets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_budget_lines_uq` ON `company_budget_lines` (`budget_id`,`account_id`,`month_start`);--> statement-breakpoint
CREATE INDEX `company_budget_lines_co` ON `company_budget_lines` (`company_id`,`budget_id`);--> statement-breakpoint
CREATE TABLE `company_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`financial_year_end` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'current' NOT NULL,
	`source` text DEFAULT 'entered' NOT NULL,
	`reason` text,
	`adjustments_json` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `company_budgets_co` ON `company_budgets` (`company_id`,`financial_year_end`,`version`);--> statement-breakpoint
CREATE TABLE `forecast_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forecast_scenarios_co` ON `forecast_scenarios` (`company_id`);--> statement-breakpoint
CREATE TABLE `forecast_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`version` integer NOT NULL,
	`receipt_basis` text DEFAULT 'due_date' NOT NULL,
	`horizon_days` integer DEFAULT 90 NOT NULL,
	`granularity` text DEFAULT 'weekly' NOT NULL,
	`minimum_cash_minor` integer DEFAULT 0 NOT NULL,
	`cash_account_ids` text,
	`include_purchase_orders` integer DEFAULT false NOT NULL,
	`include_unconfirmed` integer DEFAULT false NOT NULL,
	`include_owner_tax` integer DEFAULT true NOT NULL,
	`due_date_basis` text DEFAULT 'statutory' NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_settings_version` ON `forecast_settings` (`company_id`,`version`);--> statement-breakpoint
CREATE TABLE `forecast_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`as_of` text NOT NULL,
	`horizon_end` text NOT NULL,
	`scenario_id` text,
	`options_json` text NOT NULL,
	`result_json` text NOT NULL,
	`saved_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forecast_snapshots_co` ON `forecast_snapshots` (`company_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `recurring_bank_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`payee_pattern` text NOT NULL,
	`pattern_key` text NOT NULL,
	`direction` text NOT NULL,
	`median_amount_minor` integer NOT NULL,
	`amount_min_minor` integer NOT NULL,
	`amount_max_minor` integer NOT NULL,
	`detected_frequency` text NOT NULL,
	`occurrence_count` integer NOT NULL,
	`first_seen_date` text NOT NULL,
	`last_seen_date` text NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`confirmed_item_id` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_bank_patterns_co` ON `recurring_bank_patterns` (`company_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_bank_patterns_key` ON `recurring_bank_patterns` (`company_id`,`pattern_key`);--> statement-breakpoint
CREATE TABLE `recurring_forecast_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`description` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`amount_max_minor` integer,
	`frequency` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`next_date` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`payee_pattern` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`confirmed_by` text,
	`confirmed_at` text,
	`notes` text,
	`superseded_by_id` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_forecast_items_co` ON `recurring_forecast_items` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `scenario_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text,
	`delay_days` integer,
	`change_basis_points` integer,
	`amount_minor` integer,
	`frequency` text,
	`from_date` text NOT NULL,
	`to_date` text,
	`description` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `forecast_scenarios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scenario_adjustments_scen` ON `scenario_adjustments` (`scenario_id`);
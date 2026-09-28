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
	`receipt_basis` text DEFAULT 'due_date' NOT NULL,
	`horizon_days` integer DEFAULT 90 NOT NULL,
	`minimum_cash_minor` integer DEFAULT 0 NOT NULL,
	`cash_account_ids` text,
	`include_purchase_orders` integer DEFAULT false NOT NULL,
	`include_unconfirmed` integer DEFAULT false NOT NULL,
	`due_date_basis` text DEFAULT 'statutory' NOT NULL,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_settings_co` ON `forecast_settings` (`company_id`);--> statement-breakpoint
CREATE TABLE `forecast_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`as_of` text NOT NULL,
	`horizon_end` text NOT NULL,
	`granularity` text NOT NULL,
	`receipt_basis` text NOT NULL,
	`due_date_basis` text NOT NULL,
	`include_purchase_orders` integer NOT NULL,
	`snapshot_json` text NOT NULL,
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
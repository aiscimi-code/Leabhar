CREATE TABLE `company_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`registration_type` text NOT NULL,
	`label` text,
	`registration_number` text,
	`registered_from` text NOT NULL,
	`deregistered_on` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `company_registrations_company_idx` ON `company_registrations` (`company_id`);--> statement-breakpoint
CREATE TABLE `company_trading_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`sector` text NOT NULL,
	`commenced_on` text NOT NULL,
	`ceased_on` text,
	`herd_number` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `company_trading_activities_company_idx` ON `company_trading_activities` (`company_id`);--> statement-breakpoint
CREATE TABLE `company_trading_names` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `company_trading_names_company_idx` ON `company_trading_names` (`company_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `eori_basis` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eori_confirmed_by` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eori_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eu_vat_number` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eu_vat_registered_from` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eu_vat_basis` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eu_vat_confirmed_by` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `eu_vat_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `archived_by` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `archive_basis` text;
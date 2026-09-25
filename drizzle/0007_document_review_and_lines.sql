CREATE TABLE `document_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`document_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` text,
	`unit_price_minor` integer,
	`net_minor` integer,
	`vat_rate_basis_points` integer,
	`vat_minor` integer,
	`gross_minor` integer,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `document_lines_document_idx` ON `document_lines` (`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_lines_document_line_unique` ON `document_lines` (`document_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `document_vat_totals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`document_id` text NOT NULL,
	`rate_basis_points` integer,
	`label` text,
	`net_minor` integer,
	`vat_minor` integer,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `document_vat_totals_document_idx` ON `document_vat_totals` (`document_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `extraction_engine` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `document_extractions` ADD `lines` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `document_extractions` ADD `vat_totals` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `due_date` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `supply_date` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `supplier_name_stated` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `supplier_address` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `supplier_vat_number` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `supplier_country` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `customer_name_stated` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `customer_address` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `customer_vat_number` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `customer_country` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `vat_legends` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `payment_terms` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `original_document_number` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `review_status` text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `review_note` text;
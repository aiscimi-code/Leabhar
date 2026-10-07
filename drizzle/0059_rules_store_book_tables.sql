CREATE TABLE `irish_rule_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`rule_version` integer NOT NULL,
	`tax_rate_id` text,
	`vat_treatment_id` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `irish_rule_bindings_version_idx` ON `irish_rule_bindings` (`company_id`,`rule_key`,`rule_version`,`effective_from`);--> statement-breakpoint
CREATE TABLE `irish_rule_version_map` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`book_version` integer NOT NULL,
	`catalogue_version` integer NOT NULL,
	`store_signature` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `irish_rule_version_map_book_unique` ON `irish_rule_version_map` (`company_id`,`rule_key`,`book_version`);--> statement-breakpoint
CREATE TABLE `irish_rule_versions_retained` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`rule_version` integer NOT NULL,
	`book_rule_id` text NOT NULL,
	`reason` text NOT NULL,
	`source_citation` text NOT NULL,
	`source_sha256` text NOT NULL,
	`section_number` text NOT NULL,
	`rule_type` text NOT NULL,
	`topic` text NOT NULL,
	`tax_heads` text NOT NULL,
	`name` text NOT NULL,
	`statement` text,
	`extracted_fact` text,
	`numeric_value` integer,
	`unit` text,
	`qualifier` text,
	`conditions` text NOT NULL,
	`exceptions` text NOT NULL,
	`accounting_effect` text,
	`tax_effect` text,
	`vat_effect` text,
	`reporting_effect` text,
	`review_status` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `irish_rule_versions_retained_unique` ON `irish_rule_versions_retained` (`company_id`,`rule_key`,`rule_version`);--> statement-breakpoint
CREATE TABLE `rules_store_seen` (
	`id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`format` integer NOT NULL,
	`catalogue_digest` text NOT NULL,
	`versions` integer NOT NULL,
	`seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rules_store_seen_signature_idx` ON `rules_store_seen` (`signature`);
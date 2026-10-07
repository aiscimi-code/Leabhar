ALTER TABLE `invoice_lines` ADD `vat_rule_numbering` text DEFAULT 'book' NOT NULL;--> statement-breakpoint
ALTER TABLE `irish_rule_decisions` ADD `numbering` text DEFAULT 'book' NOT NULL;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `source_title` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `source_type` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `source_local_path` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `provision_heading` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `provision_text` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `provision_locator` text;--> statement-breakpoint
ALTER TABLE `irish_rule_versions_retained` ADD `provision_category` text;
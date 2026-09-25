ALTER TABLE `vat_entries` ADD `invoice_line_id` text;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `document_line_id` text;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `vat_rule_keys` text DEFAULT '[]' NOT NULL;
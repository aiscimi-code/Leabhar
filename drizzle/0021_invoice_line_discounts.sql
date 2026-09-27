ALTER TABLE `invoice_lines` ADD `undiscounted_net_minor` integer;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `discount_basis_points` integer;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `discount_minor` integer DEFAULT 0 NOT NULL;
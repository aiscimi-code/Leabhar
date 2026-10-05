ALTER TABLE `invoice_lines` ADD `business_use_basis_points` integer;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `dual_use_proportion_basis_points` integer;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `dual_use_basis` text;
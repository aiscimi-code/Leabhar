CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`customer_id` text,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_company_code_unique` ON `projects` (`company_id`,`code`);--> statement-breakpoint
CREATE TABLE `rct_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`subcontractor_id` text NOT NULL,
	`project_id` text,
	`site_id` text,
	`description` text NOT NULL,
	`estimated_value_minor` integer NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`labour_only` integer NOT NULL,
	`notified_on` text,
	`revenue_contract_id` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subcontractor_id`) REFERENCES `rct_subcontractors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rct_contracts_company_idx` ON `rct_contracts` (`company_id`);--> statement-breakpoint
CREATE TABLE `rct_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`contract_id` text NOT NULL,
	`invoice_id` text,
	`gross_minor` integer NOT NULL,
	`notified_on` text NOT NULL,
	`deduction_authorisation_number` text,
	`rate_basis_points` integer,
	`rct_minor` integer,
	`payment_id` text,
	`paid_on` text,
	`return_period` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contract_id`) REFERENCES `rct_contracts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rct_payments_company_idx` ON `rct_payments` (`company_id`,`return_period`);--> statement-breakpoint
CREATE UNIQUE INDEX `rct_payments_payment_unique` ON `rct_payments` (`payment_id`);--> statement-breakpoint
CREATE TABLE `rct_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`period` text NOT NULL,
	`books_liability_minor` integer NOT NULL,
	`summary_liability_minor` integer NOT NULL,
	`amended` integer DEFAULT false NOT NULL,
	`filed_on` text NOT NULL,
	`filed_by` text NOT NULL,
	`bank_transaction_id` text,
	`payment_journal_entry_id` text,
	`paid_on` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_transaction_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rct_returns_period_unique` ON `rct_returns` (`company_id`,`period`);--> statement-breakpoint
CREATE TABLE `rct_subcontractors` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`tax_reference` text NOT NULL,
	`identity_evidence` text NOT NULL,
	`identity_checked_by` text NOT NULL,
	`identity_checked_on` text NOT NULL,
	`not_employee_declared` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rct_subcontractors_supplier_unique` ON `rct_subcontractors` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`eircode` text,
	`recorded_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sites_company_idx` ON `sites` (`company_id`);--> statement-breakpoint
/*
 * Issue #549: every book gets the RCT payable system account the deductions
 * post to. Added only where the book has none yet and the code 2460 is free.
 */
INSERT INTO `accounts` (`id`, `company_id`, `code`, `name`, `type`, `subtype`, `vat_applicable`, `is_system`,
  `system_key`, `report_section`, `description`, `effective_from`)
SELECT 'acc_' || lower(hex(randomblob(12))), c.`id`, '2460', 'RCT deducted from subcontractors', 'liability', 'current_liability', 0, 1,
  'rct_payable', 'current_liabilities',
  'Relevant contracts tax a principal deducted from payments to subcontractors, as each deduction authorisation specified (TCA s.530F; issue #549), held until paid to the Collector-General for the return period (s.530L). Zero once each period is paid.',
  COALESCE((SELECT MIN(a.`effective_from`) FROM `accounts` a WHERE a.`company_id` = c.`id`), date('now'))
FROM `companies` c
WHERE NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`company_id` = c.`id` AND a.`system_key` = 'rct_payable')
  AND NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`company_id` = c.`id` AND a.`code` = '2460');

CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_name` text NOT NULL,
	`account_name` text NOT NULL,
	`iban` text,
	`bic` text,
	`account_number` text,
	`sort_code` text,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`account_type` text DEFAULT 'current' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`opening_date` text NOT NULL,
	`closing_date` text,
	`account_id` text,
	`import_watch_path` text,
	`default_import_profile_id` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bank_accounts_company_idx` ON `bank_accounts` (`company_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`legal_name` text NOT NULL,
	`trading_name` text,
	`cro_number` text,
	`company_type` text,
	`date_incorporated` text,
	`registered_office` text,
	`principal_business_address` text,
	`records_address` text,
	`tax_reference_number` text,
	`vat_number` text,
	`vat_registration_date` text,
	`vat_registration_status` text DEFAULT 'not_registered' NOT NULL,
	`vat_deregistration_date` text,
	`eori_number` text,
	`revenue_registration_info` text,
	`corporation_tax_registered` integer DEFAULT false NOT NULL,
	`corporation_tax_registration_date` text,
	`vat_accounting_basis` text DEFAULT 'cash_receipts' NOT NULL,
	`vat_period_frequency` text DEFAULT 'bi_monthly' NOT NULL,
	`financial_year_end_day` integer DEFAULT 31 NOT NULL,
	`financial_year_end_month` integer DEFAULT 12 NOT NULL,
	`base_currency` text DEFAULT 'EUR' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_officers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`address` text,
	`date_of_birth` text,
	`nationality` text,
	`ppsn` text,
	`appointed_on` text,
	`resigned_on` text,
	`shares_held` integer,
	`share_class` text,
	`current_account_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `officers_company_idx` ON `company_officers` (`company_id`);--> statement-breakpoint
CREATE TABLE `share_capital` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`share_class` text DEFAULT 'Ordinary' NOT NULL,
	`authorised_shares` integer,
	`issued_shares` integer DEFAULT 0 NOT NULL,
	`nominal_value_minor` integer DEFAULT 100 NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `accounting_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`parent_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`locked_at` text,
	`locked_by` text,
	`lock_reason` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounting_periods_company_idx` ON `accounting_periods` (`company_id`);--> statement-breakpoint
CREATE INDEX `accounting_periods_range_idx` ON `accounting_periods` (`company_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text,
	`parent_id` text,
	`vat_applicable` integer DEFAULT true NOT NULL,
	`default_vat_treatment_id` text,
	`is_system` integer DEFAULT false NOT NULL,
	`system_key` text,
	`report_section` text,
	`report_order` integer DEFAULT 0 NOT NULL,
	`description` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_company_idx` ON `accounts` (`company_id`);--> statement-breakpoint
CREATE INDEX `accounts_system_key_idx` ON `accounts` (`company_id`,`system_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_code_unique` ON `accounts` (`company_id`,`code`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`from_currency` text NOT NULL,
	`to_currency` text NOT NULL,
	`rate_date` text NOT NULL,
	`rate_numerator` integer NOT NULL,
	`rate_denominator` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_reference` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fx_rates_lookup_idx` ON `fx_rates` (`company_id`,`from_currency`,`to_currency`,`rate_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rates_unique` ON `fx_rates` (`company_id`,`from_currency`,`to_currency`,`rate_date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tax_deadlines` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`due_date` text NOT NULL,
	`period_start` text,
	`period_end` text,
	`vat_period_id` text,
	`accounting_period_id` text,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`completed_at` text,
	`reminder_days_before` integer DEFAULT 14 NOT NULL,
	`notes` text,
	`source_note` text,
	`source_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_period_id`) REFERENCES `vat_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tax_deadlines_company_idx` ON `tax_deadlines` (`company_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_basis_points` integer NOT NULL,
	`tax_type` text DEFAULT 'vat' NOT NULL,
	`jurisdiction` text DEFAULT 'IE' NOT NULL,
	`reporting_classification` text,
	`is_default` integer DEFAULT false NOT NULL,
	`notes` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`source_note` text,
	`source_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tax_rates_company_idx` ON `tax_rates` (`company_id`);--> statement-breakpoint
CREATE INDEX `tax_rates_lookup_idx` ON `tax_rates` (`company_id`,`tax_type`,`effective_from`);--> statement-breakpoint
CREATE TABLE `vat_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`filing_deadline` text,
	`payment_deadline` text,
	`frequency` text DEFAULT 'bi_monthly' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`submitted_at` text,
	`submission_reference` text,
	`filed_t1_minor` integer,
	`filed_t2_minor` integer,
	`filed_t3_minor` integer,
	`filed_t4_minor` integer,
	`locked_at` text,
	`lock_reason` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vat_periods_company_idx` ON `vat_periods` (`company_id`);--> statement-breakpoint
CREATE INDEX `vat_periods_range_idx` ON `vat_periods` (`company_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `vat_treatments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`jurisdiction` text DEFAULT 'IE' NOT NULL,
	`direction` text DEFAULT 'both' NOT NULL,
	`supply_kind` text DEFAULT 'both' NOT NULL,
	`applies_rate` integer DEFAULT true NOT NULL,
	`default_tax_rate_id` text,
	`is_reverse_charge` integer DEFAULT false NOT NULL,
	`is_recoverable` integer DEFAULT true NOT NULL,
	`recoverable_basis_points` integer DEFAULT 10000 NOT NULL,
	`sales_vat_box` text,
	`purchases_vat_box` text,
	`net_sales_box` text,
	`net_purchases_box` text,
	`requires_counterparty_vat_number` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`notes` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`source_note` text,
	`source_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_tax_rate_id`) REFERENCES `tax_rates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vat_treatments_company_idx` ON `vat_treatments` (`company_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vat_treatments_code_unique` ON `vat_treatments` (`company_id`,`code`,`effective_from`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text,
	`match_key` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`country_code` text,
	`vat_number` text,
	`vat_number_validated` integer DEFAULT false NOT NULL,
	`address_lines` text,
	`email` text,
	`website` text,
	`default_currency` text DEFAULT 'EUR' NOT NULL,
	`default_account_id` text,
	`default_vat_treatment_id` text,
	`default_payment_terms_days` integer DEFAULT 0 NOT NULL,
	`typical_payment_days` integer,
	`payment_behaviour_notes` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `customers_company_idx` ON `customers` (`company_id`);--> statement-breakpoint
CREATE INDEX `customers_match_idx` ON `customers` (`company_id`,`match_key`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text,
	`match_key` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`country_code` text,
	`vat_number` text,
	`vat_number_validated` integer DEFAULT false NOT NULL,
	`tax_reference` text,
	`address_lines` text,
	`email` text,
	`website` text,
	`default_currency` text DEFAULT 'EUR' NOT NULL,
	`default_account_id` text,
	`default_vat_treatment_id` text,
	`typical_payment_days` integer,
	`payment_behaviour_notes` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `suppliers_company_idx` ON `suppliers` (`company_id`);--> statement-breakpoint
CREATE INDEX `suppliers_match_idx` ON `suppliers` (`company_id`,`match_key`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`entry_number` integer NOT NULL,
	`entry_date` text NOT NULL,
	`accounting_period_id` text,
	`narrative` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`entry_type` text DEFAULT 'standard' NOT NULL,
	`posted_at` text,
	`is_posted` integer DEFAULT false NOT NULL,
	`reversal_of_id` text,
	`reversed_by_entry_id` text,
	`reversal_reason` text,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_via` text DEFAULT 'system' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `journal_entries_company_idx` ON `journal_entries` (`company_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_date_idx` ON `journal_entries` (`company_id`,`entry_date`);--> statement-breakpoint
CREATE INDEX `journal_entries_source_idx` ON `journal_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_number_unique` ON `journal_entries` (`company_id`,`entry_number`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`journal_entry_id` text NOT NULL,
	`company_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`account_id` text NOT NULL,
	`debit_minor` integer DEFAULT 0 NOT NULL,
	`credit_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`base_debit_minor` integer DEFAULT 0 NOT NULL,
	`base_credit_minor` integer DEFAULT 0 NOT NULL,
	`base_currency` text NOT NULL,
	`fx_rate_numerator` integer,
	`fx_rate_denominator` integer,
	`fx_rate_source` text,
	`fx_rate_date` text,
	`supplier_id` text,
	`customer_id` text,
	`officer_id` text,
	`memo` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `journal_lines_entry_idx` ON `journal_lines` (`journal_entry_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_account_idx` ON `journal_lines` (`company_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `journal_lines_number_unique` ON `journal_lines` (`journal_entry_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `vat_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`journal_entry_id` text,
	`source_type` text NOT NULL,
	`source_id` text,
	`direction` text NOT NULL,
	`vat_treatment_id` text NOT NULL,
	`tax_rate_id` text,
	`rate_basis_points` integer DEFAULT 0 NOT NULL,
	`net_minor` integer NOT NULL,
	`vat_minor` integer NOT NULL,
	`gross_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`base_net_minor` integer NOT NULL,
	`base_vat_minor` integer NOT NULL,
	`base_gross_minor` integer NOT NULL,
	`base_currency` text NOT NULL,
	`recoverable_vat_minor` integer DEFAULT 0 NOT NULL,
	`base_recoverable_vat_minor` integer DEFAULT 0 NOT NULL,
	`tax_point_date` text NOT NULL,
	`vat_period_id` text,
	`vat_box` text,
	`net_box` text,
	`paired_entry_id` text,
	`is_reverse_charge_leg` integer DEFAULT false NOT NULL,
	`counterparty_vat_number` text,
	`counterparty_country` text,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_period_id`) REFERENCES `vat_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vat_entries_company_idx` ON `vat_entries` (`company_id`);--> statement-breakpoint
CREATE INDEX `vat_entries_period_idx` ON `vat_entries` (`company_id`,`vat_period_id`);--> statement-breakpoint
CREATE INDEX `vat_entries_taxpoint_idx` ON `vat_entries` (`company_id`,`tax_point_date`);--> statement-breakpoint
CREATE INDEX `vat_entries_source_idx` ON `vat_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`statement_import_id` text,
	`transaction_date` text NOT NULL,
	`value_date` text,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`balance_after_minor` integer,
	`bank_reference` text,
	`bank_transaction_id` text,
	`counterparty_name` text,
	`counterparty_iban` text,
	`transaction_type` text,
	`raw_data` text DEFAULT '{}' NOT NULL,
	`fingerprint` text NOT NULL,
	`occurrence_index` integer DEFAULT 0 NOT NULL,
	`accounting_period_id` text,
	`account_id` text,
	`vat_treatment_id` text,
	`supplier_id` text,
	`customer_id` text,
	`base_amount_minor` integer,
	`base_currency` text,
	`fx_rate_numerator` integer,
	`fx_rate_denominator` integer,
	`fx_rate_source` text,
	`status` text DEFAULT 'unclassified' NOT NULL,
	`journal_entry_id` text,
	`reconciliation_id` text,
	`reconciled_at` text,
	`applied_rule_id` text,
	`is_duplicate_of` text,
	`duplicate_confirmed` integer DEFAULT false NOT NULL,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_import_id`) REFERENCES `statement_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accounting_period_id`) REFERENCES `accounting_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bank_tx_company_idx` ON `bank_transactions` (`company_id`);--> statement-breakpoint
CREATE INDEX `bank_tx_account_date_idx` ON `bank_transactions` (`bank_account_id`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `bank_tx_status_idx` ON `bank_transactions` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `bank_tx_amount_idx` ON `bank_transactions` (`company_id`,`amount_minor`);--> statement-breakpoint
CREATE UNIQUE INDEX `bank_tx_fingerprint_unique` ON `bank_transactions` (`bank_account_id`,`fingerprint`,`occurrence_index`);--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`bank_account_id` text,
	`file_format` text DEFAULT 'csv' NOT NULL,
	`header_signature` text,
	`delimiter` text DEFAULT ',' NOT NULL,
	`encoding` text DEFAULT 'utf-8' NOT NULL,
	`skip_rows` integer DEFAULT 0 NOT NULL,
	`has_header_row` integer DEFAULT true NOT NULL,
	`column_map` text DEFAULT '{}' NOT NULL,
	`date_format` text DEFAULT 'day_first' NOT NULL,
	`decimal_separator` text DEFAULT '.' NOT NULL,
	`amount_style` text DEFAULT 'signed' NOT NULL,
	`invert_amount_sign` integer DEFAULT false NOT NULL,
	`default_currency` text DEFAULT 'EUR' NOT NULL,
	`times_used` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_profiles_company_idx` ON `import_profiles` (`company_id`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`statement_closing_balance_minor` integer NOT NULL,
	`ledger_balance_minor` integer NOT NULL,
	`difference_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`unmatched_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`missing_document_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`completed_at` text,
	`completed_by` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliations_company_idx` ON `reconciliations` (`company_id`);--> statement-breakpoint
CREATE TABLE `statement_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_format` text NOT NULL,
	`import_profile_id` text,
	`statement_start_date` text,
	`statement_end_date` text,
	`opening_balance_minor` integer,
	`closing_balance_minor` integer,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`rows_imported` integer DEFAULT 0 NOT NULL,
	`rows_duplicate` integer DEFAULT 0 NOT NULL,
	`rows_failed` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`imported_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `statement_imports_company_idx` ON `statement_imports` (`company_id`);--> statement-breakpoint
CREATE TABLE `document_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`document_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_version` text,
	`model` text,
	`extracted_text` text,
	`text_extraction_method` text,
	`fields` text DEFAULT '{}' NOT NULL,
	`overall_confidence` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`started_at` text,
	`completed_at` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_extractions_document_idx` ON `document_extractions` (`document_id`);--> statement-breakpoint
CREATE TABLE `document_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`document_id` text NOT NULL,
	`bank_transaction_id` text,
	`invoice_id` text,
	`match_type` text NOT NULL,
	`score` integer NOT NULL,
	`factors` text DEFAULT '[]' NOT NULL,
	`amount_difference_minor` integer,
	`date_difference_days` integer,
	`currency_matches` integer,
	`decision` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`decided_by` text,
	`decision_reason` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_transaction_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_matches_document_idx` ON `document_matches` (`document_id`);--> statement-breakpoint
CREATE INDEX `doc_matches_transaction_idx` ON `document_matches` (`bank_transaction_id`);--> statement-breakpoint
CREATE INDEX `doc_matches_decision_idx` ON `document_matches` (`company_id`,`decision`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`filename` text NOT NULL,
	`original_filename` text NOT NULL,
	`storage_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`page_count` integer,
	`document_type` text DEFAULT 'unknown' NOT NULL,
	`uploaded_at` text NOT NULL,
	`uploaded_by` text DEFAULT 'user' NOT NULL,
	`document_date` text,
	`supplier_id` text,
	`customer_id` text,
	`invoice_number` text,
	`currency` text,
	`net_minor` integer,
	`vat_minor` integer,
	`gross_minor` integer,
	`suggested_account_id` text,
	`suggested_vat_treatment_id` text,
	`extraction_status` text DEFAULT 'pending' NOT NULL,
	`classification_status` text DEFAULT 'pending' NOT NULL,
	`match_status` text DEFAULT 'unmatched' NOT NULL,
	`matched_transaction_id` text,
	`invoice_id` text,
	`is_duplicate_of` text,
	`duplicate_confirmed` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`suggested_vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_transaction_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documents_company_idx` ON `documents` (`company_id`);--> statement-breakpoint
CREATE INDEX `documents_hash_idx` ON `documents` (`company_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`company_id`,`extraction_status`,`match_status`);--> statement-breakpoint
CREATE INDEX `documents_supplier_idx` ON `documents` (`company_id`,`supplier_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`unit_price_minor` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`vat_treatment_id` text,
	`tax_rate_id` text,
	`rate_basis_points` integer DEFAULT 0 NOT NULL,
	`net_minor` integer DEFAULT 0 NOT NULL,
	`vat_minor` integer DEFAULT 0 NOT NULL,
	`gross_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`fixed_asset_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`direction` text NOT NULL,
	`invoice_number` text,
	`internal_number` integer,
	`reference` text,
	`supplier_id` text,
	`customer_id` text,
	`invoice_date` text NOT NULL,
	`due_date` text,
	`supply_date` text,
	`currency` text NOT NULL,
	`net_minor` integer DEFAULT 0 NOT NULL,
	`vat_minor` integer DEFAULT 0 NOT NULL,
	`gross_minor` integer DEFAULT 0 NOT NULL,
	`base_currency` text NOT NULL,
	`base_net_minor` integer DEFAULT 0 NOT NULL,
	`base_vat_minor` integer DEFAULT 0 NOT NULL,
	`base_gross_minor` integer DEFAULT 0 NOT NULL,
	`fx_rate_numerator` integer,
	`fx_rate_denominator` integer,
	`fx_rate_source` text,
	`fx_rate_date` text,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`outstanding_minor` integer DEFAULT 0 NOT NULL,
	`document_id` text,
	`journal_entry_id` text,
	`is_credit_note` integer DEFAULT false NOT NULL,
	`credit_note_of_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`voided_at` text,
	`void_reason` text,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoices_company_idx` ON `invoices` (`company_id`);--> statement-breakpoint
CREATE INDEX `invoices_direction_date_idx` ON `invoices` (`company_id`,`direction`,`invoice_date`);--> statement-breakpoint
CREATE INDEX `invoices_supplier_idx` ON `invoices` (`company_id`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `invoices_customer_idx` ON `invoices` (`company_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `invoices_status_idx` ON `invoices` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_number_idx` ON `invoices` (`company_id`,`invoice_number`);--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`allocated_minor` integer NOT NULL,
	`base_allocated_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`fx_difference_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_idx` ON `payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_invoice_idx` ON `payment_allocations` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`direction` text NOT NULL,
	`payment_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`base_currency` text NOT NULL,
	`fx_rate_numerator` integer,
	`fx_rate_denominator` integer,
	`method` text DEFAULT 'bank_transfer' NOT NULL,
	`bank_transaction_id` text,
	`officer_id` text,
	`journal_entry_id` text,
	`reference` text,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_transaction_id`) REFERENCES `bank_transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_company_idx` ON `payments` (`company_id`);--> statement-breakpoint
CREATE INDEX `payments_date_idx` ON `payments` (`company_id`,`payment_date`);--> statement-breakpoint
CREATE INDEX `payments_bank_tx_idx` ON `payments` (`bank_transaction_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`field` text,
	`previous_value` text,
	`new_value` text,
	`source` text DEFAULT 'user' NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL,
	`reason` text,
	`request_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_events` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_company_time_idx` ON `audit_events` (`company_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_request_idx` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`version` integer NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`includes_database` integer DEFAULT true NOT NULL,
	`includes_documents` integer DEFAULT true NOT NULL,
	`includes_configuration` integer DEFAULT true NOT NULL,
	`document_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_message` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `depreciation_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`fixed_asset_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`charge_type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`journal_entry_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fixed_asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `depreciation_asset_idx` ON `depreciation_charges` (`fixed_asset_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `fixed_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`asset_category` text DEFAULT 'computer_equipment' NOT NULL,
	`purchase_date` text NOT NULL,
	`supplier_id` text,
	`invoice_id` text,
	`document_id` text,
	`cost_minor` integer NOT NULL,
	`vat_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`base_cost_minor` integer NOT NULL,
	`base_currency` text NOT NULL,
	`account_id` text,
	`accumulated_depreciation_account_id` text,
	`depreciation_expense_account_id` text,
	`depreciation_method` text DEFAULT 'straight_line' NOT NULL,
	`useful_life_months` integer DEFAULT 48 NOT NULL,
	`residual_value_minor` integer DEFAULT 0 NOT NULL,
	`depreciation_start_date` text,
	`accumulated_depreciation_minor` integer DEFAULT 0 NOT NULL,
	`capital_allowance_rate_basis_points` integer DEFAULT 1250 NOT NULL,
	`capital_allowance_years` integer DEFAULT 8 NOT NULL,
	`accumulated_capital_allowances_minor` integer DEFAULT 0 NOT NULL,
	`capital_allowance_notes` text,
	`disposal_date` text,
	`disposal_proceeds_minor` integer,
	`disposal_notes` text,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accumulated_depreciation_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depreciation_expense_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fixed_assets_company_idx` ON `fixed_assets` (`company_id`,`status`);--> statement-breakpoint
CREATE TABLE `glossary_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`slug` text NOT NULL,
	`short_definition` text NOT NULL,
	`long_definition` text,
	`category` text,
	`related_terms` text DEFAULT '[]' NOT NULL,
	`irish_context` text,
	`is_system` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `glossary_terms_slug_unique` ON `glossary_terms` (`slug`);--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`suggested_actions` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`resolution` text,
	`snoozed_until` text,
	`dedupe_key` text NOT NULL,
	`vat_period_id` text,
	`accounting_period_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_items_company_idx` ON `review_items` (`company_id`,`status`,`severity`);--> statement-breakpoint
CREATE INDEX `review_items_dedupe_idx` ON `review_items` (`company_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `review_items_entity_idx` ON `review_items` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`applies_to` text DEFAULT 'bank_transaction' NOT NULL,
	`conditions` text DEFAULT '[]' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`auto_apply` integer DEFAULT false NOT NULL,
	`stop_on_match` integer DEFAULT true NOT NULL,
	`times_applied` integer DEFAULT 0 NOT NULL,
	`last_applied_at` text,
	`derived_from_history` integer DEFAULT false NOT NULL,
	`supplier_id` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rules_company_idx` ON `rules` (`company_id`,`enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_ip` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`last_login_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
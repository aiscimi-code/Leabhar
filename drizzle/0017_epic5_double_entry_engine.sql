CREATE TABLE `recurring_journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_journal_id` text NOT NULL,
	`company_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`account_id` text NOT NULL,
	`debit_minor` integer DEFAULT 0 NOT NULL,
	`credit_minor` integer DEFAULT 0 NOT NULL,
	`memo` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`recurring_journal_id`) REFERENCES `recurring_journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_journal_lines_template_idx` ON `recurring_journal_lines` (`recurring_journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_journal_lines_number_unique` ON `recurring_journal_lines` (`recurring_journal_id`,`line_number`);--> statement-breakpoint
CREATE TABLE `recurring_journals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`frequency` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_by` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_journals_company_idx` ON `recurring_journals` (`company_id`,`active`);--> statement-breakpoint
CREATE TABLE `timing_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`kind` text NOT NULL,
	`journal_entry_id` text NOT NULL,
	`reversal_date` text NOT NULL,
	`description` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`notes` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `timing_adjustments_company_idx` ON `timing_adjustments` (`company_id`,`kind`);--> statement-breakpoint
CREATE INDEX `timing_adjustments_reversal_idx` ON `timing_adjustments` (`company_id`,`reversal_date`);--> statement-breakpoint
ALTER TABLE `journal_lines` ADD `account_code` text;--> statement-breakpoint
ALTER TABLE `journal_lines` ADD `account_name` text;--> statement-breakpoint
/*
 * Issue #370: every journal line keeps the account code and name it was posted
 * with. Accounts can be renamed after the fact; the posted line must not
 * change with them. Existing lines take the account's current identity,
 * which is the identity they were posted under for any book whose chart has
 * not been edited since.
 */
UPDATE `journal_lines` SET
  `account_code` = (SELECT `code` FROM `accounts` WHERE `accounts`.`id` = `journal_lines`.`account_id`),
  `account_name` = (SELECT `name` FROM `accounts` WHERE `accounts`.`id` = `journal_lines`.`account_id`);--> statement-breakpoint
/*
 * Issues #367/#368: the accrual and prepayment accounts existed in every book
 * already, as ordinary accounts. The timing workflow addresses them by system
 * key, so they are promoted in place — same row, same history, same balance —
 * rather than leaving the workflow unable to find them in an upgraded book.
 * Only rows that have not been given a system key are touched.
 */
UPDATE `accounts` SET `system_key` = 'prepayments', `is_system` = 1
  WHERE `code` = '1600' AND `system_key` IS NULL;--> statement-breakpoint
UPDATE `accounts` SET `system_key` = 'accruals', `is_system` = 1
  WHERE `code` = '2300' AND `system_key` IS NULL;

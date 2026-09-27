ALTER TABLE `invoices` ADD `written_off_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `written_off_journal_entry_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `written_off_at` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `write_off_reason` text;--> statement-breakpoint
/*
 * Issue #404: every book gets the bad debts system account the write-off
 * posts to. Added only where the book has none yet and the code 6230 is free;
 * a book whose 6230 is already something else keeps it, and the write-off asks
 * for an expense account instead of guessing.
 */
INSERT INTO `accounts` (`id`, `company_id`, `code`, `name`, `type`, `subtype`, `vat_applicable`, `is_system`,
  `system_key`, `report_section`, `description`, `effective_from`)
SELECT 'acc_' || lower(hex(randomblob(12))), c.`id`, '6230', 'Bad debts', 'expense', 'operating_expense', 0, 1,
  'bad_debts', 'operating_expenses',
  'Debts written off as irrecoverable (issue #404). A later recovery reverses the write-off.',
  COALESCE((SELECT MIN(a.`effective_from`) FROM `accounts` a WHERE a.`company_id` = c.`id`), date('now'))
FROM `companies` c
WHERE NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`company_id` = c.`id` AND a.`system_key` = 'bad_debts')
  AND NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`company_id` = c.`id` AND a.`code` = '6230');

/*
 * The payroll cost accounts get system keys, so the payroll journal (issue
 * #527) resolves them by key instead of by code. Existing books are promoted
 * in place — same row, same history — as migration 0035 promoted the
 * dividends account. Only rows without a system key that are still the
 * expense account the default chart seeded are touched.
 */
UPDATE `accounts` SET `system_key` = 'wages_expense', `is_system` = 1
  WHERE `code` = '6180' AND `type` = 'expense' AND `system_key` IS NULL;
--> statement-breakpoint
UPDATE `accounts` SET `system_key` = 'directors_remuneration', `is_system` = 1
  WHERE `code` = '6160' AND `type` = 'expense' AND `system_key` IS NULL;
--> statement-breakpoint
UPDATE `accounts` SET `system_key` = 'employer_pension_expense', `is_system` = 1
  WHERE `code` = '6185' AND `type` = 'expense' AND `system_key` IS NULL;
--> statement-breakpoint
UPDATE `accounts` SET `system_key` = 'employer_prsi_expense', `is_system` = 1
  WHERE `code` = '6190' AND `type` = 'expense' AND `system_key` IS NULL;

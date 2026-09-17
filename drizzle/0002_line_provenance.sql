-- Extend provenance to journal_lines, invoice_lines and depreciation_charges (issue #48).
-- Also add confidence and provenance_status to journal_entries to complete the
-- provenance shape (createdBy/createdVia already serve as source).

ALTER TABLE `journal_entries` ADD COLUMN `confidence` integer;--> statement-breakpoint
ALTER TABLE `journal_entries` ADD COLUMN `provenance_status` text DEFAULT 'manually_entered' NOT NULL;--> statement-breakpoint

ALTER TABLE `journal_lines` ADD COLUMN `source` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `journal_lines` ADD COLUMN `confidence` integer;--> statement-breakpoint
ALTER TABLE `journal_lines` ADD COLUMN `provenance_status` text DEFAULT 'manually_entered' NOT NULL;--> statement-breakpoint

ALTER TABLE `invoice_lines` ADD COLUMN `source` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD COLUMN `confidence` integer;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD COLUMN `provenance_status` text DEFAULT 'manually_entered' NOT NULL;--> statement-breakpoint

ALTER TABLE `depreciation_charges` ADD COLUMN `source` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `depreciation_charges` ADD COLUMN `confidence` integer;--> statement-breakpoint
ALTER TABLE `depreciation_charges` ADD COLUMN `provenance_status` text DEFAULT 'system_rule' NOT NULL;--> statement-breakpoint

-- Supplement the immutability trigger to also protect the new provenance columns.
CREATE TRIGGER `journal_entries_no_edit_provenance`
BEFORE UPDATE ON `journal_entries`
FOR EACH ROW
WHEN OLD.is_posted = 1
  AND (
       NEW.confidence        IS NOT OLD.confidence
    OR NEW.provenance_status IS NOT OLD.provenance_status
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot change provenance on a posted journal entry');
END;

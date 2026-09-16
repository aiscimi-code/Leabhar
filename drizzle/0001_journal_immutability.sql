-- Posted-journal immutability triggers (issue #49).
--
-- The application enforces immutability in code via assertEntryMutable, but
-- nothing at the SQLite layer stops a future code path from issuing a direct
-- UPDATE or DELETE against a posted row. These triggers are defense in depth:
-- they reject any modification to a posted journal_entries row except the
-- reversal-linkage columns (reversed_by_entry_id, reversal_of_id,
-- reversal_reason, updated_at), and reject all modifications to journal_lines
-- whose parent entry is posted.

CREATE TRIGGER `journal_entries_no_edit_posted`
BEFORE UPDATE ON `journal_entries`
FOR EACH ROW
WHEN OLD.is_posted = 1
  AND (
       NEW.entry_number      IS NOT OLD.entry_number
    OR NEW.entry_date         IS NOT OLD.entry_date
    OR NEW.accounting_period_id IS NOT OLD.accounting_period_id
    OR NEW.narrative          IS NOT OLD.narrative
    OR NEW.source_type        IS NOT OLD.source_type
    OR NEW.source_id          IS NOT OLD.source_id
    OR NEW.entry_type         IS NOT OLD.entry_type
    OR NEW.posted_at          IS NOT OLD.posted_at
    OR NEW.is_posted          IS NOT OLD.is_posted
    OR NEW.company_id         IS NOT OLD.company_id
    OR NEW.created_by         IS NOT OLD.created_by
    OR NEW.created_via        IS NOT OLD.created_via
    OR NEW.notes              IS NOT OLD.notes
  )
BEGIN
  SELECT RAISE(ABORT, 'journal entry is posted and cannot be edited; post a reversing entry instead');
END;-->  statement-breakpoint

CREATE TRIGGER `journal_entries_no_delete_posted`
BEFORE DELETE ON `journal_entries`
FOR EACH ROW
WHEN OLD.is_posted = 1
BEGIN
  SELECT RAISE(ABORT, 'posted journal entry cannot be deleted');
END;-->  statement-breakpoint

CREATE TRIGGER `journal_lines_no_edit_posted`
BEFORE UPDATE ON `journal_lines`
FOR EACH ROW
WHEN (
  SELECT is_posted FROM `journal_entries` WHERE id = OLD.journal_entry_id
) = 1
BEGIN
  SELECT RAISE(ABORT, 'cannot edit a line on a posted journal entry');
END;-->  statement-breakpoint

CREATE TRIGGER `journal_lines_no_delete_posted`
BEFORE DELETE ON `journal_lines`
FOR EACH ROW
WHEN (
  SELECT is_posted FROM `journal_entries` WHERE id = OLD.journal_entry_id
) = 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete a line from a posted journal entry');
END;

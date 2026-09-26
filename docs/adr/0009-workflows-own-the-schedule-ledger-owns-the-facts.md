# 0009. Engine workflows own the schedule; the ledger owns the facts

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

EPIC 05 (issue #300) needed four posting workflows: recurring journals
(#366), accruals (#367), prepayments (#368) and the year-end close (#369).
Each one has a part that is *intent* — a template, a reversal date, a year
to close — and a part that is *accounting fact* — a posted journal entry.
ADR 0004 already fixes what a posted entry may do (nothing; corrections
reverse), so the question was where the intent lives and how a workflow run
twice avoids posting twice.

## Decision

Intent and facts live in different tables, and only the facts are immutable.
A recurring template (`recurring_journals`), an accrual or prepayment record
(`timing_adjustments`) and the year being closed (`accounting_periods`) are
editable metadata. Each thing the workflow posts is an ordinary journal
entry through `postJournalEntry`, identified by `source_type` + `source_id`
(+ the entry date for a recurring occurrence):

- a recurring occurrence is `source_type = 'recurring'`,
  `source_id = <template id>`, dated on the occurrence date;
- a close is `source_type = 'year_end_close'`, `source_id = <period id>`;
- a timing reversal's identity needs no marker at all: it is the ordinary
  `reverseJournalEntry` of the entry the workflow posted.

That identity is the idempotency key. `postDueRecurringJournals`,
`postDueTimingReversals` and `closeFinancialYear` recognise what has already
happened by reading the entries, never by mirroring state in their own
tables (`timing_adjustments` deliberately has no `reversed` column; the
journal entry's `reversed_by_entry_id` is the only record). A run posts
nothing that is already there; a due item whose period is missing or locked
is skipped with a reason rather than silently repaired or moved; and every
due date's period is checked before the first entry posts, so a run either
completes or leaves nothing behind.

## Consequences

- Running the due-post twice, or after a crash, is safe. There is no
  workflow state that can drift from the books, because there is no
  workflow state beyond intent.
- Correcting a workflow's output goes through the ordinary reversal: reverse
  the occurrence, the close, or let the timing reversal post on its due
  date. A wrong close is reversed and the year is closed again —
  `closeFinancialYear` refuses a second close only while the first stands.
- Templates may be edited freely; occurrences already posted do not follow
  the edits, which is the correct behaviour and needs no code to enforce.

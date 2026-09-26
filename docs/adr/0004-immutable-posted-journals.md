# 0004. Posted journals are immutable; corrections reverse

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

A journal entry is evidence of a decision made at a point in time. Editing a
posted entry rewrites history: a report produced last month silently stops
matching the copy the client or Revenue holds. README §31 requires an
append-only ledger, and audit practice requires that a correction be visible
as a correction.

## Decision

No code path updates or deletes a posted journal entry. `postJournalEntry`
(`src/domain/accounting/journal.ts`) is the only writer, and the correction
path is `reverseJournalEntry`, which posts a *new* entry with the inverted
lines, referencing the original. Corrections that re-post go through
`reverseJournalEntry` and a fresh post inside `atomically()`, with every
affected date's period checked up front (`assertAccountingPeriodOpen`), so a
path either completes or writes nothing. The same discipline guards VAT:
every path that writes VAT entries calls `assertVatPeriodWritable` first, and
a correction to a locked or filed period is made in an open period as
negative entries — never by editing the locked period.

## Consequences

- Any report ever produced remains reproducible: the entries it summed are
  still there, byte for byte.
- The ledger grows monotonically. Storage is cheap; a rewritten ledger is not.
- An incorrect entry is visible forever with its reversal beside it, which is
  what an auditor wants to see and what README §31 means by "append-only".
- There is no shortcut. The temptation is always "just fix the amount on that
  line" — the answer is always a reversing entry, and code review should
  reject any PR that adds an `UPDATE` against `journal_entries` or
  `journal_lines`.

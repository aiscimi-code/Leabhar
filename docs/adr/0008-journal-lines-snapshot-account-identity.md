# 0008. A journal line snapshots the account it was posted to

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

A journal line references its account by id, and the chart of accounts is
editable after posting: `updateAccount` (`src/domain/config/mutations.ts`)
will rename an account that already has posted lines. That is deliberate —
the chart is the user's — but it left a gap in the reproducibility promise
(ADR 0004, invariant #6 in AGENTS.md): rename account 6070 and every posted
line on it changes the name it reports, so an entry printed last year no
longer reads the same. The VAT layer already solves the same problem by
snapshotting the resolved rate and box mapping on each `vat_entries` row;
`journal_lines` snapshotted the FX rate but not the account identity.

## Decision

`journal_lines` carries `account_code` and `account_name`, populated by
`postJournalEntry` from the account row it validates against, at post time,
inside the posting transaction. The live `accounts` row stays authoritative
for the chart and for current reports; the snapshot makes each posted line
self-describing evidence. The audit-facing trace
(`traceJournalLine`, `src/domain/accounting/traceability.ts`) reads the
snapshot. Migration 0017 backfills existing lines from the account's current
identity, which is the identity they were posted under in any book whose
chart was not edited in between.

## Consequences

- Renaming an account never rewrites the wording of a posted entry; a
  historical line reads the same on every later re-run (tested in
  `src/domain/accounting/reproducibility.test.ts`).
- Trial balance and ledger reports still join `accounts` and show the
  current name; the snapshot is evidence, not a second chart of accounts.
  A rename therefore still changes how a *current* report labels the
  account — deliberately, since the chart is the user's.
- The columns are nullable because SQLite cannot add a NOT NULL column to
  an existing table without a default; the backfill fills them and
  `postJournalEntry` always writes them, so the gap is migration-only.

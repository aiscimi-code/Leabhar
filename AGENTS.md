# Leabhar — working notes

Local-first Irish accounting system. `docs/DOMAIN_MODEL.md` is the design
document and states the invariants; `docs/RUNNING.md` covers setup. The
repository `README.md` is the original specification.

## Non-negotiables

These are enforced by tests. Breaking one is a bug, not a trade-off.

1. **Money is integer minor units.** Never a float, never a bare number without
   a currency. Use `src/domain/money.ts`; `asMinor()` rejects non-integers.
2. **Posted journals are immutable.** No update path exists for a posted entry.
   Corrections are reversing entries via `reverseJournalEntry`.
3. **Every journal entry balances** in base currency, enforced at post time
   inside the transaction that writes it.
4. **Bank transactions are write-once evidence.** Classification lives in
   adjacent columns; the imported date, amount, description and reference are
   never edited.
5. **Documents are never modified.** Extraction reads. The SHA-256 recorded at
   ingest is re-checkable.
6. **Configuration is effective-dated, never overwritten.** Rates and treatments
   are superseded; historical entries resolve config as of their own date, and
   snapshot what they resolved.
7. **Nothing is silently repaired.** A detected problem becomes a review item.
8. **Provenance is mandatory.** Every derived value carries `source` and
   `provenanceStatus`. AI may propose; it may never overwrite `user_confirmed`.

## Things that are easy to get wrong

- **A reverse-charge invoice total is the NET**, not the gross. The supplier
  charged no VAT. Treating it as gross understates both cost and VAT.
- **The cash receipts basis applies to sales only.** Input VAT is reclaimed by
  reference to the supplier's invoice date under both bases.
- **T2 sums recoverable VAT, not VAT charged.** Non-deductible and restricted
  input VAT must not be claimed.
- **An extracted document is a draft, not evidence.** Matching, linking and VAT
  suggestions read `review_status = 'confirmed'` documents only; a person
  confirms each one on the review screen. Never match straight after extraction.
- **Input VAT comes only from a confirmed invoice.** A confirmed document is
  posted as an invoice line by line (`postDocumentAsInvoice`) and the bank line
  settles it (`settleBankTransaction`, or `settleInvoiceByDirector` when a
  director paid personally). A purchase classified or recorded as
  director-paid without an invoice claims no input VAT and is flagged; a split
  journal never debits input VAT; never split a bank amount into net and VAT.
- **A locked or filed VAT return is never changed.** Every path that writes VAT
  entries calls `assertVatPeriodWritable` before writing anything. A correction
  goes in an open period — negative entries, never a detached or edited one —
  and a late declaration only when the person names the period (flagged).
- **A posting path either completes or writes nothing.** A path that posts more
  than one thing (reverse then re-post, journal then VAT then a row update) runs
  inside `atomically`, and checks every date's accounting period
  (`assertAccountingPeriodOpen`) before writing. A new classification is never
  moved out of a locked period silently.
- **Invoice amounts are stored as printed.** A credit note's figures are
  positive; its `document_type` carries the sign.
- **A rule with no conditions matches nothing**, not everything.
- **An unassessable match factor carries zero weight** and is excluded, rather
  than scoring as half-right or counting against.

## Layout

```
src/domain/     accounting engine, VAT, matching, rules, extraction, reports
src/agent/      agent/CLI wrappers around the domain (no Next.js deps)
src/cli/        the reconciliation CLI entry point (tsx-runnable, `npm run cli`)
src/db/         schema, migrations, seed
src/app/        Next.js routes and server actions
src/components/ UI primitives
src/lib/        queries and formatting for the UI
```

Arithmetic belongs in `src/domain`. Pages render what the domain returns; they
never recompute a figure, so a report and the screen showing it cannot disagree.

The domain layer is UI-independent: every function takes a plain `AppDatabase`.
`src/agent/` and `src/cli/` build on that to drive import, matching,
classification and reconciliation from the terminal without Next.js. The same
domain functions back the web UI, so the two cannot disagree about a figure.
Run `npm run cli -- --help` for the command reference; see `docs/RUNNING.md`
for the agent workflow.

## Before committing

```bash
npm run typecheck && npm test
```

Financial logic needs a deterministic test. Never rely on an LLM for arithmetic.

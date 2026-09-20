# Running Leabhar

A local-first accounting and tax-preparation system for a small Irish company.
Everything runs on your own machine; nothing is sent anywhere.

## Requirements

- Node.js 22 LTS or later (see `.nvmrc`)
- No database server — SQLite is a file on disk

## Setup

```bash
npm install
cp .env.example .env        # optional; the defaults work
npm run db:migrate          # create the database
npm run dev                 # http://localhost:3000
```

Open `http://localhost:3000`. On first run you are redirected to `/login`
to create the single local user (display name, username, password). After
that you can use the app.

### The `better-sqlite3` native binding

`better-sqlite3` is a native module. If `npm run dev` fails with
`Could not locate the bindings file`, the native binary was not built
for your Node version — usually after switching Node or a fresh install
on a new platform. Rebuild it:

```bash
npm rebuild better-sqlite3
```

On first run there is no company. Either create one in **Setup → Company**, or
load the demo data to see how everything fits together first:

```bash
npm run db:seed
```

The demo company is fictional and labelled as demo data on every screen, so it
cannot be mistaken for your own books. It deliberately contains the awkward
cases — reverse charges from EU and US suppliers, an exempt supply, a capital
purchase, a director-paid expense, a duplicate document and an unclassified
transaction — rather than a tidy set that makes every screen look green.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:migrate` | Apply migrations |
| `npm run db:generate` | Generate a migration after a schema change |
| `npm run db:seed` | Create the demo company |
| `npm run cli` | Reconciliation CLI for agents (see below) |

## Reconciliation CLI

`npm run cli` is a terminal entry point for agents (or humans) that drives
the accounting engine end-to-end without the web UI. It opens the same local
SQLite database directly — the same trust model as `db:migrate` and
`db:seed`, with no authentication — so it is not a `serve` command and the
web app remains `npm run dev` / `npm start`.

All commands print JSON to stdout by default. `--format human` prints a
summary instead. Exit codes: `0` on success, `1` on error, `2` on usage
error. `npm run cli -- --help` lists every command and flag.

### Commands

```
# Induction — before any of this exists (issue #153)
npm run cli -- init-company --name "..."              # company + default chart
    [--vat-basis invoice|cash_receipts] [--vat-frequency bi_monthly]
    [--year-end MM-DD] [--base-currency EUR] [--seed-years "2024,2025"]
npm run cli -- add-bank --name "..." [--iban ...] [--currency EUR]
    [--opening <amount> --opening-date <date>]
    # --opening also journals the balance (Dr this account / Cr retained
    # earnings) at --opening-date — it is not just stored on the row.
npm run cli -- add-account --code <code> --name "..."
    --type asset|liability|equity|income|expense [--subtype ...]
    [--report-section current_assets|current_liabilities|fixed_assets|
                       revenue|cost_of_sales|operating_expenses|equity]
npm run cli -- add-customer --name "..." [--country IE] [--default-account <code>]
npm run cli -- ensure-default-accounts                # add any default chart
    # accounts introduced since this company was created (issue #159, e.g.
    # 6180 Wages and salaries, 6190 Employer PRSI, 5030 Materials, 2210 Bank
    # loans, 1020 Bank deposit/saver) — a new company gets them all already;
    # this is only for one induced earlier.
npm run cli -- install-rule-pack [--employee "Name"] [--second-bank-account <code>]
    [--rent-account <code>]
    # starter Irish SME bank-narrative rules (wages, employer PRSI, a
    # Revenue PAYE remittance, VAT3, rent, an own-account transfer to
    # savings, director drawings) — every rule is a normal, editable row.
    # A Stripe payout or a loan's capital/interest split is a multi-line
    # journal --transaction (issue #158), not something a rule can target.

# Books — once induction is done
npm run cli -- create-invoice --direction sales|purchase --file invoices.csv
    # one row per invoice/bill; columns: invoiceNumber, date, party (a
    # customer/supplier name or id), description, net, account, vatTreatment,
    # and optionally dueDate, supplyDate, statedVat, currency, creditNote, reference
npm run cli -- import-invoices --direction sales|purchase --file invoices.csv
    --account <code> --vat-treatment <code>
    # the intake version (issue #160): also creates a documents row (a real
    # CSV/PDF if the row's own `document` column names one, else a synthetic
    # text stand-in) linked to the invoice, so match() and missingDocuments
    # can actually find it — create-invoice alone posts the invoice with no
    # evidence behind it. Creates or reuses the customer/supplier by name.
    # Every row posts to the SAME --account/--vat-treatment, since there is
    # no per-row account column. Columns: invoiceNumber, date, party, net,
    # and optionally vat (stated, trusted over recomputing), gross
    # (cross-checked; a mismatch is a warning, not a failure), due,
    # description, currency, reference, document, and type (contains
    # "credit", or a number starting "CN-", -> credit note; net/vat/gross
    # are still given as positive amounts either way).
npm run cli -- record-payment [--transaction <id>] [--invoices "INV-1,INV-2"]
    [--amount <amount>] [--date <date>] [--unallocated] [--direction ...]
    # exact: one invoice, no --amount. lump: several --invoices, paid off in
    # order until the amount runs out. part: one invoice with --amount below
    # its outstanding balance. --unallocated leaves it on account on purpose.
    # A credit note's own cash flow runs the other way from its direction —
    # a sales credit note (customer refund) is settled with --direction made,
    # a purchase credit note (supplier refund) with --direction received;
    # --invoices infers this automatically per invoice.
npm run cli -- journal --date <date> --narrative "..." --lines <json> [--reason "..."]
    # a standalone multi-line manual adjustment — a VAT3 settlement, an
    # own-account transfer. --lines: [{"account":"code","debit":"100.00"}, ...],
    # major units.
npm run cli -- journal --transaction <id> --lines <json> [--vat <json>]
    # a split for ONE statement line instead — a Stripe payout's fee
    # breakdown, a loan repayment's capital/interest split — posted and
    # linked (bank_transactions.journalEntryId/status) in the same call,
    # dated at the transaction's own date. --date/--narrative/--reason do not
    # apply here. --vat additionally records this transaction's own VAT
    # position (e.g. output VAT on a Stripe payout's *gross* card sales,
    # which the settled net that hit the bank does not by itself report to
    # VAT3): {"direction":"sales","treatment":"IE_STD","net":"1744.94",
    # "statedVat":"401.34"}. classify stays one account + one VAT treatment
    # on purpose — this is the explicit alternative for a split, not a
    # change to what classify posts by default.

# Inspect
npm run cli -- list-transactions [--account <id>] [--unposted] [--unclassified]
npm run cli -- show-invoice <number>                   # full detail incl. lines and payments
npm run cli -- year-end --from <date> --to <date>      # P&L, balance sheet, tax worksheet, ...
npm run cli -- vat-return --period <id-or-name>        # VAT3 box figures for one period
npm run cli -- list-suppliers                          # every supplier (id, name, country, VAT no.)
npm run cli -- list-customers                          # every customer (id, name, country, VAT no.)

# Review queue
npm run cli -- scan-anomalies [--from <date>] [--to <date>] [--sync]
    # runs the deterministic anomaly scan (duplicate invoices, hospitality-
    # rate mismatches, an unidentified supplier, ...). --sync also writes the
    # findings into the review queue; without it, this only reports them.
npm run cli -- list-review-queue [--status open|resolved|dismissed|snoozed|superseded|all]
    [--severity info|warning|error|blocking] [--kind <kind>]
    # defaults to open items, sorted blocking -> error -> warning -> info

# Corrections
npm run cli -- void-invoice <number> --date <date> --reason "..."
    # reverses the invoice's journal entry and any VAT entries (dated at
    # --date, not the invoice date) and marks it void. Refuses an invoice
    # that already has a payment allocated — unallocate it first.
npm run cli -- reverse-journal <entry-id> --date <date> --reason "..."
    # reverses any journal entry (debits/credits swapped), for a mistake
    # made via journal or any other posting path

# Discovery
npm run cli -- list-accounts                          # bank accounts (id, name, currency)
npm run cli -- list-chart                             # chart of accounts (code, name, type)
npm run cli -- list-vat-treatments                    # VAT treatments (code, name, jurisdiction)
npm run cli -- list-reconciliations                   # past reconciliation records
npm run cli -- list-matches [--decision pending]      # document<->bank match candidates

# End-to-end flow
npm run cli -- import --account <id> --file <path>    # import a statement (CSV/XLSX)
    # a "Notes"/"Narrative"/"Comments" column is auto-detected onto the
    # transaction's own notes field, separate from its description — a
    # Stripe payout's fee breakdown, a loan's capital/interest split (#158)
npm run cli -- create-supplier --name "..." [--country IE] [--document <id>]
                                                      # create a supplier (ai_suggestion)
npm run cli -- match                                  # link documents to bank transactions
npm run cli -- accept-match --document <id> --transaction <id>   # accept a scored candidate
npm run cli -- link --document <id> --transaction <id>          # manually link a doc to a txn
npm run cli -- reject-match --document <id> --transaction <id>   # reject a scored candidate
npm run cli -- unmatch --document <id> --reason "..."            # remove a link
npm run cli -- classify --transaction <id>            # manually classify + post a transaction
           --account <code> --vat-treatment <code>
           [--supplier <id>] [--fx-rate <num>/<den>]
npm run cli -- create-rule --name "..."               # create a rule (JSON conditions/actions)
            --conditions <json> --actions <json> [--auto-apply]
npm run cli -- set-fx --transaction <id>              # set FX / settled base amount on a
        [--base-amount <amount>] [--fx-rate <num>/<den>]  # foreign line already imported
npm run cli -- auto-classify --account <id>           # classify unclassified txns from rules
npm run cli -- reconcile --account <id> --from <date> --to <date>
                                                      # compute reconciliation (read-only)
npm run cli -- reconcile --account <id> --from <date> --to <date> --sign-off
                                                      # record the reconciliation
npm run cli -- reconcile ... --sign-off --accept-difference "reason"
                                                      # sign off despite an unexplained difference
npm run cli -- run --account <id> [--file <path>] --from <date> --to <date>
                                                      # import (optional) -> auto-classify -> reconcile
npm run cli -- run ... --sign-off                     # ...and record it
```

### Agent workflow

`db:seed` only ever loads the Acme demo. To load a real (or synthetic) SME
company from the CLI alone, start with induction:

0. **Induct** the company: `init-company`, then `add-bank --opening` for
   each bank account (this is the only place an opening balance gets
   journaled — the row on `bank_accounts` alone is not enough), `add-account`
   for anything the default chart does not cover (or `ensure-default-accounts`
   for a company induced before a code existed), and `add-customer` for
   sales counterparties. `create-supplier` (below) covers the purchase side.
   Load invoices with `create-invoice --file` from a CSV once the parties
   and accounts it references exist — or `import-invoices --file` for an
   invoice-led pack, which also creates the `documents` row `match` (step 3
   below) needs to find each invoice; `create-invoice` alone posts the
   invoice with no evidence behind it. `install-rule-pack` seeds common
   Irish SME bank-narrative rules (wages, PAYE/PRSI, VAT3, rent, an
   own-account transfer, director drawings) so auto-classify handles them
   without a rule written by hand for each one.

The intended workflow from there is:

1. **Import** a statement (or re-run `run` without `--file` over
   already-imported data).
2. **Create suppliers** for extracted names that have no supplier yet.
   `create-supplier` adds a `suppliers` row with `ai_suggestion` provenance
   and optionally links a document; extraction also auto-creates a supplier
   for a high-confidence name with no existing match. If local extraction
   produced low-confidence names, re-extract the documents first (delete and
   re-ingest, or use the web UI's re-extract action) so the supplier names
   are usable.
3. **Match** documents to bank transactions. Matching links evidence but
   does **not** classify or post a transaction.
4. **Classify** transactions. Use `classify` to post a single transaction
   manually (accepting an account code and VAT treatment code from
   `list-chart` / `list-vat-treatments`), `create-rule` + `auto-classify`
   to post in batch from deterministic rules, `record-payment` where a
   transaction settles an invoice, or `journal` for anything that is not a
   single-account posting (a Stripe payout's gross/fee split, a loan
   repayment's capital/interest split, a VAT3 settlement, an own-account
   transfer). Each posts a balanced journal entry that the reconciliation
   then agrees with.
5. **Set FX** on foreign lines that lack a settled base amount: `set-fx`
   before classifying or reconciling (see Multi-currency below).
6. **Reconcile**; add `--sign-off` when the result is reconciled (or
   `--accept-difference "reason"` to sign off despite an unexplained
   difference, which is recorded in the audit trail).
7. **Inspect**: `list-transactions --unposted`/`--unclassified` to find what
   is left, `show-invoice` for one document's full detail, `year-end` for
   the P&L/balance sheet/tax worksheet pack, `vat-return` for one period's
   VAT3 box figures, `list-suppliers`/`list-customers` to recall an id.
8. **Review**: `scan-anomalies --sync` periodically to write duplicate
   invoices, hospitality-rate mismatches, an unidentified supplier and the
   rest into the review queue; `list-review-queue` to see what is open.
   `void-invoice`/`reverse-journal` correct a mistake by reversing it —
   never by editing or deleting the original posting.

### Multi-currency accounts

Reconciliation compares the statement against the ledger, and the ledger is
always in the company's base currency. A foreign-currency bank account's
running balance and per-line amounts are converted to base currency using the
exchange rate the statement itself carried (`base_amount_minor` / FX fields).
A foreign line with no settled base amount **and** no exchange rate is refused
with a clear error rather than silently folded into a base-currency difference.
Use `set-fx` to attach a settled base amount or exchange rate to an already-
imported foreign line (the rate is stored as an exact rational so the conversion
is reproducible), or pass `--fx-rate` to `classify` when posting the entry.
The imported evidence (date, amount, description) is never touched — only the
derived FX fields change.

## Configuration

All settings are environment variables, with working defaults:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_PATH` | `./data/accounting.db` | The accounting database |
| `DOCUMENT_STORAGE_PATH` | `./storage/documents` | Original documents, content-addressed |
| `BANK_IMPORT_WATCH_PATH` | `./storage/inbox` | Where the refresh action looks for statements |
| `BACKUP_PATH` | `./backups` | Versioned backups |
| `EXTRACTION_PROVIDER` | `local` | `local` or `anthropic` |
| `ANTHROPIC_API_KEY` | unset | Only needed for the `anthropic` provider |

### Document extraction

The default extractor is deterministic and local: it reads the PDF text layer
and applies labelled-field patterns. It needs no API key and no network, and the
application works end to end with AI switched off entirely.

Setting `EXTRACTION_PROVIDER=anthropic` with an API key present adds a
model-based extractor, used first with the local one as a fallback. It is asked
only for figures printed on the document, and its arithmetic is re-checked in
code afterwards — a model that helpfully recalculates a total is worse than one
that misreads it, because the error looks correct.

Neither provider decides anything. Extracted values are written with provenance
`ai_suggestion` and are excluded from a VAT return until you confirm them.

## Backups

Create one from **Setup → Backup**. Each backup is a new numbered version
containing the database, every stored document and a manifest of SHA-256 hashes,
so it can be verified before it is needed. Backups are never overwritten.

They are written to `BACKUP_PATH` on this machine. Copy them somewhere else as
well: a backup on the same disk protects you from mistakes but not from losing
the disk.

## What this does not do

- It does not file anything. There is no connection to Revenue or the CRO.
- It does not tell you that you are compliant. It reports whether its own
  internal checks passed, which is a much narrower claim.
- It does not calculate your corporation tax. The year-end pack shows the bridge
  from accounting profit to tax-adjusted profit as a worksheet, and lists the
  adjustments it does not make.
- It does not replace an accountant. It is designed to hand one a clean package
  of figures and evidence.

## Design

`docs/DOMAIN_MODEL.md` is the design document. It states the invariants the
system holds, the three-legged invoice/payment/bank-transaction model, and how
VAT tax points work under both accounting bases. If the code and that document
disagree, the code is wrong.

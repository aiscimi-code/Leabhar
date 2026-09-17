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
# Discovery
npm run cli -- list-accounts                          # bank accounts (id, name, currency)
npm run cli -- list-reconciliations                   # past reconciliation records
npm run cli -- list-matches [--decision pending]      # document<->bank match candidates

# End-to-end flow
npm run cli -- import --account <id> --file <path>    # import a statement (CSV/XLSX)
npm run cli -- create-supplier --name "..." [--country IE] [--document <id>]
                                                      # create a supplier (ai_suggestion)
npm run cli -- match                                  # link documents to bank transactions
npm run cli -- accept-match --document <id> --transaction <id>   # accept a scored candidate
npm run cli -- link --document <id> --transaction <id>          # manually link a doc to a txn
npm run cli -- reject-match --document <id> --transaction <id>   # reject a scored candidate
npm run cli -- unmatch --document <id> --reason "..."            # remove a link
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

The intended workflow is:

1. **Import** a statement (or re-run `run` without `--file` over
   already-imported data).
2. **Create suppliers** for extracted names that have no supplier yet.
   `create-supplier` adds a `suppliers` row with `ai_suggestion` provenance
   and optionally links a document; extraction also auto-creates a supplier
   for a high-confidence name with no existing match.
3. **Match** documents to bank transactions. Matching links evidence but
   does **not** classify or post a transaction.
4. **Auto-classify** unclassified transactions from `autoApply` rules.
   Classification posts the balanced journal entry that the reconciliation
   then agrees with.
5. **Reconcile**; add `--sign-off` when the result is reconciled (or
   `--accept-difference "reason"` to sign off despite an unexplained
   difference, which is recorded in the audit trail).

### Multi-currency accounts

Reconciliation compares the statement against the ledger, and the ledger is
always in the company's base currency. A foreign-currency bank account's
running balance and per-line amounts are converted to base currency using the
exchange rate the statement itself carried (`base_amount_minor` / FX fields).
A foreign line with no settled base amount **and** no exchange rate is refused
with a clear error rather than silently folded into a base-currency difference
— re-import the statement with a settled-amount column, or classify the
transaction with an exchange rate, before reconciling.

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

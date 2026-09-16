# Running Leabhar

A local-first accounting and tax-preparation system for a small Irish company.
Everything runs on your own machine; nothing is sent anywhere.

## Requirements

- Node.js 20 or later
- No database server — SQLite is a file on disk

## Setup

```bash
npm install
cp .env.example .env        # optional; the defaults work
npm run db:migrate          # create the database
npm run dev                 # http://localhost:3000
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

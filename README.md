# Leabhar

A local-first accounting and tax-preparation system for a small Irish
limited company. Everything runs on your own machine — the database is a
local SQLite file, documents are stored on disk, and nothing leaves the
machine unless you ask it to.

![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22-green)

Leabhar favours clarity, transparency and deterministic accounting over
feature quantity. Every figure it produces should be traceable back to the
original transaction and document. It is designed to hand an accountant a
clean package of evidence and figures, not to replace one.

This is not initially intended to be a general-purpose Xero/Sage
replacement. It is a highly transparent, explainable accounting system
for one small Irish LTD where bank transactions are imported, invoices
and receipts are stored and extracted, documents are matched to
transactions, VAT is summarised, and a year-end pack is produced — all
inspectable down to the source document.

## Current state

Leabhar is a working application with a web interface, not a library or a
prototype. The following are implemented and have deterministic test
coverage for the financial logic:

- **Company setup** — create a single company with its accounting basis
  (cash or accruals), VAT frequency and financial year.
- **Chart of accounts and VAT rates** — effective-dated configuration that
  historical entries resolve against, so a rate change never rewrites the
  past.
- **Bank transaction import** — import bank statements (CSV/Excel), with
  write-once evidence rows that are never edited after import.
- **Document repository** — content-addressed storage (SHA-256) for
  invoices, receipts and statements. Duplicates are flagged, never
  overwritten; documents are never modified after ingest.
- **Document extraction** — a deterministic local extractor reads PDF text
  layers and applies labelled-field patterns. An optional Anthropic
  provider adds model-based extraction; both write with `ai_suggestion`
  provenance and their arithmetic is re-checked in code.
- **Transaction classification and matching** — a rules engine with
  explainable match factors, plus a review queue for ambiguous items.
- **Journal entries and ledger** — double-entry journals that balance in
  base currency, enforced at post time. Posted entries are immutable;
  corrections are reversing entries.
- **VAT engine** — period summarisation, T2 (recoverable input VAT),
  reverse-charge handling, and VAT returns with per-box explainability.
- **Invoicing** — sales and purchase invoices with multi-line VAT,
  credit notes, FX, and cash-receipts-basis VAT deferral. Payments
  allocate to invoices and release deferred VAT proportionally.
- **Bank reconciliation** — decomposes the difference between statement
  and ledger into named components, with suspected-duplicate detection.
- **Depreciation and capital allowances** — straight-line and
  reducing-balance schedules, idempotent period posting, and disposal
  with profit/loss. Capital allowances are computed but never posted
  to the ledger.
- **Adjustments** — controlled manual journal entries with mandatory
  reasons, closed-period override, and reversal via reversing entries.
- **Anomaly detection** — deterministic arithmetic checks for unusual
  supplier amounts, VAT arithmetic failures, duplicate invoices,
  suspense balances, director debit balances, and stale debts.
- **VAT filing pack** — a human-readable pack per VAT period with
  drill-down, supporting documents, and reconciliation position.
- **CSV/XLSX exports** — trial balance, P&L, balance sheet, VAT filing
  pack, and transaction listings. No formulas; every figure is a value.
- **Global search** — suppliers, customers, invoices, transactions and
  documents by name, number, or amount.
- **Financial reports** — trial balance, profit & loss, balance sheet.
- **Year-end pack** — a worksheet bridging accounting profit to
  tax-adjusted profit, with the adjustments it does and does not make
  listed explicitly, plus a verified document bundle.
- **Backup and restore** — versioned backups with SHA-256 manifests;
  restore moves the current state aside first, never deletes it.
- **Demo data** — a fictional company loaded with the awkward cases
  (reverse charges, exempt supply, capital purchase, director-paid
  expense, duplicate document, unclassified transaction) so every screen
  can be exercised.
- **Prebuilt installer (Windows x64)** — a one-file installer that
  bundles Node.js, the standalone Next.js server and the database engine.
  Double-click, app opens in the browser. See
  [docs/RUNNING.md](docs/RUNNING.md) for details.

What it does not do: file anything with Revenue or the CRO, calculate
corporation tax, or replace an accountant. It produces a clean, auditable
package of figures and evidence for one.

## Quickstart

### Option A: Prebuilt installer (Windows)

Download `Leabhar-Setup-x64.exe` from the
[releases page](https://github.com/aiscimi-code/Leabhar/releases),
double-click it, and follow the installer. A desktop shortcut is
created — double-click "Leabhar" and your browser opens to
`localhost:3000`. No Node.js, npm or terminal required.

First run shows an empty database. Click "Try the demo" to load the demo
company, or set up your own.

### Option B: From source

You need Node.js 22 LTS or later (see `.nvmrc`). SQLite is a file on
disk, so there is no database server.

```bash
git clone https://github.com/aiscimi-code/Leabhar.git
cd Leabhar
npm install
cp .env.example .env        # optional; the defaults work
npm run db:migrate          # create the database
npm run db:seed             # optional: load the demo company
npm run dev                 # http://localhost:3000
```

Open `http://localhost:3000`. On first run you are redirected to `/login`
to create the single local user (display name, username, password). After
that you can use the app, and optionally load the demo company with
`npm run db:seed`.

If `npm run dev` fails with `Could not locate the bindings file`, the
`better-sqlite3` native binary was not built for your Node version — run
`npm rebuild better-sqlite3`. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/RUNNING.md](docs/RUNNING.md) for more.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Create the demo company |
| `npm run cli` | Reconciliation CLI for agents (see below) |
| `npm run build:package` | Build the standalone package (for the installer) |
| `npm run build:installer` | Compile the NSIS installer (requires `makensis`) |

### Reconciliation CLI

`npm run cli` is a terminal entry point for agents (or humans) that drives
the accounting engine end-to-end without the web UI. It opens the same local
SQLite database directly — the same trust model as `db:migrate` and
`db:seed`, not a `serve` command — and the web app remains `npm run dev`.

All commands print JSON by default; `--format human` prints a summary. Exit
codes: `0` on success, `1` on error, `2` on usage error. `npm run cli -- --help`
lists every command.

```bash
npm run cli -- list-accounts                          # bank accounts (id, name, currency)
npm run cli -- import --account <id> --file <path>    # import a statement (CSV/XLSX)
npm run cli -- create-supplier --name "..." [--country IE]  # seed suppliers for matching
npm run cli -- match                                  # link documents to bank transactions
npm run cli -- auto-classify --account <id>           # classify txns from autoApply rules
npm run cli -- reconcile --account <id> --from <date> --to <date>      # read-only
npm run cli -- reconcile --account <id> --from <date> --to <date> --sign-off
npm run cli -- run --account <id> [--file <path>] --from <date> --to <date>  # full pipeline
```

The intended agent workflow is: import (or re-run over already-imported data)
→ create suppliers for extracted names → match documents to transactions
→ auto-classify → reconcile → sign off. Matching links evidence but does
**not** classify or post a transaction; classification posts the journal
entry the reconciliation then agrees with. See
[docs/RUNNING.md](docs/RUNNING.md) for the full command reference.

## Documentation

- [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) — the design document and
  its invariants. When the code and this document disagree, the code is
  wrong.
- [docs/RUNNING.md](docs/RUNNING.md) — setup, configuration and what the
  system does and does not do.
- [docs/SPECIFICATION.md](docs/SPECIFICATION.md) — the original project
  brief the system was built against.
- [AGENTS.md](AGENTS.md) — working notes for contributors and AI-assisted
  development, including the non-negotiable accounting invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute, the test gate,
  and the CLA.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.

If you are wondering whether the installer is safe to run, read
[docs/TRUST.md](docs/TRUST.md).

## Contributing

Contributions are welcome. Before opening a pull request, read
[CONTRIBUTING.md](CONTRIBUTING.md) — it covers the test gate, the
accounting invariants, and the contributor licence agreement.

**Every commit must reference a corresponding GitHub issue.** If there is
no issue for the work you are doing, create one first. Link the issue in
your pull request description (e.g. `Closes #42`) so it auto-closes on
merge. This keeps the change history searchable and ensures every change
has a stated purpose.

Financial logic needs a deterministic test — never rely on an LLM for
arithmetic. Run the gate before committing:

```bash
npm run typecheck && npm test
```

Sign off your commits (`git commit -s`) to affirm the Developer
Certificate of Origin, and tick the CLA checkbox on the PR template.

## License

Leabhar is licensed under the GNU Affero General Public License v3.0 only
(AGPL-3.0-only). See [LICENSE](LICENSE) for the full text. The AGPL's
§13 network-use clause means that if you modify Leabhar and run it as a
network service, you must offer your users the source of your modified
version.

A commercial license is available for use cases that cannot comply with
the AGPL's source-disclosure obligations — see
[COMMERCIAL.md](COMMERCIAL.md). Contributions are accepted under the
terms in [CLA.md](CLA.md).

Copyright (C) 2026 Intleacht Research Limited.

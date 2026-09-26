# Leabhar

Local-first bookkeeping and tax preparation for a small Irish business: a
limited company, a sole trader or a partnership. Everything runs on your own
machine. The books are a local SQLite file, documents are stored on disk,
and nothing leaves the machine unless you ask it to.

![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22-green)

Leabhar keeps double-entry books from your bank statements and invoices, and
prepares the VAT and tax figures that follow from them. Each figure cites
the provision of Irish tax law it rests on, and can be traced back to the
invoice or bank line behind it. Where the treatment is not certain,
Leabhar does not guess. It flags the item, suggests a treatment, offers the
alternatives, and records the choice a person makes.

It prepares figures and evidence for you and your accountant. It does not
file anything, and it does not replace professional advice.

## What it does

### Books and ledger

- **Double-entry journals** that must balance in base currency before they
  post.
- **Posted entries are never edited.** A correction is a reversing entry.
- **Chart of accounts** that follows the type of business:
  - a company has share capital, dividends and a directors' account;
  - a sole trader has a capital account and drawings;
  - each partner has their own capital and current accounts.
- **Effective-dated configuration.** Rates, VAT treatments and profit
  shares are superseded from a date, never overwritten. Every historical
  entry resolves the configuration as of its own date and keeps a record
  of what it used.
- **Money is held as integer minor units with a currency**, never floats.
- **Foreign-currency transactions** carry the exchange rate used.
- **Accounting and VAT periods** with period locks.
- **Controlled adjustments**, each requiring a reason.
- **Depreciation schedules and fixed asset register**, including
  disposals.
- **Reports:**
  - trial balance, profit and loss, and balance sheet;
  - CSV/XLSX exports containing values, not formulas.

### Bank and documents

- **Bank statement import** from CSV and Excel. Imported bank lines are
  write-once evidence: classification sits beside them and never edits
  them.
- **Bank reconciliation** that breaks any difference down into named
  causes, and flags suspected duplicates.
- **Document store.** Invoices, receipts and statements are kept by their
  SHA-256 hash, never modified, and duplicates are flagged.
- **Extraction.** A local extractor reads the PDF text layer:
  - header fields, line items, VAT totals per rate, and invoice wording
    such as "reverse charge".
  - An optional Anthropic provider can be switched on as well.
  - Either way, the arithmetic is re-checked in code.
- **Review before use.** An extracted document is a draft. Nothing
  downstream (matching, posting, VAT) uses it until a person has checked
  it against the page image and confirmed it.

### Invoices and payments

- **Invoice-led posting.** A confirmed purchase or sales invoice is posted
  line by line with the VAT it states. The bank line then settles it,
  either directly or as a payment a director made personally.
- **Input VAT only from a confirmed invoice.** A purchase with no
  confirmed invoice claims no input VAT and is flagged. A bank amount is
  never split into net and VAT.
- **Checks on each invoice:**
  - Missing particulars required by S.I. 639/2010 reg.20: posting is
    refused, or the VAT is held back if you choose.
  - Foreign VAT charged, or a reverse charge shown with VAT on it.
  - The wrong VAT number, or none.
  - Late issue.
  - A credit note that exceeds or doesn't match its original.
- **Sales invoicing**, including credit notes, part payments and aged
  debtors.
- **Matching** of documents to bank lines, scored on explainable factors.

### VAT

- **Treatment suggestions from a statutory rules knowledge base.** Each
  rule quotes the Act, Schedule or Revenue guidance it comes from. The
  base covers:
  - rates, including the Finance Act 2025 changes;
  - exemptions;
  - place of supply and reverse charges;
  - input VAT restrictions;
  - the property, margin and other schemes.
  Where more than one treatment is possible, Leabhar offers the options
  and waits for you to choose.
- **Facts only you can confirm** are recorded by name before the rules
  depend on them:
  - where a supplier or customer is established;
  - a customer's VAT number, with a VIES check;
  - whether the company is an RCT principal;
  - the cash receipts basis authorisation.
- **The VAT3 return**, on the invoice basis or the cash receipts basis
  (the cash basis applies to sales only). Every box drills down to its
  entries. Each box's mapping cites Revenue's definition of that box.
- **Reconciliation of each return:**
  - each box equals the sum of its entries;
  - the VAT accounts agree with the return;
  - anything not yet classified or confirmed is listed as excluded, with
    its value.
- **Returns and statements:**
  - the annual Return of Trading Details, by rate;
  - the VIES statement, per customer VAT number.
- **Capital goods scheme** register, with the s.64 adjustments.
- **Apportionment** for dual-use inputs, and **cash-basis eligibility**
  checks.
- **Locked or filed returns are never changed.** A correction goes into an
  open period.

### Corporation tax (limited companies)

- A computation from accounting profit to tax, where each adjustment cites
  its section and lists the ledger lines behind it:
  - **add-backs:** depreciation, entertainment and gifts, fines, private
    and capital items, and taxes on income;
  - **capital allowances:** wear and tear, balancing allowances and
    charges, short accounting periods, and 100% claims for
    energy-efficient equipment (flagged for you to check the item is on
    the SEAI list);
  - **rates:** 12.5% on trading income and 25% on other income, read from
    the rules;
  - **loss relief:** losses carried forward automatically; a s.396A or
    s.396B claim if you choose one;
  - **close company surcharge;**
  - **dates:** preliminary tax and the CT1 filing date.
- Expense lines that look like entertainment, fines or private costs get a
  suggested treatment. So do income outside the trading accounts, loss
  claims and close company status. The figures use the suggestion until
  you record a choice.

### Income tax (sole traders and partnerships; not PAYE)

- **Basis period for the year,** including the commencement and cessation
  rules.
- **Partnership profits** split between partners by the profit shares in
  force, day by day.
- **Each person's liability:**
  - income tax at the bands and credits for their personal status;
  - USC;
  - PRSI Class S.
- **Payment dates:** preliminary tax and the return date.

### Year-end, review and evidence

- **Year-end pack:**
  - the financial statements;
  - the tax computation;
  - a fixed asset schedule;
  - VAT period summaries;
  - a document bundle whose hashes can be verified.
- **Review queue** for:
  - anomalies, such as unusual amounts, VAT arithmetic failures,
    duplicates and suspense balances;
  - rule conflicts;
  - suggestions no one has confirmed yet.
- **Audit trail** of who did what and when.
- **Statute viewer:** every rule links to the exact slice of the source
  text it quotes, and the file's hash can be re-checked.
- **Coverage matrix** (`docs/rules/coverage-matrix.json`), checked by a
  test. It records, for each provision in scope, whether it is ruled,
  deferred or not applicable.
- **Backups** with SHA-256 manifests. Restoring moves the current state
  aside first; nothing is deleted.

## What it does not do

- **It does not file anything.** Nothing is sent to Revenue (ROS) or the
  CRO. Leabhar produces the figures and evidence; you or your accountant
  file them.
- **No payroll or PAYE.**
- **Rules start unapproved.** Every derived rule starts as unreviewed and
  says so. Revenue guidance is marked as ranking below the Act it
  summarises.
- **Flagged, not computed:**
  - motor vehicle cost and emissions limits on capital allowances (the
    source is awaited, #211);
  - chargeable gains;
  - charges on income;
  - group relief;
  - associated companies' share of the surcharge threshold;
  - sole trader loss relief (ss.381/382);
  - a spouse's second income;
  - other non-trading income of an individual;
  - PRSI Class S before 25 September 2026 and the €5,000 Class S
    threshold (the sources don't give them yet).
- **Not built yet** (open issues):
  - RCT for principal contractors, including payment notifications and
    returns (#213);
  - financial statements in FRS 102 / Section 1A form, and CRO filings
    (#214);
  - an accountant pack of tax-ready documents with every flagged item
    listed (#215);
  - the VAT taxable amount rules in VATCA ss.36–45 (#245);
  - the remaining VAT rate and exemption paragraphs (#205, #206).
- **Scale:** one business per database, one local user. It is not a
  multi-client practice system.

## How to use it

1. **Set up the business.** Choose company, sole trader or partnership.
   Enter the year end, VAT registration and basis, and VAT period
   frequency. For a partnership, add the partners and their profit
   shares. Record the facts VAT turns on: RCT principal status, and the
   cash basis authorisation if you use it.
2. **Load the rules.** The statutory knowledge base loads from
   `docs/statutes/`. Its rules are suggestions until reviewed.
3. **Import bank statements** for each account.
4. **Add documents.** For each invoice and receipt, open it on the review
   screen, check the extracted fields against the page, and confirm it.
   Nothing unconfirmed is used.
5. **Post confirmed invoices,** choosing each line's VAT treatment where
   more than one is offered. Then settle each bank line against its
   invoice, or record a director-paid expense.
6. **Classify everything else** (wages, tax payments, transfers,
   dividends or drawings) and reconcile each bank account to its
   statement.
7. **Work the review queue.** Every flag is a question for a person, not
   something Leabhar has silently repaired.
8. **Each VAT period:**
   - check the reconciliation and that the excluded items list is empty;
   - review the VAT3;
   - lock the period once it's filed.

   Each year, also prepare the RTD; prepare VIES statements if you supply
   other EU businesses.
9. **At year end:**
   - make the treatment decisions the computation asks for, such as
     entertainment, other income, loss claims, close company status and
     personal status;
   - then hand the year-end pack to your accountant.

The same steps can be driven from the terminal (see
[Reconciliation CLI](#reconciliation-cli) below), and both use the same
domain code, so the web app and the CLI cannot disagree about a figure.

## Quickstart

### Option A: Prebuilt installer (Windows)

Download `Leabhar-Setup-x64.exe` from the
[releases page](https://github.com/aiscimi-code/Leabhar/releases),
double-click it, and follow the installer. It creates a desktop shortcut:
double-click "Leabhar" and your browser opens `localhost:3000`. You don't
need Node.js, npm or a terminal.

The first run shows an empty database. Click "Try the demo" to load a
fictional company that includes the awkward cases, or set up your own.

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

On first run you are asked to create the single local user.

If `npm run dev` fails with `Could not locate the bindings file`, run
`npm rebuild better-sqlite3`.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Create the demo company |
| `npm run cli` | The bookkeeping CLI (see below) |
| `npm run cli:rules` | Ingest statutes and derive or audit rules |
| `npm run build:package` | Build the standalone package (for the installer) |
| `npm run build:installer` | Compile the NSIS installer (requires `makensis`) |

### Reconciliation CLI

`npm run cli` drives the same accounting engine from the terminal, for
agents or people. It opens the local SQLite database directly. It prints
JSON by default; `--format human` gives a summary. Run
`npm run cli -- --help` for every command.

```bash
npm run cli -- init-company --name "..." --entity-type sole_trader --commenced 2024-01-01
npm run cli -- import --account <id> --file <path>             # a bank statement
npm run cli -- confirm-document <id> --confirmed-by "A. Person"   # after checking it
npm run cli -- post-document <id> --coding <json>             # post a confirmed invoice
npm run cli -- settle <transactionId> --allocations <json>     # bank line settles invoice
npm run cli -- reconcile --account <id> --from <date> --to <date> --sign-off
npm run cli -- vat-return --period "Mar–Apr 2025"              # VAT3 figures
npm run cli -- vat-reconcile --period "Mar–Apr 2025"           # boxes, ledger, excluded items
npm run cli -- rtd --date 2025-12-31                           # return of trading details
npm run cli -- vies --month 2025-03 --quarterly                # VIES statement
npm run cli -- ct-computation --from 2025-01-01 --to 2025-12-31
npm run cli -- it-computation --year 2025
```

The full reference and the agent workflow are in
[docs/RUNNING.md](docs/RUNNING.md).

## Documentation

- [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md): the design and its
  invariants. When the code and this document disagree, the code is
  wrong.
- [docs/RUNNING.md](docs/RUNNING.md): setup, configuration and the CLI
  reference.
- [docs/RULES_KB.md](docs/RULES_KB.md): the statutory rules knowledge
  base: sources, curation and review.
- [docs/statutes/](docs/statutes/): the legislation and Revenue guidance
  the rules quote, with their hashes.
- [docs/SPECIFICATION.md](docs/SPECIFICATION.md): the original project
  brief.
- [AGENTS.md](AGENTS.md): working notes and the non-negotiable accounting
  invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

If you are wondering whether the installer is safe to run, read
[docs/TRUST.md](docs/TRUST.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first:
it covers the test gate, the accounting invariants, and the contributor
licence agreement.

**Every commit must reference a GitHub issue.** If there is no issue for
your work, create one first, and link it in the pull request (e.g.
`Closes #42`).

Financial logic needs a deterministic test; never rely on an LLM for
arithmetic. Run the gate before committing:

```bash
npm run typecheck && npm test
```

Sign off your commits (`git commit -s`) to affirm the Developer
Certificate of Origin, and tick the CLA checkbox on the PR template.

## License

Leabhar is licensed under the GNU Affero General Public License v3.0 only
(AGPL-3.0-only); see [LICENSE](LICENSE). Under the AGPL's §13 network-use
clause, if you modify Leabhar and run it as a network service, you must
offer your users the source of your modified version.

A commercial licence is available for uses that cannot meet the AGPL's
source-disclosure obligations; see [COMMERCIAL.md](COMMERCIAL.md).
Contributions are accepted under the terms in [CLA.md](CLA.md).

Copyright (C) 2026 Intleacht Research Limited.

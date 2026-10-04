# Domain Model

This document is the design artefact required by README §49. It is written
before the schema and before the UI. If the code and this document disagree,
the code is wrong.

---

## 0. Non-negotiable invariants

These hold everywhere in the system. Tests enforce each one.

1. **Money is integer minor units.** Every monetary value is a whole number of
   cents (or the minor unit of its currency), stored as SQLite `INTEGER`, and
   always carried with an explicit currency code. There is no floating point
   arithmetic anywhere in the accounting path.
2. **Journals are immutable once posted.** A posted journal entry is never
   edited or deleted. Corrections are new reversing entries that reference the
   original. This is what makes §31's "append-only" real rather than aspirational.
3. **Every journal entry balances.** Sum of debits equals sum of credits, per
   currency, enforced at write time inside the transaction that posts it.
4. **Bank evidence is never mutated.** An imported bank transaction row is
   write-once. Classification, matching and reconciliation live in adjacent
   tables that point at it.
5. **Source documents are never modified.** Extraction reads; it does not write
   back to the file. The file's SHA-256 is recorded at ingest and re-checkable.
6. **Configuration is effective-dated, never overwritten.** Tax rates, VAT
   treatments and accounts are superseded, not replaced. A historical entry
   resolves its configuration as of its own date.
7. **Nothing is silently repaired.** A detected integrity problem becomes a
   review-queue exception. The system stops and asks.
8. **Provenance is mandatory.** Every classified or derived value carries a
   `source` and a `status`. There is no such thing as an unattributed number.

---

## 1. Entity map

```
Company ──┬── BankAccount ──── BankTransaction ──┐
          │                                      │
          ├── CompanyOfficer                     │ evidence of money movement
          ├── CompanyTradingName                  │
          ├── CompanyTradingActivity              │
          ├── CompanyRegistration                 │
          ├── AccountingPeriod                   │
          ├── VatPeriod                          │
          └── TaxDeadline                        │
                                                 ▼
Document ──── Extraction ──── DocumentMatch ──── (link)
   │                               ▲
   │ evidence                      │ candidate + confidence + decision
   ▼                               │
Invoice (sales | purchase) ────────┘
   │
   ├── InvoiceLine
   └── Payment ──── (settles) ──── BankTransaction

                    Any of the above may produce:
                         JournalEntry
                              └── JournalLine ──── Account
                              └── VatEntry ──── TaxRate / VatTreatment
```

Supporting: `Supplier`, `Customer`, `FixedAsset`, `Rule`, `AuditEvent`,
`FxRate`, `Reconciliation`, `Adjustment`.

---

## 2. The central distinction

A **bank transaction** is evidence that money moved. It is *not* an accounting
entry. The chain is deliberately three-legged:

```
Invoice          (the obligation, and the tax point on invoice basis)
   ↓
Payment          (the settlement, and the tax point on cash receipts basis)
   ↓
BankTransaction  (the evidence that the settlement occurred)
```

Each leg can exist without the others, and the system must represent every
partial state honestly:

| State | Meaning | Where it surfaces |
|---|---|---|
| Invoice, no payment | Debtor / creditor outstanding | Balance sheet, aged listings |
| Payment, no bank transaction | Recorded settlement not yet seen on a statement | Reconciliation difference |
| Bank transaction, no invoice | Unmatched — missing document | Review queue |
| Bank transaction, no payment link | Unclassified money movement | Review queue |

Collapsing these into "bank transaction + VAT + category" is precisely the
failure mode README §4 forbids.

---

## 3. Money and currency

```
original_amount_minor   INTEGER   as it appears on the evidence
original_currency       TEXT      ISO 4217
fx_rate_numerator       INTEGER   null when original == base
fx_rate_denominator     INTEGER
base_amount_minor       INTEGER   derived, stored, never recomputed on read
base_currency           TEXT      company base currency at time of entry
fx_rate_source          TEXT      imported | manual | ai | system
fx_rate_date            TEXT
```

Rules:

- The original value is never replaced by its conversion (§22).
- FX rates are stored as an integer numerator/denominator pair so the rate
  itself is exact and auditable, and the conversion is reproducible.
- Rounding happens once, at conversion, half-up, and the rounded result is
  stored. Reports sum stored values; they never re-derive conversions.
- A missing FX rate is an **exception**, never an assumed 1.0.
- FX gain/loss on settlement posts to a dedicated account so it is separately
  identifiable (§22).

---

## 4. Double-entry core

```
JournalEntry
  id, company_id, entry_date, period_id, narrative,
  source_type, source_id,          -- what caused this entry
  posted_at, reversal_of_id, is_reversal,
  created_by, created_via          -- user | rule | import | system
JournalLine
  id, journal_entry_id, line_no, account_id,
  account_code, account_name,        -- the account as at post time (ADR 0008)
  debit_minor, credit_minor,       -- exactly one is non-zero
  currency, base_debit_minor, base_credit_minor,
  supplier_id, customer_id, memo
```

Invariants enforced at post time:

- `sum(base_debit_minor) == sum(base_credit_minor)` for the entry.
- Exactly one of `debit_minor` / `credit_minor` is non-zero per line.
- At least two lines.
- `entry_date` falls inside an accounting period that is not `locked`.
- Once `posted_at` is set the row is immutable; the ORM layer exposes no update
  path for posted entries.

Reversal is the only correction mechanism. A reversal entry copies the lines
with debits and credits swapped, sets `reversal_of_id`, and posts at the
correction date (not the original date) unless the original period is still open.

The engine's scheduled workflows — recurring journals, accruals and
prepayments, the year-end close — are records *above* this ledger: they own
the schedule (a template, a reversal date, a year to close), while everything
they post is an ordinary journal entry identified by `source_type` +
`source_id`, which is what makes re-running them idempotent (ADR 0009).

---

## 5. Accounts

```
Account
  id, code, name, type, subtype, parent_id,
  vat_applicable, default_vat_treatment_id,
  is_system,                -- system accounts cannot be deleted
  active, effective_from, effective_to, notes
```

`type` ∈ `asset | liability | equity | income | expense`.
Normal balance is derived from type: assets and expenses are debit-normal.

An account referenced by a posted journal line can be **archived** but never
deleted (§10). Archiving is a recorded decision: it needs a reason, closes the
account's effective window (`effective_to`) on the archive date, prevents new
postings, and flags the account on the review queue if it still carries a
balance. History is never disturbed.

System accounts that the engine posts to by name, and therefore must always
exist: bank control, VAT on sales, VAT on purchases, VAT control, debtors,
creditors, director's current account, share capital, retained earnings,
suspense, FX gain/loss, rounding difference, accruals, prepayments, plus the payroll accounts (PAYE,
USC, PRSI, net wages, pension deductions) and stock on hand.

The chart installed at company creation varies by entity type (issue #212: a
company has share capital and dividends; a sole trader a capital account and
drawings) and by sector (`chartKind: 'farm'`, issue #360). Accounts can also be
mapped onto a named external chart (`account_mappings`, issue #362) so an
exported trial balance can be restated in the external codes; a mapping states a
correspondence and never moves a figure.

---

## 6. VAT model

The spec's most important instruction here is §7: *"A transaction should contain
a VAT treatment, not merely a VAT percentage."* The treatment is the primary
key of VAT behaviour; the rate is a consequence.

```
VatTreatment
  id, code, name, description,
  jurisdiction,                    -- IE | EU | NON_EU
  direction,                       -- sales | purchases | both
  applies_rate,                    -- bool: does a rate attach at all
  is_reverse_charge,               -- self-accounted: output + input
  is_recoverable,                  -- can the input VAT be reclaimed
  recoverable_pct,                 -- partial exemption, default 100
  sales_box, purchases_box,        -- VAT3 box mapping, see below
  net_sales_box, net_purchases_box -- E1/E2/ES1/ES2 statistical boxes
  effective_from, effective_to, active, is_default, notes,
  source_note, source_date         -- §48: where the rule came from, and when
```

### VAT3 box mapping

Without this the filing pack is decorative. Each treatment declares which box
its VAT and its net amount land in:

| Box | Meaning |
|---|---|
| T1 | VAT on sales |
| T2 | VAT on purchases |
| T3 | Net payable (T1 − T2, when positive) |
| T4 | Net repayable (T2 − T1, when positive) |
| E1 | Goods dispatched to other EU member states (net) |
| E2 | Goods acquired from other EU member states (net) |
| ES1 | Services supplied to other EU member states (net) |
| ES2 | Services received from other EU member states (net) |
| PA1 | Goods imported under postponed accounting (net) |

Seeded treatments (all editable, none hard-coded in logic):

- `IE_STD` Irish standard rate — T1/T2
- `IE_RED` Irish reduced rate — T1/T2
- `IE_SECOND_RED` Irish second reduced rate — T1/T2
- `IE_ZERO` Irish zero-rated — T1/T2 at 0%, net still reported
- `IE_EXEMPT` Exempt — no VAT, not the same as zero-rated
- `OUT_OF_SCOPE` Outside the scope of Irish VAT
- `EU_GOODS_ACQ` EU acquisition of goods — reverse charge, T1 + T2, E2
- `EU_SERVICES_RCV` EU services received — reverse charge, T1 + T2, ES2
- `EU_GOODS_SUPPLY` Intra-Community supply of goods — zero-rated, E1
- `EU_SERVICES_SUPPLY` Services supplied to EU business — ES1
- `NON_EU_SERVICES_RCV` Services from outside the EU — reverse charge, T1 + T2
- `IMPORT_PA` Import of goods, postponed accounting — T1 + T2, PA1
- `IMPORT_VAT_PAID` Import VAT paid at the point of entry — T2 only
- `RC_CONSTRUCTION` Domestic reverse charge (construction) — T1 + T2

Zero-rated, exempt and outside-scope are three distinct treatments with three
distinct reporting consequences. §7 is explicit that they must not be conflated,
and the seeded data reflects that.

### VAT entries

```
VatEntry
  id, journal_entry_id, source_type, source_id,
  vat_treatment_id, tax_rate_id,
  direction,                       -- sales | purchases
  net_minor, vat_minor, gross_minor, currency,
  base_net_minor, base_vat_minor, base_gross_minor,
  recoverable_vat_minor,
  tax_point_date,                  -- drives period assignment
  vat_period_id,                   -- resolved from tax_point_date
  sales_box, purchases_box, net_box,   -- snapshotted from the treatment
  source, confidence, status       -- provenance, §19
```

A reverse-charge transaction produces **two** VatEntry rows from one document:
an output entry (T1) and an input entry (T2), the second carrying
`recoverable_vat_minor` per the treatment's recoverable percentage. This is why
VAT entries are separate rows rather than columns on a transaction.

The box columns are **snapshotted** onto the entry at creation. If the treatment
config is later edited, historical entries keep the mapping that applied when
they were created (§46).

### Tax point and accounting basis

`tax_point_date` is the single field that makes both bases work:

| Basis | Sales tax point | Purchases tax point |
|---|---|---|
| Invoice basis | Invoice date | Invoice date |
| Cash receipts basis | **Payment date** | Invoice date |

On the cash receipts basis a sales invoice creates no output VAT entry at
invoice time. Each payment against it creates an output VAT entry for the
proportion settled, dated at the payment. Part-payments therefore produce
several VAT entries across several periods, which is correct and is the reason
this could not have been retrofitted onto a column-based design.

Input VAT is on the invoice date under **both** bases — the cash receipts basis
in Ireland applies to output VAT only. This asymmetry is deliberate and tested.

An import under postponed accounting (IMPORT_PA) self-accounts VAT on the
value for import VAT purposes: customs (CIF) value, plus customs/excise duty
and other charges payable at importation, plus freight from the EU point of
entry to Ireland (Revenue Customs Manual on Import VAT §2.3). Box PA1 reports
the customs value plus customs duty (Revenue, completing the VAT3). Both come
from the customs declaration (`importValuation` on the invoice line, in the
base currency), never the supplier's invoice; a line without one is posted on
the invoice net and flagged (#609).

Northern Ireland is a Member State for goods and outside the EU for services
(the Protocol / Windsor Framework; VIES Traders Manual, Appendix 9; VATCA s.2
as revised). A trader there is recognised by an `XI` VAT number, or `XI` as its
country, and `counterpartyInEu` follows the supply kind: goods from an XI
supplier are an acquisition (E2), goods to an XI customer an intra-Community
supply (E1 and VIES), and services either way are non-EU (#610).

The cash receipts basis needs Revenue's authorisation (VATCA s.80(1), S.I.
639/2010 reg.25). Choosing it on the company profile does not put a sale on it:
a sale is on the cash basis only when an authorisation is recorded from a date
on or before its tax point (`vatBasisOn`, `src/domain/vat/basis.ts`). Any other
sale is on the invoice basis, and new companies default to the invoice basis
(#608). Release on receipt and cancellation on a bad debt follow how each
invoice was actually posted (`invoiceVatDeferred`), never the basis today, so a
sale declared on its invoice is not declared again when it is paid
(s.80(2)(b)).

---

## 7. Tax rates

```
TaxRate
  id, name, rate_basis_points,     -- 23% == 2300, integer, no floats
  tax_type,                        -- vat | corporation_tax | other
  jurisdiction, effective_from, effective_to,
  active, is_default, notes,
  reporting_classification,
  source_note, source_date
```

- Rates are integer basis points. 23% is `2300`, 13.5% is `1350`, 9% is `900`.
- Resolution is by date: the rate applicable to an entry is the one whose
  effective window contains the entry's tax point.
- Changing a rate today creates a new row and closes the old one's window. It
  does not touch history (§6).
- A rate referenced by any VAT entry can never be deleted, only deactivated.

---

## 8. Periods

`AccountingPeriod` and `VatPeriod` are independent (§9) and both are real date
ranges (§8), never derived by a quarterly assumption in code.

```
AccountingPeriod: id, company_id, kind, name, start_date, end_date, status
                  kind ∈ financial_year | month | custom
                  status ∈ open | review | closed | locked
VatPeriod:        id, company_id, name, start_date, end_date,
                  filing_deadline, status, submitted_at,
                  net_payable_minor, net_repayable_minor
                  status ∈ open | review | ready | locked | submitted
```

Period assignment is automatic, by date containment, at post time. A
transaction dated outside every defined period is an exception, not a silent
drop. Frequency is a generator convenience only: bi-monthly, monthly,
four-monthly, half-yearly and annual generators exist, but they emit explicit
rows the user can then edit.

Locking a period blocks new postings dated inside it. Unlocking is itself an
audited event with a mandatory reason.

---

## 9. Lifecycles

### Document

```
uploaded → hashed → (duplicate? → flagged, never overwritten)
        → read (PDF text layer, OCR on this computer, or the optional AI reader)
        → DRAFT: header, parties, every line, VAT per rate, VAT wording
        → person checks it against the page, corrects, adds what is missing
        → CONFIRMED (or rejected)
        → matched to a bank transaction / linked to an invoice
```

Review status: `unreviewed | confirmed | rejected` (`documents.review_status`).
Extraction status and match status are tracked separately.

A draft is never evidence. Matching (`findMatchesForDocument`, `linkDocument`,
`matchAllUnmatched`) and VAT suggestions (`transactionFacts`) read confirmed
documents only; an unconfirmed document raises an error there rather than being
used. Confirmation runs `checkDocumentValues` (`src/domain/documents/checks.ts`):
errors (no date, total, currency or counterparty) block it; arithmetic warnings
(line VAT ≠ rate × net, lines not summing to the header, per-rate totals not
summing) must be acknowledged one by one. Every field changed at confirmation is
audited against the draft. A re-read never overwrites a confirmed document; to
correct one, reopen it, which is refused while it supports a match or invoice.

Amounts are stored as printed. A credit note's lines and totals are positive;
`document_type = 'credit_note'` carries the sign.

Lines live in `document_lines`, per-rate VAT in `document_vat_totals`, both with
provenance. The VAT rate for a purchase comes from these confirmed lines — never
from a bank amount.

Not every document is evidence of a supply. The vault types (contract, Revenue
document, grant letter, payslip, company document) are filed as what the person
says they are: the invoice reader does not run on them, there are no figures to
confirm, and the declaration is the confirmation (`src/domain/documents/types.ts`).

Every reading of a document is versioned in `document_extractions`; the file
itself never changes. The screen shows the latest reading expanded and every
earlier one disclosed, so a confirmed value can always be compared with what
was read before it.

Retirement is two audited steps (ADR 0010, `src/domain/documents/lifecycle.ts`):
archive (soft, reversible, refused while the document supports an invoice, a
linked bank transaction or an accepted match) then, deliberately, delete —
which removes the file only when no other document shares its bytes. Retention
(`src/domain/documents/retention.ts`) is an effective-dated policy per type
(or a default), resolved as of each document's own date; it never disposes of
anything itself — documents past it are listed on the retention screen for a
person to archive with a reason.

### Input VAT without a confirmed invoice (issue #234)

`createInvoice` recovers input VAT on a purchase only when it is posted from a
confirmed document (`documentId` whose `review_status` is `confirmed`). A
purchase typed in or imported from a ledger CSV posts with its VAT costed and
held back from recovery, and each line is flagged; the VAT is recovered by
uploading, confirming and posting the supplier's invoice. An accountant's
input VAT adjustment (`createAdjustment` with purchase VAT) is allowed as a
reasoned correction and raises a review item. An invoice migrated from a
previous system whose VAT was already declared there is posted with
`vatAlreadyDeclared: { reason }` (CLI `--vat-already-declared`): information
only — no VAT entries, no VAT journal lines, the whole gross to the line
accounts — and the reason is audited.

### Statements, overdue and reminders (issue #405)

Overdue is computed on the day asked, never stored: a sales invoice is overdue
when its due date (or, with none, its invoice date) is before `asOf` and
something is outstanding. `customerStatement` lists a customer's invoices,
debit notes, credit notes, payments, refunds, reversed payments (dated by the
reversing journal) and write-offs in date order, in base currency, with a
running balance; voided documents are left out and an applied credit note is
not listed twice. Its closing balance is the customer's share of debtors
(tested against the ledger). A reminder letter (level 1, 2 or 3) is recorded
in `reminder_letters` with each invoice and what it had outstanding, so it can
be produced again exactly; sending it is the person's. `receivablesSummary`
gives owed, overdue, money on account, the largest balances, customers over
their credit limit and how many overdue invoices have had no reminder in 14
days.

### Bad debts (issue #404)

`writeOffBadDebt` takes a sales invoice's outstanding amount out of debtors,
dated when the debt is judged irrecoverable, to the `bad_debts` system account
(6230, added to existing books where the code is free) or a chosen expense
account. The invoice becomes `written_off` with `outstanding_minor` 0 and
`written_off_minor` set, so gross = paid + written off. VAT follows the basis:
on the cash receipts basis the unpaid share of the output VAT was never due and
is cancelled against deferred VAT (only the net is a bad debt); on the invoice
basis the VAT was declared, relief under VATCA s.39 is a judgement, and nothing
is claimed — a review item says relief may be available (#278). A written-off
invoice cannot be paid, voided or given money on account until
`reverseBadDebtWriteOff` (the debt recovered) reverses the journal and reopens
it.

### Debit notes (issue #403)

A debit note is an additional charge against an earlier invoice of the same
party and direction (an undercharge corrected): `is_debit_note` and
`debit_note_of_id` on the invoice. In every other respect it is an invoice — its
own number, VAT, due date and ageing — and its PDF is titled "Debit note" and
names the invoice it adds to.

### Customer credit (issue #402)

A customer's credit is its open credit notes plus money its payments hold on
account. `applyCreditNote` settles an invoice from a credit note of the same
party without cash: a zero-cash `offset` payment with two allocations, no
journal (both documents sit on debtors) and no VAT — on the cash receipts
basis the credited share of the invoice's deferred VAT and the credit note's
own deferred VAT cancel, and later receipts release only the rest. It is
undone with `unapplyCreditNote`, never by `reversePayment`.
`refundOnAccount` pays money on account back (Dr debtors / Cr bank, or the
mirror for a supplier), from a statement line or on a date, as a payment with
`refund_of_payment_id`; the original's on-account balance falls, and the
original cannot be reversed while a refund of it stands.

### Sales invoice document (issue #395)

`salesInvoiceDocument` arranges a posted sales invoice or credit note for
issue: supplier (the company's name, principal business address or registered
office, VAT and CRO numbers), customer (with the billing contact), each line
with any discount, the net and VAT at each rate, and totals — all the posted
figures, a credit note's stated as printed. It lists the S.I. 639/2010 reg.20
particulars that are missing (the business's address or VAT number, the
customer's address, the customer's VAT number for an intra-EU or
reverse-charge supply, the invoice a credit note credits) and the legend each
treatment requires. Nothing missing is filled in: the PDF (`renderInvoicePdf`,
pdf-lib, standard fonts, generated locally) is marked as a draft and lists the
gaps. The legend wording follows Directive 2006/112/EC Art. 226 and VATCA
s.16, and should be confirmed by the business's accountant.

### Recurring sales invoices (issue #394)

A recurring invoice is a template (customer, lines, monthly/quarterly/yearly,
start and optional end), not an invoice. Occurrences step from the start date
and clamp to month-end. `postDueRecurringInvoices` raises each due occurrence
with `createInvoice` as an ordinary invoice: its own number, VAT, discount and
due date from the customer's terms. `invoices.recurring_invoice_id` +
`recurring_date` are unique together, so an occurrence is raised once however
often the post runs. Every occurrence's accounting and VAT periods are checked
before anything is raised; one that falls in a locked or filed period is
skipped, reported and raised as a review item, never moved to another date.
Templates are in base currency.

### Line discounts (issue #393)

An invoice line may carry a trade discount, as a percentage (basis points,
rounded half away from zero) or a fixed amount, never both and never more than
the line. It comes off the net before VAT: an unconditional discount given at
the time of supply reduces the consideration, so the line's `net_minor`, its VAT
and the VAT return all use the discounted figure. `undiscounted_net_minor`,
`discount_basis_points` and `discount_minor` keep what was discounted so the
invoice can show it. A prompt-payment (settlement) discount is not this: its VAT
depends on whether it is taken, and it is not modelled.

### Supplier terms (issue #410)

A supplier's payment terms (`suppliers.default_payment_terms_days`, audited
when changed) give a bill with no due date of its own one
(`due_date_source = 'supplier_terms'`); a stated or extracted due date always
wins. Supplier refunds use the same paths as customers': money we overpaid is
refunded with `refundOnAccount` on the payment we made (Dr bank / Cr
creditors), and a supplier credit note is settled by a payment received.

### Supplier statements (issue #413)

`supplierStatement` is our account with a supplier, built by the same
`accountHistory` as the customer statement (#405) from the other side: bills
and debit notes increase what we owe; credit notes, payments made and
shortfalls written off (#386) reduce it; refunds received and reversed payments
put it back. It closes at the supplier's share of creditors, and is produced as
PDF and CSV. (Counting a shortfall written off with a payment also corrected the
customer statement, which had left it out and so did not close at debtors.)

`reconcileSupplierStatement` checks the supplier's own statement against our
books as of its date: the difference in balance and, when their invoice numbers
are given (compared without case, spaces or punctuation), the invoices they show
that we do not hold — likely missing documents — and our open bills they do not
show. The check is audited; a difference becomes a review item, and nothing is
adjusted.

### Recurring bills (issue #412)

A recurring bill (`recurring_bills`) is rent, a subscription or a utility the
business expects on a schedule. It is never raised the way a recurring sales
invoice is: input VAT comes only from the supplier's confirmed invoice (#234),
so each occurrence (`expected_bills`, unique per template and date, with the
expected net snapshotted) is an expectation that posts nothing.
`runExpectedBills` expects what is due, then matches each open occurrence to a
bill of the same supplier and currency, posted from a confirmed document, dated
within the template's window and not answering another occurrence. It matches
only when exactly one bill fits: two candidates are flagged for a person. A bill
whose net differs from the expected by more than the tolerance is matched and
flagged; an occurrence with no bill once its window has passed is flagged as
missing. A person can match by hand, unmatch with a reason, or dismiss an
occurrence with a reason (a rent-free month); a matched bill that is later
voided reopens its occurrence.

### Purchase orders (issue #411)

A purchase order (`purchase_orders`, `purchase_order_lines`, numbered `PO-n`
per company) records what was asked of a supplier: a net amount per line, no
VAT. It posts nothing and claims nothing; input VAT still comes only from the
supplier's confirmed invoice. A posted bill of the same supplier and currency
is linked to the order it was raised against (`invoices.purchase_order_id`,
audited). What has been billed is the linked bills' net, a linked credit note
reducing it and a voided bill dropping out, so the status (open, part billed,
billed) is derived from the bills and cannot go stale. A bill that takes the
order over what was ordered is linked and flagged for review
(`purchase_order:<id>:overbilled`), never refused. Cancelling closes what
remains of an order and keeps the bills already linked; a fully billed order
has nothing left to cancel. The order prints as a PDF to send the supplier.

### Expense claims, mileage and subsistence (issue #306)

An expense claim (`expense_claims`, `expense_claim_lines`) is money a director
or a member of staff spent personally on the business's behalf: mileage,
subsistence, travel or a receipted cost. It is the no-invoice counterpart of the
director flows of §28 — a purchase with a supplier's invoice is confirmed,
posted as an invoice and settled (`settleInvoiceByDirector`), never claimed,
because the invoice is the only proof of input VAT (issue #234). A claim claims
no input VAT at all; the allowances carry none.

The rates are effective-dated configuration (`expense_rates`), seeded from the
civil service mileage and subsistence allowances Revenue accepts as the
tax-free ceiling (motor travel from Circular 16/2022, domestic subsistence
from Circular 04/2025, with their source URL on every row). A mileage rate is
fractional cents per kilometre, so it is stored as minor units per 100 km and
multiplied out with the same rational arithmetic the VAT engine uses. A line
dated before the rate's window resolves nothing and is refused; a later
revision supersedes rather than overwrites, and the line snapshots the rate it
resolved.

The lifecycle is submitted → approved → reimbursed, with rejected and reversed
as the exits. Approving is the accounting event: the journal is posted there
(each line's business share debited to its expense account and the business
total credited to the claimant — an officer on their own current account,
everyone else on Staff expenses payable, 2445; a private share is the
claimant's own cost and is neither posted nor owed), after every line's accounting period is
checked. A claim is never edited after submission: it is rejected with a reason,
or reversed, and a reversal is a reversing journal. Reimbursing pays the net
owed (the total less the private shares) out of the bank — from a matching,
unposted bank line where there is one, or a dated payment where there is not —
and a mileage, subsistence or travel reimbursement is flagged as reportable to
Revenue under the Enhanced Reporting Requirements until the submission is built
(epic #316).

A line's business-use share is a judgement, so it is flagged, never silent. The
same apportionment exists on the bank path: `classifyTransaction` takes a
`businessUseBasisPoints` and the account the private share is charged to (the
director's current account, or drawings), posts the business share as the cost
and the private share to the person, records both on the bank transaction and
raises a review item; `recordDirectorPaidExpense` records only the business
share — the private share of a director's personally-paid cost is not the
company's to record.

### Customer terms (issue #392)

A customer's payment terms give a sales invoice its due date when none is
stated (`due_date_source = 'customer_terms'`); a stated date always wins, and
terms of 0 days mean none recorded. A credit limit, in base currency, is a
credit-control signal: an invoice that takes the customer's outstanding balance
(each open invoice at its own rate, money on account not netted) over it is
posted, returns a warning and raises one review item. Contacts are people at
the customer; one with an email may be the billing contact. They are
deactivated, never deleted.

### Payroll (EPIC 20, issues #524–#527)

An employee (`employees`) carries what S.I. 345/2018 reg.17(2) and reg.10(1)
require: name, PPSN (validated by its check character), employer reference,
employment identifier, commencement and cessation, pay frequency, and the
director flags. The terms of the job (`employment_terms`), meaning the salary
or hourly rate and the pension arrangement, are effective-dated.

A **Revenue payroll notification** (`revenue_payroll_notifications`) carries
Revenue's figures for the employee and year: credits, SRCOP, the tax and USC
basis, the USC bands, and previous employments' pay and tax. It is immutable
and superseded from a date. See ADR 0014: employee figures come from the RPN;
statutory figures come from the rules.

A **pay run** (`pay_runs`) is one pay date for one frequency:

    draft ──post──▶ posted ──reverse──▶ reversed
      │ (recompute, set inputs)   └──pay net wages──▶ (net paid)

A draft's payslips are computed and recomputed freely. Posting re-computes
them and refuses if any reviewed figure changed. It also refuses a run dated
before an employee's latest posted run. It then posts one journal:

| Debit | Credit |
|---|---|
| 6180 wages (6160 for a director) | 2410 PAYE, 2420 USC |
| 6190 employer PRSI + NTF levy | 2430 PRSI (employee + employer + levy) |
| 6185 employer pension | 2450 pension (employee + employer) |
| | 2440 net wages |

A benefit in kind is notional pay. It is taxed and charged to USC and PRSI,
but never debited as wages or paid.

Each payslip (`payslips`, `payslip_lines`) stores:
- the lines, and the inputs they came from;
- the tax basis (cumulative, week 1, or the emergency bases of reg.19);
- this period's and the cumulative figures;
- the snapshot of rule figures and the working;
- findings on what the books cannot know.

A run is corrected only by reversal, latest first. Reversal is refused once
the net pay or the month's remittance has been paid.

The net pay leaves the bank against one run (`payNetWages`). The month's
PAYE, USC and PRSI go to Revenue in one payment (`payPayrollLiabilities`,
`payroll_remittances`). A bank line used for either must match to the cent.
`reconcilePayroll` compares each control account with the posted runs less
payroll payments, and each payslip's cumulative pay with the sum of its
predecessors. A difference becomes a review item; nothing is adjusted.

Not yet built:
- RPN retrieval and payroll submissions (#528);
- PRSI classes other than A and S, which are refused rather than approximated;
- how the weekly PRSI thresholds convert for monthly pay (#529);
- BIK valuation;
- pension relief limits;
- LPT deductions.

### Reportable benefits: Enhanced Reporting Requirements (EPIC 21, issues #532, #533)

A benefit provided without deducting tax is notified to Revenue on or before
it is provided (TCA s.897C; S.I. 345/2018 reg.10A, inserted by S.I. 1/2024).
It is one of three kinds:
- a **small benefit** (s.112B);
- the **remote working daily allowance**;
- a **travel and subsistence** payment, in the reg.2(1) subcategories plus the
  advance-payment subcategory from TDM 38-03-33.

`reportable_benefits` holds one immutable row for each. A correction
supersedes the row, and a submission (through ROS, until #528) is recorded
against the row that was submitted.

- A small benefit qualifies only as the first to fifth in the year, with the
  year's cumulative value within €1,500 (FA 2024 s.8, for 2025 to 2029). One
  that breaks either limit is refused, because it is taxable in full: it
  belongs on a payslip as a benefit in kind.
- A remote working allowance over €3.20 a day is refused. The excess is
  taxable pay.
- A reimbursed expense claim reports the business share of each travel and
  subsistence line, dated the day it was reimbursed:
  - mileage, and subsistence at a civil service rate, are unvouched;
  - receipted travel is vouched;
  - any other line is the person's to classify;
  - receipt lines are not reportable.

  The claimant must be linked to a payroll employee (`employees.officerId` or
  `employees.userId`), for the PPSN and employer reference.

`reconcileErr` reports and raises review items for four cases; it repairs
nothing:
- a reimbursed claim not prepared to the cent;
- a benefit not submitted by its date;
- a benefit submitted late;
- a year that breaks the small benefit limits.

### Fixed asset register (EPIC 22, issues #534, #466)

**Acquisition.** `registerFixedAsset` records a purchase the ledger already
holds: an invoice, or a bank line classified to a fixed-asset account.
- It posts nothing. The purchase's journal is the acquisition.
- It refuses more cost than the account holds unregistered at the purchase
  date, and any account that is not a fixed-asset cost account.

**Transfers.** `transferFixedAsset` moves an asset to another fixed-asset
account from a date.
- One journal moves its cost, and moves its accumulated depreciation when that
  account changes too.
- `fixed_asset_transfers` keeps the history, so the register can say which
  account held the asset on any date.

**Reconciliation.** `reconcileFixedAssets` compares:
- each cost account with the cost of the assets it held on the date;
- each accumulated depreciation account with the depreciation charged on the
  assets still held.

A difference becomes a review item; nothing is adjusted.

**Cars.** A car's CO2 emissions (g/km, from its registration certificate)
are the person's entry on the register. From July 2008 they decide its
capital allowances under TCA Part 11C:
- **Group 1:** the €24,000 specified amount, whatever the car cost.
- **Group 2:** the lesser of half that amount or half the cost.
- **Group 3:** nothing.
- **Balancing adjustments** are scaled in the same proportion.

The group boundaries depend on when the expenditure was incurred:

| Expenditure | Group 1 | Group 2 | Source |
|---|---|---|---|
| July 2008 to 2020 | up to 155g/km | up to 190g/km | TDM 11-00-01 |
| 2021 to 2026 | up to 140g/km | up to 155g/km | NfG Part 11C |
| From 2027 | up to 120g/km | up to 140g/km | NfG Part 11C (FA 2024 s.33) |

A car without emissions recorded keeps the Part 11 cost limit and is
flagged.

### Inventory (EPIC 23, issues #536–#538)

The ledger keeps stock **periodically**. A purchase of stock is posted to its
cost-of-sales account (5020 Goods for resale) all year. A closing stock
journal moves what is on hand to Stock on hand (1300) at a date. Behind it,
a **perpetual subledger** records every movement of every stock item. See
ADR 0015.

**Items and locations.** `items` holds each product or service. Only a
`stock` item is counted. Each stock item has:
- a unit;
- a costing method (FIFO or weighted average), fixed once it has moved;
- a cost-of-sales account (default 5020) and a stock account (default 1300).

`stock_locations` are the warehouses, shops and vans stock is held at.

**Movements.** `stock_movements` is write-once. A mistake is corrected by a
reversing movement (`reverseStockMovement`). Quantities are thousandths of
the unit, signed: in is positive, out is negative. Each kind is costed as
follows:

| Movement | Recorded by | Cost |
|---|---|---|
| Opening stock | `recordOpeningStock` | the unit cost given |
| Purchase | `receivePurchase`, from a posted purchase invoice line | the line's net in base currency; part deliveries share it exactly |
| Sale | `issueSale`, from a posted sales invoice line | the item's method |
| Customer return | `recordCustomerReturn`, naming the sale | the cost its sale left at |
| Supplier return | `recordSupplierReturn`, naming the receipt | the cost it came in at |
| Damaged, adjustment down | `recordDamagedStock`, `recordStockAdjustment` | the item's method, with a reason |
| Adjustment up | `recordStockAdjustment` | the unit cost given, with a reason |
| Transfer | `transferStock` | the cost moves with the goods |
| Stocktake | `postStocktake` | a count over book at the unit cost given; under book at the method |

**Costing by replay.** Nothing about an issue's cost is stored. `replayItem`
replays the item's movements in date order, then recording order
(`sequence`), through one cost pool per location:
- **FIFO:** issues consume the oldest layers.
- **Weighted average:** issues take the moving average, and the last unit out
  takes what is left exactly.

A back-dated movement re-costs everything after it. Every recording path
replays inside its transaction, so a movement is refused, and nothing is
written, if it would take a location below nil on its date or on any later
date.

**Valuation and closing stock.** `valueInventory` gives quantity and value
by item and location at a date, at cost. FRS 102 s.13 carries inventories at
the lower of cost and net realisable value. The NRV test is the person's:
every valuation carries that note (`NRV_NOTE`), and nothing is written down
automatically.

`postClosingStock` posts one journal. For each (stock account, cost-of-sales
account) pair, it moves the change in value since the last posted valuation,
or since the opening stock for the first one.
- Before posting, each stock account's ledger balance must equal what was
  last booked there. An entry posted to 1300 by some other route becomes a
  review item, and nothing is posted.
- `stock_valuations` records each posting and its lines.
- No movement or stocktake can be dated on or before a posted valuation.

### Farm (EPIC 24, issues #539–#541)

The farm module holds management records on top of the ledger. The ledger
stays the only source of money. The one path from the farm records into it is
a livestock valuation. See ADR 0016.

**Setup.**
- `farm_profiles` holds one profile per book. It links the farming trading
  activity, which carries the herd number (#326), and records the flock
  number.
- `land_parcels` records each parcel held for a period, owned or leased.
  - Area is whole square metres. `areaFigures` gives hectares and acres
    exactly (1 acre = 4046.8564224 m², as a rational).
  - Leased land records who it is leased from and the annual rent.
  - Periods of one parcel reference never overlap. Land leased and then bought
    is two periods.
- `farmedArea` gives the owned and leased area on a date.
- `farm_enterprises`: dairy, beef, sheep, tillage, horticulture, forestry or
  other.

**Allocations and gross margins.** `allocateJournalLine` gives an enterprise,
and optionally a crop planting with an input kind, a share in basis points of
a posted income or expense line.
- The line itself is untouched.
- A line's shares never exceed 100%.
- A reversing entry's lines take the shares of the lines they reverse.

`enterpriseGrossMargins` works out, for a period:
- **output:** allocated income, plus the change in livestock value posted for
  the enterprise's groups;
- **less** allocated cost of sales;
- allocated overheads, shown apart;
- unallocated income, cost of sales and overheads, reported rather than spread.

**Livestock.** `animal_groups` are counted and valued together, each with a
stock account (1330) and a change-in-value account (5040). `animals` are the
tagged animals.

`livestock_events` is a write-once register of openings, purchases, sales,
births, deaths (with their cause), transfers between groups, and reversals.
Every path replays the register in its transaction:
- a group never goes below nil on any date;
- a tagged animal is only sold, lost or moved from the group it is in.

`postLivestockValuation` values each group as head count × the value per head
the person gives, with its basis.
- The book computes no deemed-cost percentage.
- The opening valuation posts nothing, and must equal the opening balance on
  the stock account.
- Later valuations post one journal for each group's change since the last
  one.
- A stock account that does not hold what was last booked there is a review
  item, and nothing is posted.
- No event can be dated on or before a posted valuation.

**Crops.**
- `crop_plantings`: a crop on a parcel for a harvest year, on no more than the
  parcel's area.
- Inputs (seed, fertiliser, chemicals, contractor) and crop sales are
  allocations of posted lines. No crop cost exists outside the books.
- `crop_harvests` record the quantity harvested.
- `cropReport` gives each planting's inputs by kind, sales, margin, margin
  per hectare, and yield per hectare sown.
- Crops in store are valued as inventory (stock account 1340).

### Farm tax and grants (EPIC 25, issues #543–#546)

The figures come from rules curated from the Revenue Notes for Guidance on TCA
Part 23 and s.317 (FA 2025 edition), ingested like the rest of the NfG. Every
relief is a claim: the person records it as a decision, and the income tax or
corporation tax computation applies it and cites the rules.

**Grants (#543).** `grants` records each award:
- its scheme and payer;
- revenue or capital;
- the amount awarded;
- for a capital grant, the asset it funds.

Receipts are posted credit lines linked to a grant (`grant_receipts`), so
amounts are always the ledger's. `reconcileGrants` reports each grant's
amount received and outstanding. A credit to scheme income that no grant
claims becomes a review item. `capitalAllowances` computes each asset on its
cost less capital grants received (s.317(2); s.658(13)).

**Farm capital allowances (#545).** Two asset categories have their own
allowances:
- `farm_buildings`: 15% a year, and the 10% balance in year 7 (s.658).
- `slurry_storage`: 50% a year for expenditure in 2023 to 2029 (s.658A).
  Outside that window it is treated as a farm building, and flagged.

The rates come from the rules. The €500,000 cap on the tax value is flagged,
not measured.

**Stock relief (#544).**
- **The deduction:** the rate claimed × the increase in trading stock over the
  period. Trading stock is the stock accounts' balances, as closing stock and
  livestock valuations left them.
- **Limits:** it never exceeds the profit after capital allowances, so it
  creates no loss (s.666). It ends after 2027.
- **The claim** is a `farm_stock_relief` decision:
  - `general`: 25%;
  - `young_trained`: 100%, for four years at most (s.667B);
  - `registered_partnership`: 50%, only while the partnership is on the
    register (s.667C).
  - A company can claim only the general rate.
- **Caps** on the tax value (s.667B(5A), s.667C(3A)) are flagged: the book
  does not measure the tax saved.

**Income averaging (#544).**
- A `farm_income_averaging` decision (`averaging`, or a `step_out`) charges a
  sole trader one fifth of the stock-relieved profits of the year and the 4
  before it (s.657(5)), before capital allowances.
- Years before the book take the person's recorded figure (`farm_prior_profit`,
  with its source).
- A missing year stops averaging, with a finding.
- A second step-out within 5 years is refused (s.657(6A)).
- Partners elect on their own shares, so the firm's profit is not averaged.

**Partnerships and share farming (#546).**
- `farm_partnership_registrations` records a partnership on the register of
  farm partnerships or of succession farm partnerships.
- The succession tax credit (€5,000 a year, s.667D) is reported for the
  partners.
- `share_farming_arrangements` records each arrangement's party, land and
  shares. It posts nothing.
- `farmTaxSummary` reads the year's figures back from the computations.

### Construction and relevant contracts tax (EPIC 26, issues #548, #549)

The Notes for Guidance on ss.530–530V are ingested, and the RCT duties are
curated from them (`rct.*` rules in `corporationTaxCuration.ts`). Revenue
decides every figure; these books record each one as issued.

- **Projects and sites.** A project is the unit EPIC 27 costs. A site is
  where the work is. Eircodes are validated.
- **Subcontractors** are suppliers with the identity evidence the principal
  saw (s.530B(1A)) and the declaration that they are not employees
  (s.530B(1)(b)). No rate is stored on the subcontractor.
- **Relevant contracts:** only a confirmed principal (s.530A, #208) records
  one. It names its site and records its notification: the date, and the
  contract ID Revenue gave it (s.530B).
- **A payment** goes through four steps:
  1. The payment notification (s.530C), for the gross against the
     subcontractor's invoice.
  2. Revenue's deduction authorisation (s.530D): its number, the rate (0%,
     20% or 35%, s.530E) and the tax, as issued. A sum that is not the rate
     on the gross is recorded, and flagged.
  3. `payRctPayment`: the net leaves the bank, and the same payment settles
     the invoice for the gross. The tax is an `rct_deduction` allocation
     (Dr creditors, Cr RCT payable 2460).
  4. A reversed payment drops out of its period, with its tax.
- **The return** (s.530K): Revenue's deduction summary is recorded against
  the books. A difference that is not an amendment becomes a review item.
  Paying the return (s.530L) posts Dr RCT payable, Cr bank, to the cent.
- **`reconcileRct`** checks the RCT payable account against the tax deducted
  less the returns paid. It also flags each payment to a registered
  subcontractor made outside the RCT path, with its s.530F(2) penalty
  exposure (35%, 20%, 10% or 3%, by the last determination). Nothing is
  posted as though it had been authorised.

The RCT TDMs are now stored as exact slices of their committed files, with
real offsets, and a file that is not the TDM is refused on the TDM path
(#199).

### Projects and job costing (EPIC 27, issues #550, #551)

Analysis beside the ledger, on the pattern of ADR 0016. Nothing here posts.
Farm enterprises and projects share `postedPnlLines`
(`src/domain/accounting/postedPnl.ts`), so a reversing entry takes the
allocation of the line it reverses in both.

- **Jobs** belong to a project (the projects table is EPIC 26's).
- **Allocations.** A posted income or expense line is allocated to a
  project, and optionally a job, in basis points, by category:
  - `income` (income lines only);
  - `labour`, `materials`, `contractors`, `other_direct` or `overheads`
    (expense lines only).

  A line's allocations never exceed 100%, and removing one is audited.
- **Budgets** are per project and category, effective-dated. A revision is a
  new row. `budgetOn` gives the latest row on or before a date.
- **Overhead absorption:** the person's rate per project, as a percentage of
  direct costs, effective-dated, with the basis they give.
  - Each direct cost absorbs at the rate in force on its own date.
  - Where a rate is set, the margin deducts the absorbed overheads instead
    of the overheads allocated. Both are shown.
- **`projectResult` / `projectProfitability`:**
  - income, direct costs, gross margin, overheads charged, net margin and
    margin %, per project and job, against the budget;
  - projects ranked by net margin;
  - the income and costs no project carries, reported rather than spread.
- **`workInProgress`:** for each active project, direct costs to date less the
  cost its billings cover at the budgeted cost ratio (budget direct costs ÷
  budget income).
  - A project without an income budget is flagged, not valued.
  - Billing ahead of cost is reported as billings on account, not negative
    WIP.
  - Posting WIP and recognising revenue on contracts (FRS 102 s.23) is open
    question #552.

### Consolidation (bank ↔ invoice)

```
confirmed document ──postDocumentAsInvoice──▶ invoice (one line per printed line,
                                               stated net and VAT, VAT entry per line)
bank line ──settleBankTransaction──▶ payment ──allocations──▶ invoices / credit notes
```

The invoice proves the supply and its VAT; the bank line proves payment. Input
VAT is dated by the invoice (tax point = supply date, else invoice date) under
both bases; on the cash receipts basis a sales invoice's output VAT is released
by the payment, dated at receipt. One payment may settle several invoices, an
invoice may be settled in parts, and a credit note allocated in the payment's
own direction reduces the cash. A remainder is held on account and flagged.

A payment records whose money it is (issue #386): the one customer or supplier
its invoices belong to, else none. What it holds on account is applied to a
later invoice of that party with `allocatePaymentOnAccount`. That posts no
journal, because both balances already sit on the same control account. It
records an `on_account` allocation, updates the invoice and is audited. It works
in base currency only, and it is refused for a cash-basis sales invoice with
VAT until the VAT date is decided (#389).

A short payment can close its invoice by writing off the shortfall
(`writeOff` on `settleBankTransaction`), for example bank charges the payer's
bank deducted. The shortfall goes to an income or expense account in the same
journal and is recorded as a `write_off` allocation. The VAT is left as
invoiced and the write-off is flagged: a price reduction needs a credit note. It
works in base currency only, with the payment fully applied, and it is refused
on the cash receipts basis for a sales invoice with VAT (#389). Reversing the
payment undoes every allocation it made, including these.

Across currencies a settlement takes one rate (issue #223): when the bank line
is foreign, it converts the line to base currency (the statement's own rate is
used unless the person enters one); when the line is in base currency and an
invoice is foreign, it converts the payment into the invoice's currency. Three
currencies at once, or invoices in two foreign currencies from one line, are
refused. `previewSettlement` computes exactly what settling would post — the
exchange difference and any remainder — by running the same code in a
transaction that is always rolled back; the settle screen shows it before
anything is written.

`classifyTransaction` remains for bank lines with no invoice. On a purchase it
claims no input VAT under any VAT-charging treatment (no VAT entry is created)
and raises a `missing_document` review item. It refuses a bank line matched to
a confirmed document, which must be posted and settled instead.

The same holds off the bank (issue #221). A director who paid a supplier
personally settles the posted invoice from their current account
(`settleInvoiceByDirector`, `payments.method = 'director_personal'`); with no
invoice, `recordDirectorPaidExpense` posts the whole amount as cost, writes no
VAT entry (nor any reverse charge) and flags `missing_document`. A split journal
for a bank line (`postBankTransactionJournal`) may record the line's own output
VAT, never input VAT: a `purchases` VAT position, or a line debiting VAT on
purchases, is refused.

Trace: `vat_entries.invoice_line_id` → `invoice_lines.document_line_id` and
`invoice_lines.vat_rule_keys` → `document_lines` → `documents`
(`transactionTrace`).

### The rate charged on an invoice line is checked, never corrected

Each confirmed invoice line's printed rate is compared with the rate the
statutory rules give for what was supplied (`checkLineRate`, issue #205):

- `consistent`: a specific rule matched and gives the rate charged;
- `inconsistent`: a specific rule gives a different rate;
- `undetermined`: only the standard-rate fallback matched, no rule decides
  it, or the line prints no rate.

The last two are flagged on the posting screen with every candidate rate and
the provision behind it, and become an `uncertain_vat_treatment` review item
when the document is posted. The invoice is always posted as printed. The
livestock rate (4.8%, s.46(1)(d)) has its own treatment, `IE_LIVESTOCK`.
`ensureDefaultVatTreatments` adds a seeded treatment to a company created
before it existed; loading the statutory rules calls it.

A Schedule 2 or 3 rule quotes the paragraph as it now reads, so it is only
good from the date that text last changed. Its `effectiveFrom` is the latest
date among the Law Reform Commission footnotes inside the paragraph
(`scheduleParagraphWindows`, read from the LRC HTML kept beside each
schedule's Markdown with a matching SHA-256), or VATCA's commencement when it
has none. A line dated before that window is `undetermined`, not checked
against a text that did not yet apply. Re-deriving with a different window
retires the old rule (`effectiveTo`, inactive) and inserts the new one. A
document dated before any configured rate is flagged, not refused.

Every Schedule 2 and 3 paragraph has a rule, or a justified `not_applicable`
row in the coverage matrix. A Schedule 2 rule is zero-rated. A Schedule 3 rule
states no rate: it names the sub-paragraphs it covers, and the rate comes from
s.46 on the line's date (`scheduleThreeRate`):

- 9% where a dated clause lists the paragraph:
  - (ca) from 2025;
  - (caa) electricity and gas, 2022–2030;
  - (cab) and (cac) apartments;
  - (cb) hospitality, 2020–2023;
  - Finance Act 2025 s.71: catering, hot food and hairdressing from 1 July 2026.
- 13.5% otherwise from 2025.
- No rate before 2025, and the line is flagged. What (ca) listed before
  2025 is not in the repository.

When a line matches more than one paragraph, the order in
`SCHEDULE_RULE_PRECEDENCE` decides. A paragraph that excludes another's items
comes after it; for example, solar panels come before dwelling work.

The s.46 rates are families of dated versions, each window taken from the
statute text or the LRC's amendment footnotes. Each version is linked to the
one before it by `supersedesRuleId`. The families are:

- the standard rate: 23%, then 21%, then 23%;
- hospitality and hairdressing: 9%, 13.5%, then 9% from July 2026 under
  Finance Act 2025 s.71.

A period the sources cannot settle has no version, so a line dated in it is
flagged.

Every Schedule 1 paragraph an invoice line can show has an exemption rule.
Paragraphs 13 and 15 are exemptions at importation, justified
`not_applicable`. A Schedule 1 rule is dated from the latest LRC amendment to
the words it quotes (`quotedTextWindow`), not its whole paragraph. Paragraph 6
was last amended in December 2025, but its bank-account words not since 2010.

Loan and overdraft interest match a rule that suggests no treatment and is
flagged. Schedule 1 para 6(1)(a)'s credit words were deleted in 2023, and
where they went is not in the repository.

A line that may be ancillary (delivery, packaging, handling; the s.47 rule
matched) is compared with the other lines of the same invoice
(`applyCompositeSupply`). If those lines bear one printed rate, their
treatment is offered for the line under s.47(1)(a), and the line is flagged:
the rate is right only if the invoice is one composite supply. If they bear
different rates, the line is flagged as undecidable from the invoice. Nothing
is preselected: whether a supply is ancillary is a judgement.

A bank line's statutory suggestion reads the matched confirmed invoice's own
lines and VAT wording when there is one, never the bank narrative. A draft
invoice is not evidence. Without a confirmed invoice the suggestion rests on
the bank description alone and says so; bank-only lines (wages, tax,
transfers) keep their bank-level rules but are always flagged for
confirmation.

### Establishment and customer status are recorded, never inferred

Where a supplier or customer is established (EU Reg 282/2011 arts.10-11)
decides whether a reverse charge applies (s.12) and where a service is
supplied (s.34(a)). A country code does not settle it. A person records it on
the supplier or customer, with what it rests on and their name
(`confirmEstablishment`). Until then the rules that need it are unresolved,
and the line is flagged. A customer's taxable status is recorded the same way.

A VAT number can be checked with VIES (`checkVatNumberWithVies`). The answer
is stored as evidence, with the number checked and VIES's consultation number:

- **Valid:** strengthens the number as evidence of a business customer.
- **Invalid:** removes it as evidence.
- **Unavailable** (service error, offline): stored as such, never as valid.

### Cross-border supplies

The cross-border rules (`crossBorderCuration.ts`) read two derived facts:
whether the counterparty is confirmed as established outside the State, and
whether its country is an EU Member State. Only one of them decides a
treatment; the others flag the line and say why.

- **Intra-Community acquisition (s.9):** goods from a supplier confirmed as
  established in another Member State get `EU_GOODS_ACQ`.
- **Importation (s.3):** the customs import entry decides, not the invoice.
  "IEPOSTPONED" (code 1A05) means `IMPORT_PA`, and tax type B00 means
  `IMPORT_VAT_PAID`. Without an entry, both treatments are offered and neither
  is chosen.
- **Place-of-supply exceptions (s.34(c), (d), (g), (i), (k), (kc)):**
  property, passenger transport, events, catering, short-term hire, and
  e-services to consumers. These outrank s.34(a) and s.12. The line is
  flagged, because where the thing happened is not on every line.
- **Also flagged:** distance sales (s.30), s.10 installed goods and energy, and
  s.35 hire.
- **Exports:** a zero-rated export always carries a reason asking for proof that
  the goods left the EU. The customer's country is not that proof.

A confirmed invoice is checked against itself and the parties' records
(`invoiceConflicts`). Each conflict is shown on the posting screen and in the
CLI, and is raised as a review item when the invoice is posted. While any
conflict is open, no line's treatment is pre-selected. The conflicts are:

- VAT charged under another Member State's VAT number, or by a supplier
  confirmed abroad without an Irish number. That is not Irish input VAT.
- A reverse-charge legend with VAT charged.
- A reverse charge from another Member State that does not show your VAT
  number.
- An invoice addressed to someone else's VAT number.
- An EU supplier that charges no VAT and gives no reason.
- A zero-VAT sale to another Member State that lacks the customer's VAT number
  or the reverse-charge/intra-Community wording (SI 639/2010 reg 20(2)(e), (f)),
  or whose customer number VIES reported invalid.

A reverse charge offered from invoice wording alone is never pre-selected while
the supplier's establishment is unconfirmed.

### Domestic reverse charges and the cash basis are the company's own facts

Two facts that VAT turns on are recorded on the company profile by a person.
Each has a date and what it rests on, and each change is audited. No
transaction decides either of them.

**RCT principal status (TCA 1997 s.530A).**
- A recorded principal gets `RC_CONSTRUCTION` on construction services it
  receives from the recorded date (VATCA s.16(3)).
- While the status is unrecorded, a construction purchase is flagged, and the
  invoice line is not pre-selected.
- The other s.16 reverse charges are flagged with why: scrap metal, a connected
  builder, gas or electricity for resale, energy certificates and emission
  allowances. Scrap metal is offered `RC_CONSTRUCTION`, which has the same VAT3
  effect.
- Construction work sold is flagged, because the customer may be a principal.

**Cash receipts basis (s.80).**
- `vatAccountingBasis` sets the basis. Only the profile decides it, never a bank
  narrative.
- Revenue's authorisation is recorded with its date, its reference and the
  s.80(1) test relied on.
- Validating a VAT period warns when:
  - no authorisation is recorded, or it starts after the period does;
  - sales in the 12 months to the period end exceed €2,000,000 (on the turnover
    test);
  - more than 10% of those sales went to customers with a VAT number (on the
    90% test).

### Property

- **Rent paid without VAT** is the exempt letting (Sch.1 para 11).
- **Rent invoiced with VAT** means the landlord opted to tax the letting: the
  invoice is its notification (VATCA s.97(1)(c)(ii)). It is suggested at the
  standard rate.
- **VAT on a residential letting** is flagged, because the option cannot apply
  there (s.97(4)).
- **Rent received** is flagged as exempt, unless the company opted to tax it.
- **A sale or purchase of property** is flagged with the questions that decide
  it:
  - completion and development in the last 5 years;
  - occupation after a taxable sale;
  - a joint option for taxation;
  - the pre-July-2008 transitional rules (ss.93, 95, 96).
- **Under a joint option**, the purchaser accounts for the VAT (s.94(6)).
  `RC_CONSTRUCTION` is offered because it has the same VAT3 effect, but it is
  not chosen.

**The capital goods scheme (ss.63-64)** is a record, not a rule, and lives in
`src/domain/vat/capitalGoods.ts`.

- **Registering a good.** A person registers each property acquired, developed
  or refurbished from the purchase invoices its VAT is on. The total tax
  incurred is the sum of those invoices; it is never typed.
- **Recording use.** At the end of each interval the person records the
  proportion of deductible use. The adjustment is then calculated
  (`capitalGoodsMath.ts`):
  - s.64(2), A - B, at the end of the initial interval;
  - s.64(3), C - D, for later intervals;
  - s.64(4), (C - D) x N, for a swing of more than 50 points, which also
    resets the baseline;
  - s.64(6), E x N / T or B x N / T, on a supply of the good.
- **Posting.** The adjustment is posted in the taxable period after the interval
  (T1 if payable, T2 if deductible) as a VAT adjustment. The account for the
  other side is named by a person.
- **Write-once.** Records are written once and in order. The adjustment period
  ends on a supply.
- **Period validation** warns when an interval has ended without its use
  recorded, and when an adjustment belonging to the period is not posted.
- **Tests.** The arithmetic is tested against Revenue's worked examples in the
  Tax and Duty Manual.

Rules that turn on an unrecorded fact are advisory (`advisoryRules.ts`). They
add a reason and stop pre-selection, but never decide the treatment.

### Special schemes, from the buyer's side

- **Margin or auction scheme purchases** (ss.87-89): these invoices never show
  VAT separately, so there is none to deduct. The line is flagged and
  `OUT_OF_SCOPE` is offered, but not chosen. An invoice with margin-scheme
  wording that also shows VAT is flagged as a conflict.
- **Flat-rate farmers** (s.86): the flat-rate addition shown on the farmer's
  invoice is 4.5% of the consideration from 1 January 2026. It is flagged,
  because no treatment models it yet.
- **Vouchers** (s.43(2)): the price paid for a voucher is disregarded. Buying or
  selling one is `OUT_OF_SCOPE` until it is redeemed, unless it is bought for
  resale (s.43(3)).

The company operating one of these schemes itself, as a dealer, travel agent or
auctioneer, is not modelled.

### Input VAT recovery (ss.59-62)

- **Sources.** The rules come from the revised ss.59-62. The as-enacted s.59
  and s.60 rules are retired: their stored rows get an empty window.
- **Blocked categories.** s.60(2)(a) is applied exactly as listed, one rule per
  category, and each decides `NON_DEDUCTIBLE`:
  - (i) food, drink, accommodation and personal services;
  - (iii) entertainment;
  - (iv) cars;
  - (v) petrol.

  Diesel is not in the list and is not blocked. A van is not a "motor vehicle"
  here.
- **Qualifying vehicles.** A qualifying vehicle gives 20% of the VAT
  (s.59(2)(d)): first registered from 2021 with CO2 under 140g/km, and at least
  60% business use. This is named on every car line, because the invoice does
  not show it.
- **Clawback.** On disposal within two years, or if business use falls below
  60%, `qualifyingVehicleClawback` computes TD x (4 - N) / 4 (s.62).

### The invoice is checked before its VAT is deducted

Input VAT is deducted only on an invoice that carries the prescribed
particulars (VATCA s.59(2)(a); S.I. 639/2010 reg.20(2), under s.66(1)).
Posting a confirmed purchase document checks them with
`missingInvoiceParticulars`. The particulars are:

- the date and the invoice number;
- the supplier's name, address and Irish VAT number;
- your name and address;
- what was supplied;
- the rate and the net at each rate;
- the VAT.

A receipt is not a VAT invoice.

If a particular is missing, posting is refused with the list. The person
either reopens the document to add it from the page, or posts with the VAT
held back. Held-back VAT is costed, not recovered, and a review item says what
is missing.

Without VAT there is nothing to check. A reverse charge needs no Irish VAT
number, rate or tax on the invoice. The missing particulars also show on the
posting screen and in `line-choices`.

### Dual-use inputs (s.61)

Some companies make both deductible supplies (taxable, zero-rated or abroad)
and exempt ones. For them, VAT on costs used for both is deductible only in
proportion, by default the turnover basis (s.61(4)):

- deductible turnover over total turnover, VAT-exclusive, for the accounting
  year;
- computed from the posted sales;
- outside-the-scope amounts are in neither figure.

Period validation flags the proportion whenever both kinds of supply occur. In
the last period of the accounting year it also asks for the review-period
adjustment (S.I. 639/2010 reg.17(3)).

Which costs are dual-use, and whether another basis reflects use better
(s.61(5)), is the person's judgement.

### Credit notes and the time limit for invoices

A credit note is posted in its own period and reduces the deduction by the tax
it shows (s.67(1)(b)(ii)). Posting links it to the invoice it names
(`creditNoteOfId`). The invoice number is matched ignoring spaces and
punctuation.

Each of these raises a review item; neither document is changed:

- no original is found;
- the credit is more than is left on the original after earlier credit notes;
- it credits a rate the original did not charge (s.67(3));
- it shows no VAT against a VAT-bearing original, which means either s.67(5)
  (tax left unaltered by agreement) or s.69(1)(b) (too little VAT stated).

A sales invoice dated more than 15 days after the end of the month of supply
is an invoice conflict (s.70(1), S.I. 639/2010 reg.23).

### Posting paths are atomic

Every exported posting path — classify, reclassify, split journal,
director-paid expense, create and void invoice, record and reverse payment,
post a document, settle, adjustments, depreciation and disposal — runs as one
database transaction (`atomically`; nested paths become savepoints). A step
refused after an earlier step posted rolls the earlier one back (issue #231).

Reclassifying checks the accounting period of both posting dates before
writing: the reversal date, and the transaction's own date, where the new
classification posts. If the transaction's own period is locked or closed the
reclassification is refused with nothing changed — the person unlocks the
period, or leaves the line and posts a dated adjustment in an open period. The
new classification is never moved to another period.

### The business behind the books

The names a business trades under, the activities it trades in, the
registrations it holds besides VAT and corporation tax, and its cross-border
identifiers are all facts a person records — dated, named and audited, never
inferred (issue #297).

```
Company ─┬── CompanyTradingName        from a date, until a date; never deleted
         ├── CompanyTradingActivity   sector (farming, retail, …) + herd number
         ├── CompanyRegistration     income tax, PAYE, RCT, other — from a date
         └── (on Company)             EU VAT identification number, EORI, closure, archive
```

`companies.tradingName` stays as the current name, written in the same
transaction as the row that set it, so screens read one value while the
history of names stays complete.

Two lifecycle ends:

- **Closure.** Recording the date the trade ceased does not close anything.
  Where the date exposes a problem — the VAT registration still open, posted
  entries dated after it — a review item is raised for a person, never
  decided. The VAT deregistration date is recorded only when the person
  supplies it.
- **Archive.** An archived business leaves the working set (it is not the
  active company) with nothing deleted and nothing changed; bringing it back
  is one recorded action. It is storage, not destruction.

The **compliance profile** is one read of all of this: every registration
recorded, and the gaps named (a sole trader with no income tax registration, a
company registered for VAT with no number, a farm with no herd number). It
assembles recorded facts; it does not fill anything in.

### VAT period lock

A VAT entry is never written into a VAT period whose status is `locked` or
`submitted` (`assertVatPeriodWritable`), and never detached from one.
Corrections are negative entries in an open period. A late document or a
correction may be declared in a later open period only when the person names
it (`declarationDate`); the tax point is unchanged and a `period_validation`
review item is raised.

### Bank transaction

```
imported (immutable) → fingerprinted → deduplicated
        → classification suggested (rule, then AI, then unclassified)
        → matched to document/invoice
        → journal posted → reconciled
```

Status: `unclassified | suggested | classified | matched | posted | reconciled |
ignored | duplicate | rolled_back`.

Each bank account posts to a ledger account of its own (issues #376, #377):
the seeded 1000 / 1010 / 1020 for the first bank, cash and deposit account,
then a new account per bank account; a credit card is a current liability and
a loan the loan's own liability account. Reconciliation compares one statement
with one ledger account's movements, and names it when an older book has two
bank accounts on the same ledger account rather than moving posted lines. An
account with no statement (petty cash) records its lines by hand
(`recordManualTransaction`): the same evidence path, `manually_entered`, traced
to a `manual` import under the person's name.

Statements arrive as CSV or XLSX (mapped by column), or as OFX or CAMT.053
(issue #378), which are read as the bank wrote them: the bank's own transaction
id is kept for the fingerprint, only booked CAMT entries are imported, and the
statement's opening and closing balances are kept on the import. Reconciliation
uses that closing balance when the statement is struck on the reconciliation
date (`statement_closing_balance`).

The bank reconciliation statement (`reconciliationStatement`, issue #387) is
what gets filed for an account and period. It starts from the statement
balance, subtracts the lines not yet in the books, adds the book movements not
on the statement, and ends at the ledger balance and whatever difference
nothing explains. Possible duplicates, warnings and the sign-off follow. It only
arranges `reconcileBankAccount`'s figures. It exports as CSV or XLSX, values
only (`/api/export/reconciliation`, `reconcile --csv`).

An import that went wrong is undone with `rollbackStatementImport` (issue
#379), and only while nothing in the books rests on its lines — no line
classified, matched, posted, reconciled, paid against or linked to a document.
The import becomes `reversed` and its lines `rolled_back`: they stay as
evidence of what was imported and taken back out, and are left out of
classification, matching, reconciliation and the period checks. Their
occurrence numbers stay held, so the corrected file imports cleanly and a
second import of it still finds its lines present.

### Match

```
candidate scored → matched | probable | possible | no_match | conflict
        → user accepts / rejects / defers
```

A match is never applied silently below the configured auto-accept threshold
(§16). Scores and the reasons behind them are stored, not just the outcome.

A rejection sticks (issue #384): once a person rejects a pairing, re-running
matching does not propose it again, and the outcome lists it under
`excludedByRejection` so the reason a candidate is missing is visible. The
rejection is withdrawn only deliberately (`withdrawMatchRejection`, with a
reason, audited); the row becomes `superseded` and the pairing can be scored
again.

A statement line whose movement is already in the ledger — the far side of a
transfer classified from another own account, or a journal entered by hand —
is linked to that journal rather than posted twice (issue #385).
`suggestJournalMatches` lists posted, unreversed journals that move exactly the
line's base amount on its bank account's ledger within a date window and that
no line on the account already evidences; `linkBankTransactionToJournal` marks
the line `posted` against it, posting nothing new. It is refused for a rolled
back or already-posted line, a reversed journal, an amount that differs, or a
journal another line already evidences.

### VAT period

```
open → review → ready → locked → submitted
```

`ready` is gated on a validation run (§24). The system reports **"Internal
checks passed"** or **"NOT READY"** with the specific blocking exceptions. It
never reports compliance (§48).

---

## 10. Provenance

Every derived or classified value carries the pair `(source, status)`:

```
source ∈ ai | rule | user | import | system | derived
status ∈ ai_suggestion | user_confirmed | user_rejected | system_rule |
         imported | manually_entered
```

plus `confidence` (0–100) where the source is `ai` or `rule`.

Precedence when they disagree, highest first:

1. `user_confirmed` — a human decision is never overridden by anything
2. `system_rule` — a deterministic rule the user created
3. `imported` — a value that came in on evidence
4. `ai_suggestion` — never applied without confirmation above threshold

AI may **propose**. It may never mutate a value whose status is
`user_confirmed` (§19). This is enforced in the write path, not by convention.

---

## 11. Audit

```
AuditEvent
  id, occurred_at, entity_type, entity_id, action,
  field, previous_value, new_value,
  source, actor, reason, request_id
```

Audit rows are append-only and written inside the same database transaction as
the change they describe, so an audited change cannot half-happen.

Actions: `created | updated | deleted | voided | classified | vat_changed |
document_matched | document_unmatched | period_locked | period_unlocked |
adjustment_posted | user_confirmed | ai_suggested | rule_applied |
import_completed | reversal_posted`.

---

## 12. Explainability

Every reported figure is produced by a function that returns both the number
and its derivation:

```
Explained<T> = {
  value: T
  currency: string
  components: Array<{ label, value, link }>
  sources: Array<{ entity_type, entity_id, amount }>
  method: string          -- human-readable description of the calculation
  as_of: string
}
```

Report figures are not computed in the UI. The UI renders an `Explained<T>`,
and the "Why this number?" affordance (§43) is the same object rendered
expanded. This makes §53 structural rather than a feature that has to be
remembered for each new report.

---

## 13. Deliberately excluded from the MVP

Per §47, no code for: open banking, bank feeds, Revenue/ROS integration, Stripe,
multi-company, multi-user, cloud hosting, accountant portal, automated
filing.

The extension points that keep these possible:

- `company_id` is present on every scoped table from day one, so multi-company
  is a query change rather than a migration.
- Bank import goes through a `StatementSource` interface; a feed connector is a
  new implementation, not a new pipeline.
- Extraction and AI go through provider interfaces with a deterministic default.
- `created_by` exists on mutating tables so multi-user is additive.

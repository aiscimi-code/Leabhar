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

An account referenced by a posted journal line can be **deactivated** but never
deleted (§10). Deactivation prevents new postings; it does not disturb history.

System accounts that the engine posts to by name, and therefore must always
exist: bank control, VAT on sales, VAT on purchases, VAT control, debtors,
creditors, director's current account, share capital, retained earnings,
suspense, FX gain/loss, rounding difference.

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
ignored | duplicate`.

### Match

```
candidate scored → matched | probable | possible | no_match | conflict
        → user accepts / rejects / defers
```

A match is never applied silently below the configured auto-accept threshold
(§16). Scores and the reasons behind them are stored, not just the outcome.

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
payroll, multi-company, multi-user, cloud hosting, accountant portal, automated
filing.

The extension points that keep these possible:

- `company_id` is present on every scoped table from day one, so multi-company
  is a query change rather than a migration.
- Bank import goes through a `StatementSource` interface; a feed connector is a
  new implementation, not a new pipeline.
- Extraction and AI go through provider interfaces with a deterministic default.
- `created_by` exists on mutating tables so multi-user is additive.

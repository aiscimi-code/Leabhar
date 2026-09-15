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
        → type identified → text extracted → fields extracted
        → classified (suggested) → matched (suggested)
        → user confirmed → linked to invoice/transaction
```

Status: `pending | extracting | extracted | needs_review | classified |
matched | confirmed | failed | duplicate`.

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

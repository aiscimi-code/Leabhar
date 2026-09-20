# Leabhar — Current Trust & Verification Architecture

> Work Package 01: Architecture & Gap Audit
>
> This document records what Leabhar already provides *before* any trust-and-verification
> changes are introduced. It is a snapshot of the existing codebase as of the `main`
> branch at the start of the Trust & Verification Programme. Do not quote specific
> commit hashes or dates here unless they are structural invariants.

## What already exists

### Accounting engine

**`src/domain/accounting/journal.ts`** — the single posting function. All accounting
entries enter the system through `postJournalEntry(db, input)`. There is no other
write path for journal lines. The function enforces, in one place, inside a single
SQLite transaction:

- At least two lines per entry.
- Exactly one of debit/credit per line (not both, not neither).
- No negative amounts.
- **Debits == credits in base currency** — `UnbalancedJournalError` is thrown on mismatch.
- Active accounting period resolves from the entry date; locked/closed periods
  refuse posts (`PeriodLockedError`) unless `overrideLock` is supplied with a reason.
- Every post writes an `audit_events` row (action `created`) with the totals and
  line count; period unlocks are also audited.

`reverseJournalEntry` is the only correction path. It creates a new entry with
swapped debit/credit and sets `reversalOfId` / `reversedByEntryId` on the original.
Posted entries are never edited or deleted — invariant #2 in `AGENTS.md`.

**`src/domain/accounting/ledger.ts`** — read-side aggregation. `trialBalance`
produces per-account debit/credit totals. `postedBalanceForAccount` computes a
running balance. Ledger is always derived from journal lines at read time, not
stored as a separate mutable figure.

### Transaction model

**Bank transactions** (`src/db/schema/banking.ts`):

- `bank_transactions` rows are write-once evidence (invariant #4). The imported
  date, amount, description, reference and fingerprint are never mutated after
  insert. Classification, matching and reconciliation live in adjacent columns
  (`account_id`, `vat_treatment_id`, `supplier_id`, `journal_entry_id`,
  `status`, `reconciliation_id`).
- `statement_imports` records the import run (filename, file hash, row counts,
  status). Each bank transaction traces back to its import via `statement_import_id`.
- Deterministic fingerprint over (account, date, amount, currency, reference,
  description) + occurrence index — importing the same statement twice adds
  nothing, but two genuinely identical same-day charges both survive.
- Status enum: `unclassified`, `suggested`, `classified`, `matched`, `posted`,
  `reconciled`, `ignored`, `duplicate`.

**Invoices/documents** (`src/db/schema/documents.ts`, `src/domain/invoices.ts`):

- `documents` table holds source files (PDF, etc.) with a SHA-256 hash recorded at
  ingest. Documents are never modified — invariant #5.
- Extraction (`src/domain/extraction/`) reads documents; the SHA-256 is re-checkable.
- `extracted_fields` stores field-name → { value, confidence, evidence } per
  document, preserving the provenance of each extracted value.

### Journal model

**`journal_entries`** (`src/db/schema/accounting.ts`):

- Sequential gapless `entry_number` per company (auditors expect this).
- `entry_date`, `accounting_period_id`, `narrative`, `source_type`, `source_id`.
- `source_type` enum: `bank_transaction`, `sales_invoice`, `purchase_invoice`,
  `payment`, `manual_adjustment`, `opening_balance`, `fixed_asset`,
  `depreciation`, `fx_revaluation`, `vat_period_close`, `year_end_close`,
  `reversal`.
- `created_via` enum: `user`, `rule`, `import`, `system`, `ai`.
- `confidence` and `provenance_status` (ai_suggestion / user_confirmed /
  system_rule / imported / manually_entered) on every journal entry and line.
- `reversal_of_id` / `reversed_by_entry_id` / `reversal_reason` for correction
  tracing.

**`journal_lines`**:

- `journal_entry_id` FK, gapless `line_number`.
- `account_id`, `debit_minor`, `credit_minor` (exactly one nonzero).
- `currency`, `base_debit_minor`, `base_credit_minor`, `base_currency` — always
  stores the rate used as a rational pair (numerator/denominator) so conversion is
  reproducible.
- `supplier_id`, `customer_id`, `officer_id` — optional FK on the line, so a
  journal line can point at the counterparty behind it.
- `provenance` (source, confidence, provenance_status) on every line.

**VAT entries** (`vat_entries`):

- Separate rows, not columns — a reverse-charge transaction produces two entries
  (output T1 + input T2), each with `paired_entry_id` pointing at the other.
- `vat_treatment_id`, snapshotted `rate_basis_points`, snapshotted `vat_box`.
- `tax_point_date` + `vat_period_id` — the date that decides VAT period.
- `recoverable_vat_minor` — what can actually be reclaimed, after restrictions.

### VAT logic

**`src/domain/vat/engine.ts`** — pure functions, no LLM:

- `calculateVat(input)` — never loses a cent: `net + vat == gross` always, with
  integer minor-unit arithmetic. State rate, rate basis points, net/gross/
  stated-VAT, and `recoverableOverrideMinor`.
- `vatDiscrepancy(net, stated, rate)` — reports a disagreement rather than
  overwriting either figure. Returns `{ expected, stated, difference }` or null.
- `determineTaxPoint(...)` — invoice-basis vs cash-receipts-basis; refuses to
  invent a tax point for an unpaid sale on the cash basis.
- `createVatEntries(db, input)` — creates one or two VAT entries, snapshots the
  rate and box mapping, pairs reverse-charge legs, assigns the correct VAT period.
- `resolveTreatment(db, ...)`, `resolveRate(db, ...)` — effective-dated resolution
  so a historical transaction resolves the config that applied on its own date,
  not today's.

Key invariants enforced by tests in `vat/engine.test.ts`:

- `vatDiscrepancy` is *used*: a purchase line whose stated VAT disagrees with the
  treatment's rate by more than 1 cent is costed as stated but held back from
  recovery (`recoverableOverrideMinor: 0`) and raises a review item.
- A non-Irish supplier under a domestic treatment can't validly charge Irish VAT —
  the discrepancy fires.
- Under reverse charge, stated VAT is ignored entirely — always self-assessed at
  the treatment's rate on the net.

### Tax rules

**`src/domain/rules/`**, documented in `docs/RULES_KB.md`:

- Four new tables: `irish_knowledge_sources` (documents, content-addressed by
  SHA-256, tagged `sourceType`), `irish_act_provisions` (verbatim section text with
  character offsets into the source), `irish_tax_rules` (derived rules),
  `irish_tax_rule_tests` (generated/hand-written test cases).
- Ingestion pipeline: `statuteParser.ts` (Finance Act 2024) →
  `factExtractor.ts` (mechanical regex extraction of stated figures, never invented)
  → `irishRules.ts` (derive rules, idempotent, versioned).
- VATCA 2010 curation (`vatcaCuration.ts`, `vatcaIngestion.ts`) — conditions are
  interpreted, recorded as `ai_suggestion` provenance with `confidence: 70`, not
  treated as authoritative.
- `transactionLookup.ts` — deterministic lookup: transaction → normalise → identify
  topics → candidate retrieval → evaluate conditions → evaluate exceptions →
  effective dates → applicable rules → unresolved fields → possible treatment →
  source citations → review-required.
- `review.ts` — `setRuleReviewStatus` moves a rule through the lifecycle:
  `draft → ai_extracted → human_review → approved → active → superseded`. Only
  `active` (only via a human transition) turns off `humanReviewRequired` for
  lookup purposes. `rejected` disables the rule.
- Every rule carries `reviewStatus`, `humanReviewRequired`, `requiresGuidance`,
  `reviewedBy`, `reviewedAt`, `reviewNotes`.

**Source hierarchy** (`sourceHierarchy.ts` / `SOURCE-REGISTER.md`):

```
legislation | eu_source         -> rank 1 (primary law)
revenue_guidance | revenue_ebrief | cro_guidance -> rank 2
accounting_standard                -> rank 3
leabhar_implementation_rule       -> rank 4 (this practice's own convention)
```

A Revenue interpretation can never overwrite or outrank the legislation it explains.

**Rule versioning**: legislative change never edits a historical rule in place.
The old rule's `effectiveTo` is set and a new row inserted with
`supersedesRuleId` back to it and `ruleVersion + 1`.

**Current state of the KB (as of this audit):**

- 348 provisions ingested across fourteen sources.
- 194 judged relevant, 154 not (procedural/repeal/penalty/pure-definition).
- 32 rules extracted, all `ai_extracted`, all `human_review_required = true` —
  **zero rules in this KB are authoritative yet.**
- `vat.rate_standard_current` (23%), `vat.rate_reduced_current` (13.5%),
  `vat.rate_livestock_current` (4.8%) carry no conditions (facts, not tests).
- `resolveVatRateExclusivity` in `transactionLookup.ts` ensures exactly one rate
  wins when a specific category matches, and the standard-rate fallback otherwise.
- `resolveDeductionExclusivity` drops `vat.input_deduction_general` (s.59) when a
  `vat.deduction_exclusions_entertainment` (s.60(2)(a)) rule also matches.

### Document / evidence handling

**`src/db/schema/documents.ts`**:

- `documents` with `filename`, `sha256`, `file_path`, `file_size`, `content_type`,
  `uploaded_at`, `uploaded_by`.
- `extracted_fields` — field name → { value, confidence, evidence }, linking each
  extracted value back to the document.
- Documents are never modified after ingest (invariant #5); the SHA-256 is
  re-checkable.
- `src/domain/extraction/service.ts` — the LLM-assisted extraction pipeline. AI
  may extract, classify, suggest. Results go through the `reviewItems` queue
  (`review_items` in `operations.ts`) until a human confirms.

### Reconciliation

**`src/domain/banking/reconciliation.ts`**:

- `reconcileBankAccount(db, ...)` — reads the statement balance from the
  statement, compares to the ledger balance per posted journal entries.
- Explains differences: unclassified lines, ledger entries not on the statement,
  suspected duplicates (flagged, not auto-corrected), missing documents.
- `completeReconciliation(db, ...)` — records the reconciliation, marks
  transactions. Refuses to complete with an unexplained difference
  (`ReconciliationError`). Differences can be accepted only with a recorded
  reason (audited).
- Multi-currency handling: a foreign `amountMinor` without a `base_amount` is
  refused rather than silently folded into a base-currency difference.
- Opening balances are handled correctly (issue #153): a posted opening balance
  is not treated as an unexplained ledger-only movement.

### Audit trail

Every table with `provenance` columns carries `source`, `confidence`,
`provenanceStatus`. Additionally:

- `audit_events` table — written on journal entry creation, reversal, period unlock,
  reconciliation completion, review-item creation. Each row has `entityType`,
  `entityId`, `action`, `actor`, `source`, `previousValue`/`newValue`, `reason`.
- `review_items` table — surfaces anything needing human attention: AI suggestions,
  anomalies, VAT discrepancies, duplicate invoices/payments, missing evidence.
- `bank_transactions.fingerprint` — deterministic, so duplicate imports are
  detected, not silently deduplicated.

### AI integration

The codebase distinguishes several roles for AI, per `docs/RULES_KB.md`:

1. **Extraction** (`src/domain/extraction/`) — LLM reads invoice/receipt text,
   extracts structured fields. Results carry `confidence` and `evidence`. Unconfirmed
   results surface in the `review_items` queue.
2. **Classification suggestion** — the rules engine can suggest an account/VAT
   treatment (README §18: "confirmed rules outrank AI suggestions"). An AI
   suggestion that conflicts with a deterministic rule is flagged, not silently
   accepted.
3. **Explanation** (`src/domain/reports/explain.ts`) — AI may generate plain-language
   glosses stored as `humanExplanation` on provisions/rules, always
   `ai_suggestion` provenance until confirmed.

**Critical invariant**: nothing in the deterministic rule-lookup path
(`transactionLookup.ts`) calls an LLM. Every number a rule states is a token the
parser found in the source text, not a model's claim. The only LLM integration
is in extraction, and only when the user explicitly provides an API key.

### Explainability

**`src/domain/reports/explain.ts`**:

- `Explained` interface: `{ label, valueMinor, currency, method, components,
  sources, notes, asOf }`.
- `explained(...)` / `sumExplained(...)` / `flattenSources()` /
  `renderExplanation()`.
- Reports return `Explained` values carrying both the figure and its derivation.
  Components are themselves `Explained`, so drilling down is recursive: profit →
  revenue/expenses → accounts → journal lines → transactions → invoices →
  documents.
- `ExplainedSource` carries `entityType` | `entityId` | `label` | `amountMinor` |
  `date`, providing a link back to the source record.

### Tests

- 1013 tests pass (vitest, 63 test files).
- Testing convention: `vitest` + `@/db/testing` (`createTestDatabase` builds an
  in-memory SQLite database with full schema + `createCompany` for a seeded
  company).
- Key test files: `journal.test.ts` (double-entry integrity, immutability, period
  locking), `vat/engine.test.ts` (VAT arithmetic, discrepancies, reverse charge,
  historical rates), `reconciliation.test.ts` (statement vs ledger balance,
  duplicates, multi-currency, opening balance), `rules/engine.test.ts`,
  `rules/irishRules.test.ts`, `rules/transactionLookup.test.ts`,
  `rules/testCases.test.ts`, `rules/review.test.ts`, `reports/financial.test.ts`.

### Source-to-ledger traceability (currently partial)

Traceability links that already exist:

| From | To | Mechanism |
|------|-----|-----------|
| `journal_lines` | `journal_entries` | `journal_entry_id` FK |
| `journal_entries` | `bank_transactions` | `source_type='bank_transaction'`, `source_id` |
| `journal_entries` | `invoices` | `source_type='sales_invoice'`/`'purchase_invoice'`, `source_id` |
| `vat_entries` | `journal_entries` | `journal_entry_id` FK |
| `vat_entries` | source docs | `source_type`/`source_id` |
| `bank_transactions` | `statement_imports` | `statement_import_id` FK |
| `journal_lines` | counterparties | `supplier_id`/`customer_id`/`officer_id` |

Links that are **not** currently wired end-to-end:

- There is no single function to traverse a ledger line back to its source
  document byte range. The `documents.sha256` + `extracted_fields.evidence`
  chain exists, but journal entries do not directly reference a document id;
  they reference an invoice id, which would need to reference a document.
- There is no machine-readable "decision explanation" model that captures the
  full AI-suggestion → rule-evaluation → accounting-result chain for a single
  transaction in one inspectable object.

## What is deterministic

| Function | File | Deterministic? |
|----------|------|----------------|
| Journal posting (balance check) | `journal.ts` | Yes — enforced at write time |
| VAT calculation | `vat/engine.ts` | Yes — pure integer arithmetic |
| VAT treatment/rate resolution | `vat/engine.ts` | Yes — effective-dated |
| Transaction rule lookup | `rules/transactionLookup.ts` | Yes — keyword topics + condition eval |
| Bank import/fingerprint | `banking/import.ts` | Yes — deterministic fingerprint |
| Reconciliation | `banking/reconciliation.ts` | Yes — statement balance is evidence |
| Statement import | `banking/import.ts` | Yes — dedup by fingerprint |
| Ledger aggregation | `accounting/ledger.ts` | Yes — derived from journal lines |
| Opening balance handling | `banking/reconciliation.ts` | Yes (issue #153 fix) |
| Rule ingestion/extraction | `rules/statuteParser.ts`, `factExtractor.ts` | Yes — text parsing, no LLM |
| Rule versioning | schema (`effectiveFrom`/`To`, `supersedesRuleId`) | Yes |
| Currency conversion | `money.ts` | Yes — rational multiply, no floats |
| Multi-currency reconciliation | `banking/reconciliation.ts` | Yes — refuses without base amount |

What is **not** deterministic:

- AI extraction of invoice/receipt fields (`extraction/service.ts`) — only
  activates when the user provides an API key; results need human confirmation.
- AI-generated plain-language glosses on provisions/rules — stored
  `ai_suggestion`, never authoritative until confirmed.

## Where AI participates

1. **Field extraction** from invoices/receipts — `src/domain/extraction/service.ts`.
   Output: `extracted_fields` with `confidence` and `evidence` per field.
   Unconfirmed results → `review_items` queue.

2. **Classification suggestions** — the rules engine's `suggest` path. An AI
   suggestion can be overridden by a confirmed coding rule (README §18).

3. **Plain-language explanation** of provisions/rules — `humanExplanation` column,
   always `ai_suggestion` provenance.

AI **never** participates in:

- Journal posting (balance enforcement, period validation)
- VAT calculation (integer arithmetic, `vatDiscrepancy` check)
- Transaction rule lookup (keyword topics + condition evaluation)
- Bank statement import (fingerprint-based dedup)
- Reconciliation (statement balance is evidence)
- Source document hashing (SHA-256)

## Where source evidence is retained

- **Bank statements**: `statement_imports` (filename, hash, row counts, status)
  + `bank_transactions` (date, amount, description, reference, fingerprint,
  balance, raw_data). Never mutated after insert.
- **Invoices/documents**: `documents` (filename, SHA-256, path, size, type,
  uploaded_at/by) + `extracted_fields` (value, confidence, evidence per field).
- **Statute sources**: `irish_knowledge_sources` (SHA-256, sourceUrl,
  localPath, publicationDate) + `irish_act_provisions` (provisionText,
  sourceStart, sourceEnd — character offsets into the original document).
- **Journal entries**: `audit_events` records every post/reversal/unlock with
  full totals and actor. `provenance` on every line.
- **VAT entries**: snapshotted rate, box mapping, treatment id — immune to later
  config edits.
- **Reconciliations**: recorded with statement vs ledger balance, difference,
  status, completed_at/by, reason (when accepted with a difference).

## How accounting decisions are currently made

```
Bank transaction / invoice
  → identifyTopics (keyword routing to vat/banking/rct/capital_allowances/...)
  → listTaxRulesByTopic (rules in force on the transaction's own date)
  → evaluateAllConditions (same evaluator as the coding-rules engine)
  → exceptions → unresolvedFields → reviewReasons
  → possibleTreatment (accounting/tax/vat/reporting effects)
  → reviewRequired (true if: no applicable rule, any rule needs guidance,
     any rule has exceptions, any rule is humanReviewRequired,
     any condition field is unresolved)
  → classifyTransaction / postJournalEntry (only if user overrides or rules
     are approved)
```

The lookup **always** returns `reviewRequired: true` today because no rule in
the KB has reached `reviewStatus: 'active'` yet (all are `ai_extracted`).
This is by design, not a bug — the system errs on the side of human review.

For coding rules (user-authored bank-transaction rules, `rules` table), the
engine evaluates conditions and the first matching rule wins; confirmed rules
outrank AI suggestions.

## How journals are generated

All journals are created via `postJournalEntry`:

1. **Bank classification** — `classifyTransaction` posts a journal entry
   matching the transaction to an account + VAT treatment, with the bank line
   as one side and the classified account as the other.
2. **Invoice posting** — `createInvoice` posts a sales or purchase invoice,
   optionally creating VAT entries via `createVatEntries`.
3. **Manual adjustment** — direct `postJournalEntry` call.
4. **Reversal** — `reverseJournalEntry`.
5. **Year-end** — `yearEnd.ts` posts closing entries.

Every journal entry is balanced (debits == credits in base currency) at post
time. Every line carries `provenance` (source, confidence, provenanceStatus).
Every post writes an `audit_events` row.

## How VAT is calculated

`calculateVat` in `src/domain/vat/engine.ts`:

- Integer minor-unit arithmetic — never a float.
- `net + vat == gross` always (tested across 1,500+ values).
- Accepts net OR gross input; if gross, derives net arithmetically.
- Uses a stated VAT amount when supplied (supplier may have rounded per line),
  but only within the `vatDiscrepancy` guard.
- Reverse charge: ignores stated VAT, always self-assesses at the treatment's
  rate on the net.
- `recoverableVatMinor` can be overridden to 0 (`recoverableOverrideMinor`)
  when a discrepancy or non-Irish supplier fires — the cost is still as stated,
  but recovery is held back pending review.

`createVatEntries` creates VAT entry rows with snapshotted rate and box mapping,
pairs reverse-charge legs, assigns the correct VAT period.

## How reconciliation works

`reconcileBankAccount` (`banking/reconciliation.ts`):

1. Reads the statement closing balance from the imported statement (not from
   the ledger — the statement is the evidence).
2. Computes the ledger balance from posted journal entries on the account.
3. Compares: difference == statement - ledger.
4. Explains the difference item by item:
   - `statement_not_in_ledger` — unclassified bank lines.
   - `ledger_not_on_statement` — posted entries not yet cleared by the bank.
   - `suspected_duplicate` — same-day identical charges (flagged, not auto-
     deleted).
   - `missing_document` — flagged for review.
5. `reconciled` is true only when `unexplainedMinor == 0`.
6. Multi-currency: a foreign line without a base amount causes
   `ReconciliationError` — never silently folded.
7. Opening balances are not treated as unexplained movements (issue #153).
8. `completeReconciliation` records the result; refuses to complete with an
   unexplained difference unless a reason is provided (audited).

## Current testing coverage

| Area | Test file | Key cases |
|------|-----------|-----------|
| Journal integrity | `journal.test.ts` | Balance enforcement (debits==credits), immutability (no edits to posted entries), period locking, reversal correctness, FX rational conversion, audit events written |
| VAT arithmetic | `vat/engine.test.ts` | Net/gross/VAT reconciliation (1,500+ values), stated VAT vs rate discrepancy (1 cent), reverse charge ignores stated VAT, exempt vs zero-rated distinction, recoverable restriction, historical rates (refuses when no rate in force), snapshots rate/box mapping |
| VAT entries | `vat/engine.test.ts` | Single entry for domestic purchase, two entries for reverse charge (paired), statistical net box (ES2), import postponed accounting (PA1), EU supply boxes (E1/ES1/ES2), rate/box snapshot on treatment edit |
| Reconciliation | `banking/reconciliation.test.ts` | Statement balance from statement not ledger, unclassified lines explained, ledger-not-on-statement, refuses unexplained difference, derived balance when no closing figure, supplied closing balance, duplicate flagging (same-day), distinct bank transaction ids not flagged, multi-currency (refuses foreign without base, uses base amount, classifies with statement rate), opening balance handling (non-reversed, composed with movements) |
| Banking import | `banking/import.test.ts` | (exists, fingerprint dedup, duplicate detection) |
| Extraction | `extraction/localProvider.test.ts`, `extraction/suppliers.test.ts` | Local (non-AI) extraction of supplier names, amounts, dates |
| Rules engine | `rules/engine.test.ts` | Condition evaluation, rule matching, AI vs confirmed rule precedence |
| Irish rules KB | `rules/irishRules.test.ts` | Ingestion (118 provisions, idempotent), rule derivation (verbatim facts, never invented, all start `ai_extracted`/`humanReviewRequired`), versioning (changed figure → new row, old closed), lookup (by key, by date, by topic/category, returns null not guess) |
| Transaction lookup | `rules/transactionLookup.test.ts` | Topic routing, topic exemptions (non-trading bank narratives, bare card payments), VAT rate exclusivity, deduction exclusivity, unresolved fields, the 8 worked examples from docs/RULES_KB.md |
| Rule test cases | `rules/testCases.test.ts` | Generated positive/effective-date cases per rule (8 cases, all pass), idempotency, broken rule shows as failure |
| Review lifecycle | `rules/review.test.ts` | DRAFT→AI_EXTRACTED→HUMAN_REVIEW→APPROVED→ACTIVE→SUPERSEDED, rejected disables rule, unknown rule throws |
| Financial reports | `reports/financial.test.ts` | P&L, balance sheet, explainAccount, trial balance, period boundaries |
| Anomalies | `review/anomalies.ts` (tested via reconciliation/banking tests) | Duplicate invoices (near-duplicate by supplier+amount+date), duplicate bank payments, hospitality rate mismatches, non-trading purchases (donations), unresolved AI suggestions |
| Immutability | `immutability.test.ts` | Bank transactions never mutated, documents never modified, posted journals immutable |

## Gaps against the trust model

The trust model (from the programme brief) requires answering, for every
accounting decision:

1. **What happened?** — Partially. Bank transactions record date/amount/description;
   journal entries record debit/credit and narrative. The link from a journal line
   back to the original bank transaction exists (`source_type`/`source_id`) but
   is not exposed as a single traversable API.

2. **What evidence supports it?** — Partially. `documents.sha256` + `extracted_fields`
   preserve the source; bank statements are write-once. But a journal entry does
   not directly reference a document id — it references an invoice id
   (`source_type='purchase_invoice'`, `source_id=invoice_id`), and tracing from
   invoice to document requires additional joins not yet encapsulated.

3. **What did the system extract?** — Partially. `extracted_fields` stores
   {value, confidence, evidence} per field, but there is no consolidated
   "extracted facts" object exposed per transaction that bundles all extractions
   for a given bank transaction + invoice pair.

4. **What did AI suggest?** — Partially. AI extraction results carry `confidence`
   and surface in `review_items`. The original AI suggestion is not persisted
   alongside the final classification in a structured, machine-readable form that
   survives confirmation.

5. **What rule was applied?** — Partially. `bank_transactions.applied_rule_id`
   exists. For statute-derived rules, `lookupTransactionRules` returns
   `applicableRules` with `ruleKey`, `statement`, `citation`, `effectiveFrom/To`.
   But there is no persisted "decision" record linking the final posting to the
   specific rule evaluation that produced it.

6. **Why was that rule applicable?** — Partially. `transactionLookup.ts` returns
   `reviewReasons`, `unresolvedFields`, `conditionResults`, and the `identification`
   object in the AI provider carries `evidence` and `facts`. But this is
   ephemeral — returned at lookup time, not persisted alongside the journal entry.

7. **What accounting entry resulted?** — Yes. Journal lines with debit/credit,
   account, currency, FX rate, provenance.

8. **What VAT/tax effect resulted?** — Yes. `vat_entries` with snapshotted rate,
   box, treatment, recoverability.

9. **Can the result be reconciled?** — Yes. Bank reconciliation (statement ==
   ledger), VAT reconciliation (entries sum to box totals), trial balance
   (debits == credits).

10. **Was human review required?** — Partially. `bank_transactions.status` enum
    and `review_items` queue exist, but the three-state semantic
    (VERIFIED / REVIEW_REQUIRED / INVALID) is not explicitly formalised
    as a field or enum on transactions/journal entries.

### Specific gaps to address

| Gap | Current state | Trust model requirement |
|-----|--------------|----------------------|
| No golden test case framework | Test cases are inline in `*.test.ts` files | WP03: reusable `tests/golden/` structure with 10+ cases |
| No persisted decision explanation | Lookup result is ephemeral; not linked to the posted entry | WP06/WP07: a persisted, machine-readable decision model + "why?" API |
| No explicit verification state enum | Status is `unclassified/suggested/classified/matched/posted/reconciled/ignored/duplicate` | WP12: formalise VERIFIED/AUTO_CLASSIFIED/REVIEW_REQUIRED/CONFLICT/etc. |
| No end-to-end traceability function | Traceability exists via FKs but not encapsulated | WP05: a function traversing ledger → journal → transaction → document |
| No verification report | Reconciliation reports exist per-period | WP13: aggregate verification report with GREEN/AMBER/RED semantics |
| No automated verify command | `npm test` runs unit tests | WP18: `npm run verify:accounting` aggregating all accounting tests |
| No adversarial test data | Anomaly detection exists but not as a curated adversarial suite | WP16: intentional edge-case datasets |
| No end-to-end demo company | Test companies exist in fixtures | WP17: complete Irish SME dataset with expected deterministic figures |
| AI suggestions not persisted alongside final decisions | Extraction results are ephemeral | WP10: ensure AI cannot override rules; persist the separation |
| No human review workflow API | `review_items` queue exists, `setRuleReviewStatus` for rules | WP15: structured review workflow for accounting decisions |

## Summary

Leabhar's existing architecture already embodies most of the trust-model
principles in code: deterministic rule lookup, integer VAT arithmetic,
write-once evidence, immutable journals, effective-dated configuration,
versioned rules, and a source hierarchy that prevents guidance from outranking
legislation. The AI is confined to extraction and suggestion, never to
authoritative accounting decisions.

The gaps are primarily in **assembly and presentation**: the pieces exist but
are not wired into a single inspectable decision record, there is no golden-
test-case framework, no formalised verification states, no end-to-end
traceability function, and no aggregate verification report.

The most significant finding is that the statute-derived rule KB contains zero
authoritative rules (all are `ai_extracted`, `human_review_required: true`).
This is the correct state — the system refuses to make AI-extracted rules
authoritative — but it means the lookup currently *always* returns
`reviewRequired: true`, which must be documented honestly rather than hidden.

# Leabhar Trust Model

> Work Package 02: Trust Model
>
> Defines the conceptual architecture that every accounting decision passes
> through, and the invariant that separates probabilistic AI from authoritative
> accounting logic.

## Core principle

```
AI can propose.  Rules decide.  Accounting engines post.  Verification proves.
```

- **AI propose** — extract facts from documents, suggest a category, flag an
  anomaly. Nothing the AI says becomes accounting truth by itself.
- **Rules decide** — deterministic, effective-dated rules evaluate the extracted
  facts and conditions. The rule result is authoritative for the treatment it
  covers.
- **Accounting engines post** — the journal engine enforces double-entry
  integrity and records the result with provenance. It does not ask the AI
  whether the entry balances.
- **Verification proves** — tests and reconciliation demonstrate that the result
  is internally consistent and traceable to source evidence.

## The nine verification questions

For every accounting decision, the system must be able to answer:

1. **What happened?** — the bank transaction or document event: date, amount,
   description, counterparty.
2. **What evidence supports it?** — the original bank statement line, the invoice
   PDF, the receipt image — referenced by stable identifier and SHA-256.
3. **What did the system extract?** — structured facts: supplier, invoice total,
   VAT amount, currency, invoice date, net amount, gross amount.
4. **What did AI suggest?** — a probabilistic interpretation: suggested category,
   suggested VAT treatment, confidence score. Always labelled as AI.
5. **What rule was applied?** — the rule key, statement, and source citation.
6. **Why was that rule applicable?** — the condition that matched, the effective
   date window, the topic routing.
7. **What accounting entry resulted?** — debit/credit lines, account, currency,
   FX rate.
8. **What VAT/tax effect resulted?** — input/output VAT, box mapping,
   recoverability, rate snapshot.
9. **Was human review required?** — explicit yes/no with reasons.

## Architecture diagram

```
┌──────────────────────────┐
│   BANK / DOCUMENT        │
│   EVIDENCE               │
│                          │
│  • Bank statement (CSV)  │
│  • Invoice PDF           │
│  • Receipt image         │
│                          │
│  Write-once. SHA-256.    │
│  Never modified.         │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   EXTRACTION              │
│                          │
│  • AI field extraction    │
│    (value, confidence,    │
│    evidence per field)    │
│  • Fact extraction        │
│    (mechanical, from       │
│    statute text)           │
│                          │
│  AI result → review queue │
│  if confidence < 100%     │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   STRUCTURED FACTS       │
│                          │
│  transactionDate          │
│  amountMinor              │
│  currency                 │
│  supplierCountry          │
│  supplyType               │
│  vatRegistered            │
│  invoiceAvailable         │
│  businessUsePercent       │
│  ─────────────────        │
│  (plus any extracted      │
│   invoice fields:        │
│   invoiceTotal, vatAmount)│
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   AI SUGGESTION          │
│   (probabilistic)        │
│                          │
│  • suggestedCategory      │
│  • suggestedTreatment     │
│  • confidence             │
│  • reviewRequired (AI)    │
│                          │
│  Labeled ai_suggestion    │
│  in provenance.           │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   DETERMINISTIC RULES    │
│   (authoritative)        │
│                          │
│  topic → topicRules      │
│  conditions → evaluate   │
│  exceptions → flagged    │
│  effective dates → dated │
│                          │
│  NEVER calls an LLM.     │
│  Returns:                │
│   applicableRules[]      │
│   unresolvedFields[]     │
│   reviewReasons[]        │
│   reviewRequired: true   │
│     (until rule approved)│
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   ACCOUNTING CLASSIFICATION│
│                          │
│  • account (chart)        │
│  • vatTreatmentId         │
│  • source: rule or user   │
│  • confidence: 90/100    │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   DOUBLE-ENTRY JOURNAL   │
│                          │
│  postJournalEntry()      │
│  • debits == credits     │
│    (base currency)       │
│  • ≥2 lines, exactly     │
│    one side per line     │
│  • period validation     │
│  • audit_events written  │
│  • provenance on every   │
│    line                  │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   VAT / TAX IMPACT       │
│                          │
│  createVatEntries()      │
│  • rate snapshot         │
│  • box snapshot          │
│  • reverse-charge pairing│
│  • recoverableOverride   │
│  • vatDiscrepancy check  │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   RECONCILIATION         │
│                          │
│  • bank: statement ==    │
│    ledger (write-once)   │
│  • vat: entries ==       │
│    box totals            │
│  • ledger: debits ==     │
│    credits (trial bal)   │
│  • opening + movements   │
│    == closing            │
│                          │
│  Discrepancy → review,   │
│  never silent fix        │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   REPORT                 │
│                          │
│  P&L  │  Balance Sheet   │
│  VAT3  │  Trial Balance   │
│                          │
│  Every figure is an       │
│  Explained value:        │
│  { value, method,        │
│    components[],          │
│    sources[] }            │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│   SOURCE EVIDENCE        │
│   (traceability loop)    │
│                          │
│  ledger line            │
│    → journal entry      │
│      → journal lines    │
│        → source tx      │
│          → document     │
│                          │
│  document.sha256         │
│  re-checkable            │
└──────────────────────────┘
```

## The five data layers

### 1. Evidence (write-once, immutable)

- `bank_transactions` — imported date, amount, description, reference,
  fingerprint. Never mutated after insert.
- `documents` — filename, SHA-256, path, size. Never modified.
- `statement_imports` — filename, file hash, row counts, status.
- `irish_knowledge_sources` — statute documents, SHA-256, sourceUrl.
- `audit_events` — every journal post, reversal, period unlock,
  reconciliation completion, review-item creation.

### 2. Extracted facts (structured, confidence-rated)

- `extracted_fields` — field-name → { value, confidence, evidence } per
  document. Confidence < 100% → `review_items` queue.
- `irish_act_provisions.provisionText` + `sourceStart`/`sourceEnd` —
  verbatim text slices with character offsets into the source document.
  Extracted mechanically, never via LLM inference.

### 3. AI suggestions (probabilistic, never authoritative)

- Stored with `provenanceStatus: 'ai_suggestion'` and a `confidence` (0-100).
- Cannot overwrite `user_confirmed` or `system_rule` provenance.
- Surfaces in the `review_items` queue until a human confirms.
- An AI suggestion that conflicts with a deterministic rule produces a
  `conflict` state, not a silent override.

### 4. Deterministic rules (authoritative, effective-dated)

Two rule engines, clearly separated:

#### 4a. Coding rules — `src/domain/rules/engine.ts`

User-authored rules for bank transactions. "Code this supplier to this account."
Conditions stored as JSON, evaluated by `conditionEval.ts`. First match wins.
Confirmed rules (`provenanceStatus: 'system_rule'`) outrank AI suggestions.

#### 4b. Statute-derived rules — `src/domain/rules/transactionLookup.ts`

Rules extracted from Irish legislation and Revenue guidance. Each rule:

- Has a stable `ruleKey` (human-curated, never derived from prose).
- Carries `effectiveFrom`/`effectiveTo` — resolves the rule in force on the
  transaction's own date, not today's.
- Has `reviewStatus` — `ai_extracted` rules are never authoritative for lookup
  until a human transitions them to `active`.
- Has `sourceType` (legislation/revenue_guidance/etc.) — a Revenue
  interpretation can never outrank legislation it explains.
- Has `conditions` (evaluated) and `exceptions` (plain-language, always
  flagged for review when present).

**Current state:** all 32 statute-derived rules are `ai_extracted`,
`human_review_required: true`. The lookup therefore *always* returns
`reviewRequired: true`. This is the correct, honest state — the system refuses
to make AI-extracted rules authoritative.

**Source hierarchy** (`sourceHierarchy.ts`):

```
legislation | eu_source              → rank 1 (primary law)
revenue_guidance | revenue_ebrief     → rank 2 (explains primary law)
cro_guidance                         → rank 2
accounting_standard                  → rank 3
leabhar_implementation_rule          → rank 4 (this practice's own convention)
```

### 5. Accounting result (journal + VAT)

- `journal_entries` + `journal_lines` — double-entry, balanced at post time,
  immutable, with `source_type`/`source_id` linking to the triggering
  transaction/invoice, `created_via` (user/rule/import/system/ai), and
  `provenance` on every line.
- `vat_entries` — rate and box snapshotted (immune to later config edits),
  reverse-charge legs paired, rate never edited in place.
- `bank_transactions.status` — `unclassified/suggested/classified/matched/
  posted/reconciled/ignored/duplicate`.

## Verification

### Tests

Each golden case encodes an explicit expected result. See `tests/golden/`
(Work Package 03) and the full suite run via:

```
npm run verify:accounting
```

### Reconciliation

- **Bank reconciliation**: statement closing balance (evidence) == ledger
  balance (posted journals). Difference explained item by item, never silently
  corrected. Unexplained difference → `ReconciliationError`.
- **VAT reconciliation**: VAT entries sum to VAT3 box totals per period.
- **Ledger reconciliation**: trial balance — debits == credits.
- **Opening + movements = closing**: per-account balance walk.

## The three semantic states

Every accounting artifact has one of three states:

| State | Meaning | Colour (semantic) |
|-------|---------|-------------------|
| **VERIFIED** | Deterministic rules applied and reconciled; no unresolved conditions, no exceptions, no discrepancies. | Green |
| **REVIEW_REQUIRED** | Potentially valid but needs human review: AI extraction confidence < 100%, a rule not yet human-approved, an unresolved field, an exception flagged, a VAT discrepancy, an anomaly. | Amber |
| **INVALID** | Contradictory, missing, or unreconciled: unbalanced journal, unrecoverable evidence, conflicting AI vs rule with no resolution, broken traceability. | Red |

> The existing status enum (`unclassified/suggested/classified/matched/posted/
> reconciled/ignored/duplicate`) on `bank_transactions` is the implementation
> surface; the three-state semantic model above is the verification-layer
> interpretation of those statuses. A transaction is VERIFIED when it is
> `posted` + `reconciled` with no open `review_items`; REVIEW_REQUIRED when it
> is `matched` or has review items; INVALID when it is `ignored` or
> `duplicate` with unresolved evidence. The gap between these two models is
> formalised in Work Package 12.

## Where AI is used (and is not authoritative)

| Role | File | AI is authoritive? |
|------|------|--------------------|
| Invoice/receipt field extraction | `extraction/service.ts` | No — results → review queue |
| Classification suggestion | `banking/classify.ts` | No — coding rules outrank AI |
| Rule condition interpretation | `rules/vatcaCuration.ts` | No — stored `ai_suggestion`, `humanReviewRequired: true` |
| Plain-language provision explanation | `irish_act_provisions.humanExplanation` | No — stored `ai_suggestion` until confirmed |
| VAT rate determination | `vat/engine.ts` | Never — pure integer arithmetic |
| Journal balancing | `accounting/journal.ts` | Never — invariant check |
| Transaction rule lookup | `rules/transactionLookup.ts` | Never — keyword + condition eval |
| Bank import | `banking/import.ts` | Never — deterministic fingerprint |

## Where AI is NOT used

- VAT calculation (`vat/engine.ts`) — pure integer arithmetic.
- Journal posting (`accounting/journal.ts`) — deterministic balance check.
- Transaction rule lookup (`transactionLookup.ts`) — keyword routing +
  condition evaluation. No LLM call in the path.
- Bank statement import (`banking/import.ts`) — deterministic fingerprint
  and dedup.
- Reconciliation (`banking/reconciliation.ts`) — statement balance is evidence.
- Source document hashing — SHA-256.
- Rule ingestion from statutes (`statuteParser.ts`, `factExtractor.ts`) —
  text parsing, no inference about what a figure "should" be.

---

*Next: Work Package 03 — Golden Test Case Framework.*

# Irish Accounting Rule Provenance

> Work Package 09: Audit the existing Irish legislation/Revenue knowledge base.

## Purpose

For every accounting rule used by Leabhar, this document establishes:

- **rule ID** (stable key)
- **rule description** (what the rule says)
- **source document** (which statute or guidance)
- **source location** (section/paragraph)
- **effective date** (when the rule took effect)
- **jurisdiction** (IE = Ireland, EU, etc.)
- **applicability** (what transactions it covers)
- **implementation** (how it is checked in code)
- **tests** (which tests verify it)

This is NOT a substitute for professional advice. It records what the system
knows, what it can verify, and what it cannot.

## Source hierarchy

Rules are sourced from Irish legislation and Revenue guidance, curated into
the system via ingestion. The hierarchy (from `src/domain/rules/sourceHierarchy.ts`):

```
legislation | eu_source              → rank 1 (primary law)
revenue_guidance | revenue_ebrief     → rank 2 (explains primary law)
cro_guidance                         → rank 2
accounting_standard                  → rank 3
leabhar_implementation_rule          → rank 4 (this project's own convention)
```

## Current state

All 32 statute-derived rules are `ai_extracted`, `humanReviewRequired: true`.
The system therefore **always** returns `reviewRequired: true` for any
transaction that matches a rule. This is the correct, honest state — AI-extracted
rules are never authoritative until human-approved (see TRUST_MODEL.md).

## Rule inventory

### VAT rules (from VATCA 2010, as revised)

| Rule key | Source | Section | Topic | Human-approved? |
|---|---|---|---|---|
| `vat.charge_general` | VATCA 2010 | 3 | vat | No — requires guidance |
| `vat.reverse_charge_services_from_abroad` | VATCA 2010 | 12 | vat | No — requires guidance |
| `vat.place_of_supply_b2b_general` | VATCA 2010 | 34 | vat | No — requires guidance |
| `vat.input_deduction_general` | VATCA 2010 | 59 | vat | No — pending review |
| `vat.deduction_exclusions_entertainment` | VATCA 2010 | 60(2)(a) | business_expense | No — requires guidance |
| `vat.rate_standard_current` | VATCA Revised | S.46 | vat | No — rate snapshot only |
| `vat.rate_reduced_current` | VATCA Revised | S.46 | vat | No — rate snapshot only |

### Tax rules (from Finance Act 2024)

| Rule key | Source | Section | Topic | Human-approved? |
|---|---|---|---|---|
| `tax.annual_turnover_definition` | Finance Act 2024 | 2(1) | tax | No — pending review |
| `tax.corporation_tax_rate_small` | Finance Act 2024 | 204 | tax | No — pending review |

## Rules requiring authoritative verification

The following rules state an **interpretation** of Irish VAT law that should be
verified by a qualified professional before Leabhar treats them as authoritative:

1. **`vat.reverse_charge_services_from_abroad`** — maps "supplier established
   outside the State" onto `supplierEstablishedOutsideStateResolved`, which uses
   a country-code proxy when no direct determination is supplied. The actual
   legal test (EU Reg 282/2011 arts.10-11: seat of economic activity / fixed
   establishment) is NOT fully computable from a country code alone.
   - **Status**: `RULE_REQUIRES_AUTHORITATIVE_VERIFICATION`
   - **See**: `docs/statutes/282-2011/articles-10-13b-establishment.md`

2. **`vat.input_deduction_general`** — maps "used for the purposes of taxable
   supplies" onto `businessUsePercent > 0`, a gross oversimplification of the
   qualifying-activities list, partial exemption, and apportionment rules.
   - **Status**: `RULE_REQUIRES_AUTHORITATIVE_VERIFICATION`

3. **VATCA s.46 rates** — the KB records 21%/13.5%/4.8% from the 2010 enactment,
   but the standard rate has since been amended to 23% via Finance Acts not
   ingested into this KB. The current rate (23%) is a **seeded configuration**
   value (`createCompany`), not a knowledge-base rule.
   - **Status**: `RULE_REQUIRES_AUTHORITATIVE_VERIFICATION`
   - **Note**: The system correctly flags rate rules as requiring review;
   it never silently uses an unspecified rate.

## Rate configuration (not rule-derived)

The following rates are **configured** at company creation via `createCompany`
and are NOT derived from statute ingestion. They are snapshots in the
`taxRates` table, with `effectiveFrom`/`effectiveTo` for historical tracking.

| Code | Rate | Jurisdiction | Source |
|---|---|---|---|
| `VAT_STD` | 23% | IE | Seeded config; current as of 2025 |
| `VAT_RED` | 13.5% | IE | Seeded config; current as of 2025 |

The gap between the KB's 21% (from VATCA 2010 §46) and the current 23% is
**documentated**, not silently papered over. The KB's rate rules carry
`requiresGuidance: true` and never produce an authoritative rate on their own.

## Rule ingestion chain

```
Statute document (Markdown)
  → ingestFinanceAct2024 / ingestVatca2010
  → irish_knowledge_sources (source metadata)
  → irish_act_provisions (provision text + section numbers)
  → factExtractor / vatcaCuration (curated rule keys + conditions)
  → irish_tax_rules (rule rows with reviewStatus: ai_extracted)
  → transactionLookup.ts (deterministic lookup on transaction date)
```

Every step is deterministic text parsing or keyword/condition evaluation.
No LLM inference is used in the lookup path.

## Tests covering rules

- **Golden cases** (`tests/golden/cases/*.json`): 15 cases covering standard
  rate purchases/sales, reverse charge, EU supplies, zero-rating, credit notes,
  FX, and discrepancy detection.
- **VAT treatment suite** (`src/domain/vat/treatments.test.ts`): 24 tests
  covering rate configuration, treatment effects, snapshotting, reconciliation,
  and discrepancy detection.
- **Rule lookup tests** (`src/domain/rules/irishRules.test.ts`): verify rule
  ingestion and condition evaluation.

## Known gaps

1. Financial Act rates for 2021–2024 amendments are not ingested — only the
   2024 Act is in the KB. The current 23% rate is a seeded config value.
2. VATCA s.46(1)(c) (livestock rate) is not curated.
3. Entertainment and motor-car partial deductions (s.60) are not fully
   modelled — the keyword match in `vat.deduction_exclusions_entertainment`
   is a candidate filter, not a definitive classification.
4. Cash accounting elections and second-hand car adjustments are out of scope.

## Verification command

```
npm run verify:accounting
```

This runs the full test suite (unit + golden + VAT + integrity + traceability).

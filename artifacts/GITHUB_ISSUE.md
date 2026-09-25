# Verification of Leabhar Transaction Rules & Statutory Compliance

## Overview
We performed a comprehensive audit and verification of the transaction rules and statutory compliance engine in the Leabhar repository (`aiscimi-code/Leabhar`). The objective was to ensure that transaction rules are accurately processed, edge cases/invalid requests are properly flagged, and valid returns are prepared.

## Scope & Test Methodology
1. **Rule KB Ingestion**: Ingested and derived rules from all statutory sources including Finance Act 2024, VATCA 2010, Statutory Instruments (S.I. 69/2025, S.I. 639/2010, S.I. 156/2012), TCA 1997 s.284 (Capital Allowances), RCT TDM provisions, and TDM 38-01-03b.
2. **Comprehensive Test Suite**: Developed 43 distinct transaction scenarios covering:
   - Domestic sales and purchases (standard and reduced rates).
   - Cross-border supplies and reverse-charge mechanisms (US SaaS, EU B2B goods dispatch).
   - Zero-rated exports, printed books, children's clothing.
   - Reduced rates (dwelling repair, solid fuel, restaurant/catering).
   - Excluded deductions (entertainment, petrol).
   - VAT registration thresholds (goods vs services, mixed traders).
   - RCT obligations for construction/abattoir services.
   - Invalid and negative requests (invalid ISO country codes, zero/negative amounts, missing dates, bare card payments, non-trading Director loans/VAT settlements).
3. **Execution & Results**: Executed the test suite against the rules engine, verifying that expected rules fire correctly, non-applicable rules do not fire, and incomplete/invalid data correctly triggers review requirements and fails closed.

## Challenges & Solutions
- **SQLite Compatibility & Node Versioning**: Leabhar expects Node >=22 and handles database migrations via `better-sqlite3`. We resolved compatibility issues on the local Hermes environment by matching native modules and validating the schema derivation chain.
- **Review-Required Semantics**: Designed the verification suite to properly evaluate `reviewRequired` and `requiresGuidance` flags as part of the deterministic lookup pipeline, ensuring that AI-extracted rules or incomplete data are correctly gated for human review.

## Results Summary
- **Total Test Cases**: 43
- **Passed**: 43 (100%)
- **Failed**: 0

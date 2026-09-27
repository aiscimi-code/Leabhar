# 0016. Keep farm enterprise and crop analysis beside the ledger, as allocations of posted lines

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

EPIC 24 (#319, issues #539–#541) needs enterprise gross margins and crop
costs. The obvious design was an enterprise or cost-centre dimension on every
journal line. But posted journals are immutable (ADR 0004), and every posting
path (invoices, bank classification, payroll, expense claims) would need to
carry the new field.

Farmers usually decide the split after the fact: a feed bill goes 70% to the
dairy herd and 30% to the beef. Crop records also once held cost figures of
their own, which could drift from the books.

## Decision

Enterprise and crop analysis is a separate table, `farm_allocations`. Each row
gives an enterprise, and optionally a crop planting with an input kind, a
share in basis points of a posted income or expense line
(`src/domain/farm/allocations.ts`).
- A line's shares never exceed 100%.
- A reversing entry's lines inherit the shares of the lines they reverse.
- Crop inputs and sales are allocations, so every crop cost is a posted figure.

The one path from the farm records into the ledger is a livestock valuation,
posted like closing stock (ADR 0015).

## Consequences

- No posting path changes. Allocations can be added, corrected or removed
  (audited) without touching a posted entry.
- Margins and crop costs always reconcile to the ledger: allocated plus
  unallocated equals the account.
- Allocation is a separate step, and until it is done a line shows as
  unallocated. The screens make that visible rather than spreading it.
- A line is allocated in whole basis points, so a share can differ from an
  intended fraction by up to a hundredth of a percent.

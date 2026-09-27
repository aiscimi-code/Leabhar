# 0015. Keep stock periodically in the ledger, perpetually in a subledger costed by replay

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

EPIC 23 (#318, issues #536–#538) adds inventory. The chart already describes
periodic stock accounting (issue #359). Purchases of stock go to 5020 Goods
for resale all year, and Stock on hand (1300) moves at the period end.
Invoices, bank classification and VAT all post purchases that way.

We considered two alternatives:
- **Perpetual ledger:** debit 1300 on every receipt and credit it on every
  sale. This would change every existing purchase path. It would also need a
  journal for each issue, and a back-dated movement would re-cost journals
  that are already posted and immutable.
- **Stored issue costs:** save each issue's FIFO or average cost when it is
  recorded. A back-dated receipt would then leave stale costs behind, and
  nothing is silently repaired.

## Decision

The ledger stays periodic. `stock_movements` is an immutable perpetual
subledger. An issue's cost is never stored: `replayItem`
(`src/domain/inventory/costing.ts`) computes it by replaying the item's
movements in date and recording order. The same replay refuses negative
stock on any date.

`postClosingStock` (`src/domain/inventory/closing.ts`) is the only path from
the subledger to the ledger. It posts the change in value per stock and
cost-of-sales account pair since the last posted valuation. It posts only
when the stock account holds exactly what was last booked there. No movement
may be dated on or before a posted valuation.

## Consequences

- Purchases, invoices and VAT keep working unchanged.
- Costs are always consistent with the movements, however they were entered.
- Between closings, the balance sheet shows the last closing stock, not the
  live figure. The inventory screen shows the live valuation instead.
- Replay costs grow with each item's history. That is acceptable for a
  single business's book; a snapshot at each posted valuation would be the
  optimisation if needed.
- A correction dated before a posted valuation must be recorded after it.

# 0011. Where the year-end close puts the result, per entity type

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Issue #375 (found while reviewing #373) observed that `closeFinancialYear`
moves a year's result into the `retained_earnings` system account, whatever
the business is. For a company that is right. For a partnership it is wrong:
the result belongs to the partners, each with the share in force over the
year (TCA s.1008), and the pooled transfer meant the partners' current
account balances never carried their share of the profit. For a sole trader
the account is named "Accumulated profits" (`chartSeedFor`, issue #212),
which #375 called acceptable, while noting that many accountants transfer
the result to the capital account instead.

## Decision

`closeFinancialYear` allocates the year's result by entity type
(`src/domain/accounting/yearEnd.ts`):

- a **company** keeps the current behaviour: the result lands in retained
  earnings;
- a **sole trader** also keeps it: the result lands in "Accumulated profits";
- a **partnership** allocates the result to each partner's own current
  account, day by day through share changes, using the one allocation
  function the income tax computation uses (`allocateByShares`,
  `src/domain/config/partners.ts`), so the books and the Form 1 (Firms)
  statement cannot disagree. The close refuses, naming the gap, when the
  partners' shares do not add up to 100% during the year, and when no
  partner is recorded at all — it never guesses a share.

The sole trader keeps "Accumulated profits" rather than the capital account:
the capital account is a distinct thing (funds introduced as capital), and
folding a year's result into it silently would change what the account means
in existing books. The cost is that a sole trader's capital account does not
grow with profits by itself; a person can transfer profit to capital with an
ordinary journal when their accountant wants it that way.

## Consequences

A partnership's balance sheet now shows each partner's entitlement in their
own current account, and the Form 1 (Firms) allocation statement
(`src/domain/partnerships/report.ts`) agrees with the books by construction.
Rounding can leave the allocated parts a cent off the whole; the residue goes
to the precedent partner (or the first partner by join date) so the parts
always sum exactly, and the allocation is deterministic.

`getYearEndClose` reads the transferred result off the closing entry's own
income and expense lines rather than its retained-earnings line, because a
partnership's close has no retained-earnings line. For a company the number
is the same, so nothing observable changed there.

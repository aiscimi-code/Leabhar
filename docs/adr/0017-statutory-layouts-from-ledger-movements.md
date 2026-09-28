# 0017. Lay out the cash flow and the statutory formats from ledger movements, classified by account

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

EPIC 28 (#332) adds a cash flow statement (issue #553) and the Companies Act
2014 Schedule 3A Format 1 balance sheet and profit and loss account (issue
#554). Both re-present figures the ledger already holds. The alternatives
considered were a separate cash flow subledger (tagging every bank line
operating, investing or financing as it is classified), and a "statutory
chart" in which every account belongs to exactly one format item, set when the
account is created.

## Decision

Both layouts are derived from the posted ledger, account by account, and
nothing new is posted. The cash flow statement (`src/domain/reports/cashFlow.ts`)
uses the indirect method: profit, add back depreciation and the result on
disposal, then each balance sheet account's movement is an operating
(working capital), investing (fixed assets) or financing (equity, borrowings,
the director's account) line, by its type, system key and the loan and bank
registers. It is then checked against the movement in bank and cash, worked
out separately from the balances at each end, and any difference is shown.
The Schedule 3A layout (`src/domain/reports/schedule3A.ts`) gives each
account a default item from its type and system key; a person can map an
account to another item from a date (`statement_format_mappings`,
effective-dated like any configuration), and the layout's totals are checked
against the ledger's net assets and net profit. A balance on the wrong side
of a current item is presented on the other side (an overdrawn bank is owed
to the bank) rather than netted.

## Consequences

The statements cannot disagree with the ledger, since they are sums of it,
and a mapping change never rewrites an earlier year's layout. The cost is
that a classification is per account, not per transaction: a fixed asset
bought on credit shows as an investing outflow and a creditors increase in
the year of purchase, not as a non-cash transaction, and an account holding
both trading and financing items (a mixed "other creditors", say) moves all
of its balance under one heading. Where that matters, the fix is a separate
account, or a mapping. Every default item is a starting point for a person
to check, not a judgement the application makes for them.

# 0011. An s.381 claim records the amount, the books cannot know the other income

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

A sole trader's or partner's trading loss can be set against their other
income of the same year (TCA 1997 s.381), or carried forward against later
profits of the same trade (s.382). The books hold the trade and only the
trade: the individual's other income — pensions, rents, employment income —
is not in them, and never will be by design (one book is one business, and a
person's income is wider than the business).

So the relief's *tax effect* cannot be computed here: the tax saved depends
on the other income's amount and its marginal rate. Issue #285 asked for
s.382 to run automatically and s.381 to be a claim decision, like the
corporation tax loss claims — but those claims compute their effect from
figures in the books, and s.381's cannot be.

## Decision

s.382 runs automatically: a loss reduces later profits of the same trade,
earliest first, per individual, with nothing to decide.

s.381 is a person's decision (`ct_decisions` with `subjectType
'income_tax_loss_claim'`), and the decision carries the amount of the loss
being set against other income (`amount_minor`). The amount is the person's
own figure, recorded on the year-end decisions form; refusing an s.381 claim
without an amount is an error, and the computation never assumes one. The
claimed amount leaves the carry-forward pool; the tax it saves is computed on
the person's own return, not here, and the findings say so.

## Consequences

- The decision model gains an optional amount column, used only where the
  books cannot know the figure. Corporation tax decisions never set it.
- If the product later records the individual's other income (per year, per
  individual), the tax effect of the claim can be computed instead of
  flagged, and this decision can be revisited; that is a product question,
  tracked on the epic.
- The Form 11 preparation shows the claimed amount as the person's figure,
  and the reconciliation still reconciles only the trade's liability: the
  other income is the person's to declare.

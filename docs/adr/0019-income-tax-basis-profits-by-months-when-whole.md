# 0019. Apportion basis-period profits by months when the dates are whole months

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

Issue #281 checks the income tax computation against the Part 4 Notes for
Guidance. The Notes apportion an account's profit by months: €12,000 × 6/12
for 1 July–31 December (s.66 Example 1), €22,000 × 7/10 for 1 January–31 July
(s.67 Example 1), €32,000 × 3/8 (s.67 Example 2). The engine apportioned by
days, so 184/365 of €12,000 gave €6,049 against the Notes' €6,000 (#671).
Neither statute nor the Notes require one method; Revenue's own examples are
the figure a person will be checked against. Counting months for every case
was rejected: a trade that starts on the 10th has no whole-month fraction.

## Decision

`IncomeTaxRun.profitOf` counts months where the sub-period and the account it
is taken from both begin on the first and end on the last day of a calendar
month, and counts days otherwise (`apportion` in
`src/domain/incomeTax/computation.ts`). The penultimate year before cessation
is revised up to its actual profits when they exceed the first assessment
(s.67(1)(a)(ii)): `assessed` returns the calendar year and the revised profit,
and the cessation year's finding records the revision (#672).

## Consequences

The Notes' figures are reproduced and locked by
`src/domain/incomeTax/revenueExamples.test.ts`. A trade with mid-month dates
is still apportioned by days. A figure for a year can differ by a few euro from
the days-only method it replaced, so an earlier computation for the same books
may change. The penultimate year's basis period becomes the calendar year, so
its capital allowances are given for that year.

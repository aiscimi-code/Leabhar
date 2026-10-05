# Revenue worked examples (issue #281)

Each example in the issue is either a passing test or recorded here as not
reproducible. A figure that does not match is a bug, not a silent pass. Whole calendar
months are apportioned as months, as the Notes do, and other dates in days
(ADR 0019; #671, #672).

## Income tax basis periods (Part 4 Notes for Guidance)

| Example | Result |
|---|---|
| s.65 Example 1 (year to 31 October is that year's basis) | Passing test, run for 2005: the wear and tear rate starts on 4 December 2002 and a computation runs from commencement. No euro figure in the Notes. |
| s.65 Examples 2–4 (long account, two accounts, no account ending in the year) | Not reproducible. The engine has one year-end date and builds accounts from commencement to that date, then yearly. It cannot be given an 18-month account or two accounts ending in one year. |
| s.65 Examples 5–13 (2001/02 changeover, revision of the preceding year) | Not reproducible. The changeover rules and the preceding-year revision are not implemented. |
| s.66 Example 1 | Passing test: period dates, €6,000 (6/12) and €12,000. |
| s.66 Example 2 (one 14-month account) | Not reproducible. No way to record a first account that is not the year-end. |
| s.66 Example 3 (two accounts ending in the second year) | Not reproducible. Same reason. |
| s.66 Example 4 (s.66(3) election) | The election is tested in `computation.test.ts`. The excess is computed by the same month apportionment; the Notes' €2,000 figure is not run as it needs the long first account of Example 2. |
| s.66 Examples 5–6 (2001 short year, 74%) | Not reproducible. The 2001 changeover is not implemented. |
| s.67 Example 1 | Passing test: cessation-year dates and €15,400 (7/10). |
| s.67 Example 2 | Passing test: cessation year €20,000 (5/8), penultimate year revised to €30,000. Run with commencement on 1 January 2002 (wear and tear rate start). |
| s.67 Example 3 (2002 cessation, 74% of 2001) | Not reproducible. The 2001 changeover is not implemented. |

## Capital allowances (Part 9 Notes for Guidance)

| Example | Result |
|---|---|
| s.288 balancing allowance and charge | Not reproducible. The notes under s.288 are narrative (interests in land). The numerical balancing example is an industrial building diverted to non-industrial use, with notional writing-down allowances (s.277(4)) and a 10/15 reduction. The engine does not model non-industrial use or notional allowances. |
| s.292 "amount still unallowed" | Not reproducible as a worked example. The note defines the term. It has no euro example of its own. The balancing arithmetic that uses the term is the industrial-building example above. |

## Loss relief (Part 12 Notes for Guidance)

| Example | Result |
|---|---|
| s.396A | Not reproducible through the ledger. The example splits a €1,500 loss into a €1,000 relevant trading loss (carried back against relevant trading income) and a €500 other trading loss (set against the same period's other income). The engine has one trading result. It does not classify a loss as relevant trading income. |

## Distributable income (Part 13 Notes for Guidance)

| Example | Result |
|---|---|
| s.440: €30,000 undistributed, surcharge €6,000 | Passing test of `section440Surcharge` (also `computation.test.ts`). |
| s.440: distribution €27,600, excess €2,400, marginal relief €320 | Passing test of `section440Surcharge`. |
| s.440: distribution €28,500, excess €1,500, no surcharge | Covered by the same function (excess under the €2,000 threshold is nil). |
| s.434 worked example of estate and investment income | Not a separate computation. The €30,000 figure above is that example's input. The engine does not reconstruct the case income, franked income and charges that produce the €30,000. |

## VAT RTD

Appendix 3 of `docs/statutes/vat3-rtd/VAT-RTD-S76.md` is a ROS acknowledgement (boxes and totals), not the invoices and rates that produced them. The inputs are not reconstructible. Not reproducible.

## CT1 and Form 11 TDMs

`docs/statutes/tdm-ct/` has no worked computation with inputs and a resulting liability. Nothing to reproduce.

## Not in this pass

The issue also asks for a scripted review of the domain code merged in #262–#279. That review is not this change.

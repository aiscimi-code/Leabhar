# 0018. Date a forecast payment by a curated rule, or leave it undated

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

EPIC 29 (#333) adds a cash forecast (#565) with tax and statutory payments
(#566) and payroll (#568). A forecast needs a date for every payment it
places. Some dates have a source Leabhar holds: VATCA s.76(1) and s.78(2),
the corporation tax dates the CT computation already gives, TCA s.959AO for
income tax, TCA s.530 for RCT. Others do not: the day PAYE, USC and PRSI are
paid to Revenue is not in S.I. 345/2018, and the ROS extension to the income
tax date is not in any source we have collected. The first forecast (commit
66de8b7, reverted) put VAT on the 23rd while citing s.76 and payroll on a
guessed 14th. The alternative considered was a configurable "typical day" per
tax, defaulting to a common value.

A second question was where the forecast's choices live: the receipt basis,
the horizon, whether tax uses the statutory or the ROS date, and so on.
The decisions on #333 give the person an option wherever possible.

## Decision

A forecast payment is dated by a curated rule, and the line carries the rule
key (`src/domain/forecast/taxOutflows.ts`). A payment with no curated date is
listed in `undated`, totalled, and kept out of the running balance, with a
finding naming what is missing (`src/domain/forecast/payrollForecast.ts`). It
is never placed on a guessed day. The ROS dates are used only where a source
gives them (VAT s.78(2), RCT s.530, corporation tax TDM 47-06-01); for income
tax the statutory 31 October is used, with a finding.

Every forecast choice is a company default, kept as a versioned row
(`forecast_settings`, AGENTS.md #6), and each can be overridden for one
forecast (`forecastOptions` in `src/domain/forecast/settings.ts`). A forecast
records the options it was built from, and a saved forecast keeps them with
the result.

## Consequences

The running balance never moves because of a date nobody can cite. The honest
cost is that a company with payroll sees its PAYE, USC and PRSI as a total
beside the forecast rather than in the week it will leave the bank, until a
source for the date is collected and curated; then the line gains a date and
nothing else changes. A new statutory payment added to the forecast needs a
curated rule for its date, or it goes in `undated`.

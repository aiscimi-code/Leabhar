# 0003. Money as integer minor units, FX rates as rationals

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

Binary floating point cannot represent 0.1, so a float book of account drifts
by fractions of a cent on every arithmetic step — and a book of account that
disagrees with itself about a cent is broken. An FX rate is worse: storing
0.85671 as a float loses the exact rate, so a stored conversion cannot be
reproduced or audited.

## Decision

Every monetary value is an integer count of minor units (cents) carrying an
explicit ISO 4217 currency code. `src/domain/money.ts` is the only way money
is constructed; `asMinor()` rejects non-integers, so a float cannot enter the
books through a conversion at the boundary. SQLite columns hold the integers
directly.

FX rates are stored as an integer numerator/denominator pair
(`fx_rate_numerator`, `fx_rate_denominator`) so the rate is exact. Conversion
rounds once, half-up, at the time of posting, and the rounded
`base_amount_minor` is stored; reports sum stored values and never re-derive
conversions. The original amount and currency are never replaced by the
conversion (README §22).

## Consequences

- Debits equal credits exactly, and a trial balance that balances stays
  balanced; no epsilon comparisons anywhere in the domain.
- Division is explicit and rare: it happens once, at conversion, with a
  written-down rounding rule. Everything downstream is integer addition.
- Formatting to a string happens only at the edges (`src/lib/format.ts`);
  the domain never formats.
- The cost is human: every new code path must remember it is holding minor
  units, and a stray `* 100` is a silent 100x error. The type system cannot
  distinguish minor units from counts, so tests pin each posting path's
  arithmetic (`src/domain/money.test.ts`, `src/domain/accounting/*.test.ts`).

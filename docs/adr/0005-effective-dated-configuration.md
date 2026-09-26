# 0005. Configuration is effective-dated, never overwritten

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

VAT rates change; treatments change; the standard-rate reduction of 2020 and
the 9% hospitality rate are recent Irish examples. An entry posted in 2020 must
report under 2020's rates even when computed today, and a Revenue audit will
re-derive a figure under the law as it stood at the tax point.

## Decision

Configuration rows — tax rates, VAT treatments, chart of accounts
(`src/db/schema/config.ts`) — are never updated in place. A change supersedes:
the old row keeps its date range, the new row starts where the old one ended.
Every consumer resolves configuration *as of a date*, and the entries that
depend on a resolved configuration snapshot what they resolved, so a posted
entry is self-describing even if the configuration rows are later superseded
again. The `settings` table (`src/db/schema/config.ts`) holds only the current
value of things that have no history to keep.

## Consequences

- Historical entries never change meaning when a rate changes; a report
  recomputed today agrees with the return filed at the time.
- A correction posted *now* to a *past* period resolves the past period's
  configuration, which is the legally correct behaviour.
- Superseding is more work than updating: the UI and the domain both deal in
  ranges rather than single rows. The alternative — recomputing history from
  current values — is the failure mode README forbids, and it is silent.
- There is no "effective" trick to remember: if a table carries a date or a
  date range, it is history and must be superseded; if a consumer cares which
  version applied, it snapshots.

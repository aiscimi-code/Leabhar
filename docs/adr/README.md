# Architecture decision records

An ADR records *why* a decision was made, once, at the time it was made.
`docs/DOMAIN_MODEL.md` records *what* the system is; `AGENTS.md` records *how
to work in it*; an ADR records *why a choice was taken and what it cost*.

The first six ADRs were recorded retroactively in September 2026 (issue #296).
The decisions themselves were made at design time, and the code that
implements them is cited in each record. A retroactive ADR is marked with the
date it was written, not the date the decision was first taken.

## Process

1. Copy `_template.md`.
2. Take the next free number. Numbers are never reused or renumbered.
3. Write it before, or in the same pull request as, the code that depends
   on it. A decision with no code behind it can still be recorded — a
   "declined" alternative is worth writing down.
4. Set `Status` to `Accepted` (or `Proposed` while the PR is open).
5. Never edit an accepted ADR. Supersede it: write a new one and change
   the old record's `Status` to `Superseded by ADR-NNNN`.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-local-first-single-book.md) | One local book per install, no multi-tenant server | Accepted |
| [0002](0002-pure-domain-layer.md) | A pure, UI-independent domain layer | Accepted |
| [0003](0003-integer-money-rational-fx.md) | Money as integer minor units, FX rates as rationals | Accepted |
| [0004](0004-immutable-posted-journals.md) | Posted journals are immutable; corrections reverse | Accepted |
| [0005](0005-effective-dated-configuration.md) | Configuration is effective-dated, never overwritten | Accepted |
| [0006](0006-local-single-user-auth.md) | Local accounts per install; no workspace concept | Superseded by 0007 |
| [0007](0007-roles-and-membership-in-a-local-book.md) | Roles and business membership within a local book | Accepted |
| [0008](0008-journal-lines-snapshot-account-identity.md) | A journal line snapshots the account it was posted to | Accepted |
| [0009](0009-workflows-own-the-schedule-ledger-owns-the-facts.md) | Engine workflows own the schedule; the ledger owns the facts | Accepted |
| [0010](0010-document-retirement-two-steps.md) | Document retirement is a two-step decision | Accepted |
| [0011](0011-s381-claim-amount-on-decision.md) | An s.381 claim records the amount; the books cannot know the other income | Accepted |
| [0012](0012-year-end-close-destination.md) | Where the year-end close puts the result, per entity type | Accepted |
| [0013](0013-no-personal-non-trading-income.md) | An individual's non-trading income is never recorded; the return flags it | Accepted |
| [0014](0014-payroll-figures-rpn-and-rules.md) | Take an employee's figures from the RPN and the statutory figures from the rules | Accepted |
| [0015](0015-periodic-ledger-perpetual-stock-costed-by-replay.md) | Keep stock periodically in the ledger, perpetually in a subledger costed by replay | Accepted |
| [0016](0016-farm-analysis-beside-the-ledger.md) | Keep farm enterprise and crop analysis beside the ledger, as allocations of posted lines | Accepted |
| [0017](0017-statutory-layouts-from-ledger-movements.md) | Lay out the cash flow and the statutory formats from ledger movements, classified by account | Accepted |
| [0018](0018-forecast-dates-from-rules-or-none.md) | Date a forecast payment by a curated rule, or leave it undated | Accepted |
| [0019](0019-income-tax-basis-profits-by-months-when-whole.md) | Apportion basis-period profits by months when the dates are whole months | Accepted |
| [0020](0020-rules-registry-stable-keys-typed-links.md) | Keep the statutory rules in one registry, with stable keys, typed links and shipped review | Accepted |
| [0021](0021-install-level-rules-store.md) | Ship the rules as a read-only database beside the app; a book keeps only its decisions | Proposed |

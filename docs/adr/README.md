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
| [0006](0006-local-single-user-auth.md) | Local accounts per install; no workspace concept | Accepted |

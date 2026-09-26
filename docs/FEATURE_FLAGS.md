# Feature flags

Written down in issue #296. The finding of the survey is simple: **Leabhar
deliberately has no feature-flag system, and none is wanted.** This page
records why, so the next contributor does not add one by reflex, and what to
do on the rare occasion a flag-like mechanism is genuinely needed.

## Why there are no flags

A feature flag is a way of shipping code the team does not trust to everyone
at once. Leabhar's deployment unit is a local install (ADR-0001): there is no
fleet to roll out to, no experiment population, and no way to remotely kill a
feature that misbehaves in a user's copy. A flag here would buy nothing and
cost the worst thing an accounting system can lose: a book that behaves
differently depending on an invisible switch, with figures that depend on a
flag's state rather than on the entries.

The other half of what flags usually do is already covered by the domain
model:

| What flags usually gate | How Leabhar does it instead |
|---|---|
| "Is this feature on?" | The code is on `main` only when it is done. Incomplete work stays on its branch. |
| "Which variant does this tenant get?" | Data, not code: configuration is effective-dated rows (`src/db/schema/config.ts`, ADR-0005), and what applies is resolved by date and company. |
| "Is this user in the beta?" | User *role* (`owner`/`user`/`readonly`, ADR-0006) — and it gates what a user may do, not hidden behaviour. |
| "Is this AI suggestion live?" | Provenance, not a flag: AI proposals carry `source`/`provenanceStatus` and never overwrite `user_confirmed` (AGENTS.md #8). |
| "Is this record finished?" | Its own status column (`review_status`, VAT period `status`) — a state of the data, not of the code. |

## The rule

Behaviour differences live in the data, where they are auditable, or they do
not exist. A row's status, a user's role, an effective-dated configuration:
these are visible, exportable and testable. A boolean in a settings file is
none of those.

## If a flag is ever genuinely needed

The bar: it must gate something a *person* turns on deliberately, per book,
and it must never affect the arithmetic. If cleared:

1. It is a **named row in the `settings` table** (`src/db/schema/config.ts`),
   not an environment variable and not a compile-time constant — the setting
   must survive an app update and be visible on the settings screen.
2. It is **read through one typed accessor** in the domain layer, so every
   consumer sees the same value and the default is written down once.
3. Its **default is the current behaviour**, so a fresh install and an
   existing book are unchanged until the person opts in.
4. It gets **an ADR** (`docs/adr/README.md`) stating what it gates, why it is
   not expressible as data, and the date it will be removed — a flag without
   a removal plan is permanent debt.
5. It never gates an accounting or VAT computation. A figure that depends on
   a flag is a figure that cannot be reproduced from the entries, which
   violates invariant #8.

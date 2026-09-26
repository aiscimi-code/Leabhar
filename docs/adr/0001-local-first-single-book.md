# 0001. One local book per install, no multi-tenant server

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

The README specifies a local-first accounting system: the books live on the
practitioner's own machine, not on a server the vendor controls. Leabhar also
serves a hosted marketing portal (`docs/PORTAL.md`) from the same codebase,
which invites the question of whether the server build should host many
businesses' books in one database.

Every domain table already carries a `companyId` column
(`src/db/schema/*.ts`), and every query already scopes by it.

## Decision

One install is one book. A single SQLite database on the local disk holds one
business's complete records; `companyId` on every row identifies the business
the row belongs to, and no query may read a row outside the active company.
There is no multi-tenant server model: the deployment unit is the desktop
install, not a shared service. The hosted deployment serves only the portal
and has no database at all (`src/middleware.ts` sends public-host traffic to
`/portal`).

`companyId` is kept on every table even though a book holds one business,
because it is the scoping key the whole query layer is written against, and
because a future multi-company install (one machine, several clients) is the
plausible next step — a *local* multi-book, still no server.

## Consequences

- No row-level tenant filtering, quota or billing logic in the domain layer.
  The domain never has to ask "whose data is this?" beyond the companyId it is
  handed.
- Backups (`src/domain/backup/backup.ts`) are per-book and self-contained:
  a backup restores the whole business, which is what a practitioner hands to
  a client or an auditor.
- Scaling is bounded by one business's ledger. SQLite with WAL and
  `synchronous = FULL` (`src/db/index.ts`) is comfortably inside that bound.
- The `companyId` column is not dead weight: it is load-bearing naming. Any
  "optimisation" that drops it breaks the invariant that every query is
  scoped, and would make the multi-company install harder later.

## Hosted version

The owner decided on 2026-09-26 that the desktop app comes first and a hosted
version comes later (AGENTS.md "Scope", #295). This ADR governs the desktop
app. A hosted version would be a new decision with its own ADR (tenancy,
isolation, where the books live), not a quiet relaxation of this one.

# 0006. Local single-user accounts; no workspace concept

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

The product is a local-first book used by one practitioner (README §3), but
"local-first" still needs a login: the machine may be shared, the portal may
need credentials, and the audit trail needs a name for who made a decision.
Team products introduce a *workspace* — a group of users with shared books and
per-user permissions — which is a second, multi-tenant-shaped concept on top
of the book.

## Decision

The unit of access is the install, and the unit of identity is a local user
row. `users` (`src/db/schema/operations.ts`) holds named accounts with a
role of `owner`, `user` or `readonly`, scrypt-hashed passwords, and `sessions`
holds server-side session records keyed by a token hash; the browser holds
only an httpOnly cookie. `src/domain/auth/auth.ts` verifies sessions against
the database, and `src/lib/session.ts` exposes `currentUser()`/`actorName()`
so decisions are audited under a person's name. Middleware
(`src/middleware.ts`) checks only cookie presence — it runs on the edge and
cannot see the database — and every server component and action re-verifies.

There is deliberately **no workspace concept**: no team, no shared book
between accounts, no invitation flow. All users of an install see the one
book (ADR-0001); `role` is the only differentiation, and it distinguishes
what a user may do, not what they may see.

## Consequences

- The audit trail has a real actor on every decision, which invariant
  #8 (provenance) needs.
- No workspace means no per-workspace permissions to design, test or break;
  `role` on a single user table is the entire authorisation model.
- Sharing a book means sharing the machine or a backup, not a URL. This is a
  real product limit, accepted for now; a future multi-practitioner model
  would be a new ADR superseding this one, and the `companyId` scoping from
  ADR-0001 is what keeps that door open.
- `readonly` users can read the books but cannot post; this is enforced in
  the actions layer and should be enforced at the domain boundary when a
  write path is callable from more than one surface.

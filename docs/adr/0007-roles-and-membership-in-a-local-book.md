# 0007. Roles and business membership within a local book

- **Status:** Accepted
- **Date:** 2026-09-26
- **Supersedes:** ADR-0006

## Context

ADR-0006 recorded three roles (`owner`, `user`, `readonly`) and no
invitation flow. EPIC 03 (#298) asks for the people who actually open a
business's books: an accountant, a bookkeeper, a director, an auditor, a farm
manager, an employee who only hands in receipts. The owner decided on
2026-09-26 that the app stays local-first (AGENTS.md "Scope"), so these are
people on one machine, not accounts on a server.

## Decision

A user's role is one of eight. What each role may do is one matrix of actions
to allowed roles in `src/domain/auth/permissions.ts`, and every surface
applies it:
- server actions through `requireActor` (`src/lib/session.ts`);
- the CLI through the same domain functions.

A `company_members` row says which users may open which company's books in
the database. "Invite" creates a local user with a one-time password that
they must replace. Removing a user deactivates them and ends their sessions;
the row stays, because the audit trail names it. Every invite, removal and
role change is written to `audit_events` in the same transaction. The full
design, and how each subtask reads locally, is `docs/ROLES.md`.

## Consequences

- Upgrading an existing book loses nobody access. Migration 0016 maps the old
  `user` role to `bookkeeper` and makes every active user a member of every
  company already in the book.
- The last owner can never be removed or demoted, and nobody can remove or
  re-role themselves.
- A role is an access decision inside a book, not a security boundary around
  the machine. Anyone with the database file can read it, so encryption at
  rest is a separate item (#342).
- Still no workspace concept: each business is its own book (ADR-0001). A
  hosted multi-user service would be a new ADR.

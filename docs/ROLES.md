# Users, roles and permissions (issue #298)

This is the design note the epic asked for, deciding what "users, roles and
permissions" means in a local-first product, and recording the permission
matrix the domain layer enforces.

## The decision: roles inside one local book

**Leabhar is local-first: each business is its own SQLite book on the user's
machine. Roles are people within one book — an accountant opening a client's
book, a bookkeeper doing the day-to-day work in it, an auditor inspecting it.
A hosted multi-user service (#275, #166) comes later; nothing here presumes a
server.**

Consequences, subtask by subtask:

| Epic subtask | What it means here |
|---|---|
| Business membership | A `company_members` row says which users may open which company's books in this database. The first user (the book's owner) is a member of every company, and each new company adds every active user. A book created before membership existed is backfilled by migration 0016: every active user becomes a member of every company already in it, so nobody loses access on upgrade. |
| Roles (director, accountant, bookkeeper, employee, farm manager, auditor, read-only) | Values on `users.role`, enforced by one matrix in `src/domain/auth/permissions.ts`. |
| Permission matrix | The table below. `src/domain/auth/permissions.ts` is the only place that decides who may do what; surfaces apply it. |
| Invite user | Local: `inviteUser` creates the user with a one-time password the invoker hands over out of band. There is no email to send, so there is no invitation to send either. |
| Remove user | Deactivate, delete every session, delete every membership. The user row stays because the audit trail names it. |
| Role changes | `changeUserRole`, recorded previous → new in `audit_events`, ending the user's sessions so the new role applies immediately. |
| Workspace isolation | Each business is its own book — a separate SQLite file, by the product's own setup. Inside one file, membership plus company scoping (below) keep companies apart. |
| Row-level security | There is no server to enforce database-level RLS, so it is read as **company scoping in the domain layer**: every domain path takes a `companyId` and filters by it, and `src/domain/auth/companyScoping.test.ts` proves no read or write path returns another company's rows. Database-level RLS belongs to the hosted version and is deferred. |
| Permission tests | Every cell of the matrix has a test (`permissions.test.ts`); the lifecycle has its own suite (`users.test.ts`, `src/cli/users.test.ts`). |

Two guards make the model safe to live in:

- **Owner continuity.** The book must always keep an active owner. Removing or
  demoting the last one is refused, not repaired — otherwise the only fix is
  editing the database by hand, and the audit trail would not describe it.
- **No self-service.** A user cannot remove themselves or change their own
  role; another owner must do it, which is what the audit trail is for.

## Roles

| Role | May |
|---|---|
| **owner** | Everything, including administering the book: its users, its company identity, its backups. The person whose machine it is. |
| **director** | Runs the business: everything accounting, but not user administration or backups. |
| **accountant** | Prepares accounts and returns: everything accounting including filing VAT and CT decisions, but not user administration. |
| **bookkeeper** | Day-to-day entry work: import, classify, match, post, reconcile, manage parties and rules. Does not file returns or change configuration. |
| **employee** | Submits receipts and documents, and reads the books. Changes nothing else. |
| **farm manager** | The bookkeeper's role, named for the farm case: records the farm's day-to-day transactions. |
| **auditor** | Reads everything including the audit trail, and exports. Changes nothing — which is what distinguishes it from read-only. |
| **read-only** | Views the books. Nothing else. |

## The permission matrix

One action per capability, not per screen. `can(role, action)` answers every
question; `permissions.test.ts` pins every cell.

| Action | Roles allowed |
|---|---|
| `books.read` | everyone |
| `audit.read` | owner, director, accountant, auditor |
| `reports.export` | owner, director, accountant, bookkeeper, farm_manager, auditor |
| `documents.ingest` | owner, director, accountant, bookkeeper, employee, farm_manager |
| `banking.import` | owner, director, accountant, bookkeeper, farm_manager |
| `banking.reconcile` | owner, director, accountant, bookkeeper, farm_manager |
| `transactions.classify` | owner, director, accountant, bookkeeper, farm_manager |
| `parties.manage` | owner, director, accountant, bookkeeper, farm_manager |
| `capital_goods.manage` | owner, director, accountant, bookkeeper, farm_manager |
| `ct.decisions` | owner, director, accountant |
| `documents.review` | owner, director, accountant, bookkeeper, farm_manager |
| `documents.post` | owner, director, accountant, bookkeeper, farm_manager |
| `invoices.manage` | owner, director, accountant, bookkeeper, farm_manager |
| `journals.post` | owner, director, accountant, bookkeeper |
| `vat.file` | owner, director, accountant |
| `config.manage` | owner, director, accountant |
| `rules.manage` | owner, director, accountant, bookkeeper, farm_manager |
| `company.manage` | owner, director |
| `backup.manage` | owner, director |
| `users.manage` | owner |

## Where it is enforced

- **Web UI** — every mutating server action starts with
  `requireActor('<action>')` (`src/lib/session.ts`), which checks three
  things: someone is signed in; they have replaced their one-time password; and
  their role permits the action on the company. A refusal reaches the user as
  the message the domain wrote, never as a silent failure.
- **CLI** — runs on the owner's machine against the owner's database file, so
  it acts as the book's active owner, but through the same domain functions,
  the same guards and the same audit trail (`src/agent/users.ts`):
  `list-users`, `list-roles`, `invite-user`, `remove-user`, `set-user-role`,
  `reset-user-password`. A role check that only existed behind a web login
  would not survive the first accountant who preferred the terminal.
- **A future MCP or API** — gets the matrix the same way, by calling the
  domain layer. That is why the matrix lives in `src/domain` and not in the
  app or the UI.

## What a role is not

A role is an access decision inside a book, not a security boundary around
the machine. Anyone with the database file can read it — SQLite has no
permissions to defer to — and the CLI acts as the active owner. What the
matrix does is keep the *books of account* honest about who changed what:
every invite, removal and role change lands in `audit_events` beside the
accounting entries it governs.

## Migration of existing books

Books created before this epic have `users.role` values of `owner`, `user` or
`readonly`. Migration `0015` maps `user` → `bookkeeper` (the old working role
and the new one mean the same practical access); `owner` and `readonly`
already mean what the new set means. The `must_change_password` column defaults
to false, so nobody is locked out by an upgrade.

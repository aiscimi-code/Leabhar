# 0002. A pure, UI-independent domain layer

- **Status:** Accepted
- **Date:** 2026-09-26 (recorded retroactively; decided at design time)

## Context

The system has three callers that must never disagree about a figure: the
Next.js web UI, the agent/CLI workflow (`src/agent/`, `src/cli/`), and the
test suite. A rule computed in a page component is invisible to the CLI; a
rule computed twice, once for the screen and once for the report, can drift.

## Decision

All accounting, VAT, matching and reporting logic lives in `src/domain/`, and
every function there takes a plain `AppDatabase` (`src/db/index.ts`) plus
plain arguments. The domain imports no Next.js, React or browser module, and
performs no I/O beyond the database it is handed. `src/app/` (pages, server
actions) and `src/agent/`/`src/cli/` are thin wrappers that call the same
functions. Pages render what the domain returns and never recompute a figure
(`src/lib/queries.ts` exists only to shape domain output for rendering), so
a report and the screen showing it cannot disagree.

## Consequences

- Tests run the real posting paths against an in-memory database
  (`src/db/testing.ts`) with no web server, which is why the financial
  invariants are testable deterministically.
- The CLI and the web UI are guaranteed-consistent by construction, not by
  discipline.
- UI conveniences (pagination, formatting) stay in `src/lib/`; the moment a
  helper needs to *decide* something about money or tax, it moves to
  `src/domain/`.
- The domain cannot reach for request context: anything it needs
  (the company, the actor) is passed in explicitly, which keeps functions
  honest about their inputs at the cost of slightly longer signatures.

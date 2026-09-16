# Contributing to Leabhar

Leabhar is a local-first accounting and tax-preparation system for a
small Irish limited company. It favours clarity, transparency and
deterministic accounting over feature quantity: every figure should be
traceable back to the original transaction and document. See the
[README](README.md) for the full design specification and
[`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md) for the design source of
truth — when the code and that document disagree, the code is wrong.

## Licence and the CLA

Leabhar is **dual-licensed**: AGPL-3.0-only for the community, plus a
separate commercial license. For that to stay valid, every contribution
must be licensed to the maintainer for dual licensing.

By contributing you agree to the terms in [CLA.md](CLA.md): your
contribution is licensed to Intleacht Research Limited under the
AGPL-3.0 and the commercial license. Every commit must carry a
`Signed-off-by` trailer (use `git commit -s`) affirming the Developer
Certificate of Origin. The pull request template has a checkbox to
confirm this — please tick it.

## Setup

You need **Node.js 22 LTS** or later. SQLite is a file on disk, so
there is no database server to install.

```bash
git clone https://github.com/aiscimi-code/Leabhar.git
cd Leabhar
npm install
cp .env.example .env        # optional; the defaults work
npm run db:migrate          # create the database
npm run db:seed             # optional: load the demo company
npm run dev                 # http://localhost:3000
```

### The `better-sqlite3` native binding

`better-sqlite3` is a native module. If `npm run dev` fails with
`Could not locate the bindings file`, the native binary was not built
for your Node version. Rebuild it:

```bash
npm rebuild better-sqlite3
```

This happens most often after switching Node versions or after a fresh
`npm install` on a different platform. If you use
[nvm](https://github.com/nvm-sh/nvm) (or
[nvm-windows](https://github.com/coreybutler/nvm-windows)), the
included `.nvmrc` pins the supported runtime — run `nvm use`.

## Before you commit

The project gates every change on two checks:

```bash
npm run typecheck && npm test
```

Run both before opening a pull request. A red `typecheck` or a failing
test is a blocker, not a trade-off.

## The one rule that matters most

**Financial logic needs a deterministic test. Never rely on an LLM for
arithmetic.** VAT calculations, currency conversion, invoice totals,
journal balancing, period assignment, P&L and balance-sheet figures,
duplicate detection — all of these must have tests with fixed inputs and
fixed expected outputs. If you add or change accounting logic, add or
update the deterministic test that proves it.

The accounting invariants the system holds are listed in
[`AGENTS.md`](AGENTS.md) under "Non-negotiables". Read them before
touching the domain layer.

## Where things live

```
src/domain/     accounting engine, VAT, matching, rules, extraction, reports
src/db/         schema, migrations, seed
src/app/        Next.js routes and server actions
src/components/ UI primitives
src/lib/        queries and formatting for the UI
```

Arithmetic belongs in `src/domain`. Pages render what the domain
returns; they never recompute a figure, so a report and the screen
showing it cannot disagree.

## Pull requests

- Keep changes focused. One concern per PR.
- Include tests for any accounting logic you touch (see above).
- Run `npm run typecheck && npm test` and make sure both pass.
- Sign off your commits (`git commit -s`).
- Tick the CLA checkbox on the PR template.

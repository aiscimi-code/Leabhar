# Testing conventions

Written down in issue #296. The suite (vitest, `npm test`; typecheck with
`npm run typecheck`) enforces the financial invariants — see AGENTS.md,
"Before committing": this is the only gate, so the tests are the gate.

## Rules that are not negotiable

1. **Financial logic gets a deterministic test. Never rely on an LLM for
   arithmetic.** A VAT computation is tested with exact integers in and
   exact integers out. Anything an LLM produced (extraction, matching,
   classification) is tested by feeding it recorded input and asserting on
   the deterministic parts — scoring, weighting, ordering — never by asking
   a model to check a figure.
2. **Tests run against the real schema.** `createTestDatabase()`
   (`src/db/testing.ts`) opens `:memory:` SQLite and applies the actual
   drizzle migrations from `drizzle/`. No hand-maintained test DDL exists,
   so tests cannot drift from production. Never create a test database any
   other way.
3. **Colocated files.** `foo.test.ts` sits next to `foo.ts`. Vitest includes
   `src/**/*.test.ts` and `tests/**/*.test.ts` only.
4. **Invariants are tested where they live.** The immutability, atomicity
   and integrity rules have dedicated suites
   (`src/domain/accounting/*.test.ts`), not incidental coverage.

## Shared fixtures (`src/db/testing.ts`)

Fixtures build on the domain's own setup functions rather than raw inserts,
so a fixture's data passes through the same validation as production data.

- `createTestDatabase()` — the in-memory book with real migrations. Every
  test starts here.
- `seedTestBook(options)` — the standard book for a test that needs a
  company ready to post: a company with its default chart of accounts, tax
  rates and VAT treatments (via `createCompany`, `src/domain/config/setup.ts`)
  plus one bank account, and financial-year/VAT periods for `[2025]`. Returns
  the ids and lookups a test actually uses:

  ```ts
  const book = seedTestBook();
  // book.db, book.companyId, book.accountsByCode, book.accountsByKey,
  // book.treatmentsByCode, book.ratesByCode, book.bankAccountId
  ```

- `insertTestBankTransaction(db, values)` — one bank transaction with plain
  import defaults; only company, account and signed amount are required
  (issue #189).

Add a fixture to `src/db/testing.ts` when the same setup appears in three or
more test files; until then, the setup stays in the test that exercises it.
A fixture takes required values plus `Partial` overrides, defaults to what an
import or the seed would produce, and returns ids — never whole row objects
that a test could mistake for the live table state.

## Style

- Assert on integers, not on formatted strings (`expect(invoice.vatMinor)
  .toBe(23_000)`, never `.toBe('€230.00')`).
- Prefer reading the posted `journal_lines` back from the database to
  checking a returned structure: the books are the thing under test.
- One behaviour per `it`, named as the behaviour ("posts debtors, income and
  VAT on the invoice basis"), not as the function.

## Property tests (`fast-check`, issue #597)

Example-based tests still own Revenue worked examples and specific error
strings. Property tests sit beside them (`foo.property.test.ts`) and state an
invariant that must hold for generated inputs:

```ts
import * as fc from 'fast-check';
fc.assert(fc.property(fc.integer({ min: 0, max: 100_000_000 }), (gross) => {
  expect(netFromGross(gross, 2300) + vatFromGross(gross, 2300)).toBe(gross);
}), { numRuns: 200 });
```

Keep `numRuns` modest on anything that opens a database (`seedTestBook`).
Do not replace an example-based test with a property test — #281's golden
figures still need exact reproduction.

First batch: `src/domain/money.property.test.ts`,
`src/domain/accounting/journal.property.test.ts`. Next, in that order: VAT
engine rounding, payroll net-pay, capital allowances.

## Performance budget (issue #288)

`src/domain/corporationTax/benchmark.test.ts` seeds seven years of books
(240 postings a year) and times `computeCorporationTax` and `computeIncomeTax`
for year 7, the figures the year-end page loads. Each must finish inside 5
seconds; the assertion guards against an order-of-magnitude regression, not a
few percent. Set `BENCH_LOG=<file>` to append the measured times.

Measured on the development container: corporation tax 241 ms for year 7 against
65 ms for year 1, and income tax 270 ms for year 7. Cost grows roughly with the
years computed, as the issue expected, and is far inside the budget, so there is
no cache. Add one (keyed on the company, the period and its inputs, never
persisted) only if this test starts to fail.

## Playwright smoke (issue #283)

Chromium smoke for screens that previously had no browser coverage:

```bash
npx playwright install chrome   # once, if needed
npm run test:e2e:smoke
```

`tests/e2e/year-end-partners.smoke.spec.ts` logs in, loads each demo variant
(company, sole trader, partnership), opens `/reports/year-end` and
`/settings/company`, records one CT decision, adds a partner and changes a
share, and downloads the year-end export. The suite uses `data/e2e/` as its
database (gitignored) and starts `next dev` via Playwright's `webServer`.


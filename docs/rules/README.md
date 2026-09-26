# Rule coverage matrix (#204)

`coverage-matrix.json` has one row per:

- VATCA 2010 section: all 125 as enacted, plus the inserted sections in
  `docs/statutes/vatca-2010-revised/` (91A–91J, 92A–92D, 108A–108C);
- paragraph of Schedules 1–6, and Part of Schedule 9;
- VAT treatment code;
- TCA 1997 section in scope for #211, #212 and #213;
- Companies Act 2014 provision in scope for #214;
- common transaction type;
- other source that a derived rule cites (Finance Act 2024, S.I.s, Revenue TDMs).

Each row has exactly one status:

| status | carries |
|---|---|
| `rule` | `ruleKeys`: the derived rules that cover it |
| `not_applicable` | `reason`, e.g. "procedure or administration — not a transaction classification" |
| `deferred` | `reason` and `issue`: the issue that will cover it |

`src/domain/rules/coverage.test.ts` fails when:

- a row has no status;
- a row that a source defines is missing (section and paragraph rows are read
  from the statute files, not typed by hand);
- a `rule` row names a rule key the knowledge base does not derive;
- a derived rule is in no row;
- a treatment is marked `rule` but no rule binding can produce it.

It prints counts by status for each area on every run.

A rule issue (#205–#214, #245) closes only when its rows are `rule` or a
justified `not_applicable`. When a rule is added, update its row; the test
fails until you do.

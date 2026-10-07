# Handoff: rules store and next work

Written 2026-10-07 for the next agent. It is committed only on
`claude/sharp-ritchie-siug4j`, never meant for `main`: read it, then delete it
in your first commit so it does not reach a PR.

## Where things stand

- **Repo:** `aiscimi-code/Leabhar`.
- **Branch:** `claude/sharp-ritchie-siug4j` is `origin/main` at `5f3abda` plus
  the commit that adds this file. Every earlier PR from it is merged, so new
  work starts from here.
- **Open PRs from this work:** none.
- **Scheduled check-ins and PR watches:** none.

### Rules registry: ADR-0020, delivered by ADR-0021

- **Epic:** #686. The step-11 audit is #718. The plan is
  `docs/adr/0021-install-level-rules-store.md`, in its "Delivery" section.
- **Merged:** #719, #720, #721, #722, #724, #725 and #726.
  - Steps 1–4 of the ADR-0021 delivery are done.
  - #723 (the rule test cases now ship in the store) is closed.
- **Left:**
  - **Step 5:** one release after step 4 ships, drop the copied rule tables
    in each book where `rules_store_seen` is not empty. This waits for a
    release. Don't start it until the user says a release has gone out.
  - **#727:** the generated rule test cases are weak.
    - Each case is a transaction dated the day before a version takes effect,
      with `{matches:false}` expected.
    - The lookup infers topics from the transaction's contents, so many of
      these cases pass trivially.
    - No case checks that a rule applies.
    - The fix is a generator that builds, for each rule, a transaction that
      matches its conditions and topic. Then the "applies on its start date"
      case can come back.
    - The "Limitations" section of `docs/RULES_KB.md` records this.
  - Keep #718 and #686 open until step 5 is done.

### How the store works (key files)

- `rules/rules.db` is built by `npm run rules:build` (`scripts/rules-build.ts`,
  `src/domain/rules/rulesStore.ts`).
  - Each book attaches it read-only as schema `rules`.
  - A local `rules.db` built before #726 has no test cases. Rebuild it.
- **Readers** go through the `visible_irish_*` views (`visibleRules.ts`).
  - Each row has an `origin`: `'store'`, or `'retained'` for versions frozen in
    the book.
  - Don't read the store's tables or the book's copied tables directly.
- **Version ID** is `key@version`, using the catalogue's numbering. The
  `irish_rule_version_map` table maps a book's old numbers to it
  (`rulesStoreMigration.ts`).
- **Update check at book open:** `checkRulesStoreUpdate` (`rulesStoreUpdate.ts`)
  implements ADR-0021 §5.
- **Test cases:** `testCases.ts` (`generateDefaultTestCases`, `runTestCases`,
  which compares `ruleId === rule.id`).
  - The CLI is `npm run cli:rules -- test`. On the full store it takes about
    14s and reports 391 of 391 passing.
  - `generate-tests` does nothing now.
- Test cases are not part of `ruleVersionContentHash`, so changing them does
  not trip the released-versions check.

## Suggested next work, in order

The user has not chosen yet. Ask, or start from the top.

1. **Re-check #698 and #700 against the store.** Both are about books that
   loaded their rules before the catalogue port:
   - #698: the LRC footnote dates are lost, so
     `vat.distance_sales_goods_eu_consumers` moves to 2010.
   - #700: the provision viewer shows "File missing".

   Books now read rules from the store, so both may already be fixed. Prove it
   with a test or a reproduction, then close the issue with that evidence, or
   fix it.
2. **#711 (likely a wrong figure today).** The PRSI Class S rate and minimum
   are dated from the retrieval date. The 4.2% rate is still open-ended after
   the 1 October 2026 rise.
3. **#709, #705.** Two small catalogue corrections:
   - #709: a start date was taken from the manual's revision date.
   - #705: S.I. 156/2012 regulations 3 and 5–9 are not ingested.
4. **#727.** The rule test cases, described above.
5. **#611 (high severity, larger).** The VAT tax point should follow the supply
   date over the invoice date (s.74(1)(a)), and acquisitions ignore the s.75
   15th-day rule. This changes which period VAT lands in, so it needs careful
   tests.

Other open rule-ingestion defects: #698–#704 and #556 (the migration ledger).

## The user's working rules

- **Branch:** develop and push only on `claude/sharp-ritchie-siug4j`.
  - Never force-push.
  - If its PR has merged, restart the branch from `origin/main`.
- **One PR per step.**
  - Open a PR only when the user says "open pr" or "go" to opening one.
  - Merge only when the user says "merge". The user sometimes merges it
    themselves.
- **Report every problem.** If you find a problem and don't fix it, open a
  GitHub issue, or comment on the existing one, before you report. Never
  leave it only in chat.
- **Gate before every push**, after merging `origin/main`:
  `npm run typecheck && npm test`.
  - Also run `npx next build` if `src/app` or `src/components` changed.
  - No CI runs on PRs. Report the gate result in the PR body, and leave the
    CLA and DCO boxes unticked.
- **Follow `AGENTS.md` and `docs/REVIEWING.md`.**
  - Nothing is silently repaired; a detected problem becomes a review item.
  - Never edit an accepted ADR; add a new one.
  - Keep CRLF files CRLF.
  - Rule relationships are declared as links, never kept only in code.
- **Out of scope:** practice-authored rules.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <your session URL>
  ```
  - Never put a model ID anywhere else in a commit or PR.
- **PR body ending:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  a blank line, then the session URL.
- **GitHub comments** end with `---` and then
  `_Generated by [Claude Code](https://claude.ai/code)_`.
- **Style:** the user prefers short, plain answers: what was done, what wasn't,
  and what's next.

## Known quirks

- The GitHub MCP server sometimes returns 500 on `issue_write create`.
  - Before retrying, check that the issue wasn't created, so you don't make a
    duplicate.
  - It worked on a later attempt.
- `mergeable_state` from `pull_request_read` can be stale right after a merge.
  Fetch `origin/main` to confirm.
- CLI tests that run `irish-rules test` need a 60s timeout and a seeded scratch
  data root (see `src/cli/irishRules.test.ts`).

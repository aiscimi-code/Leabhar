# Reviewing your own change before the PR

Run this checklist before opening or updating a pull request, after the gate in
AGENTS.md passes. Each item comes from rework found in review (PRs #426–#468);
the example after each one is the case that prompted it. Most of those fixes
were one or two lines. The cost was finding them later.

## 1. Bring the branch up to date first

- [ ] Fetch and merge the latest `main` **before** generating a migration,
      numbering an ADR or running the gate. Parallel branches otherwise reuse
      the same number (migrations `0029` and `0033`, ADR `0011` were each
      taken twice) and conflict on shared files.
- [ ] Generate migrations with `npx drizzle-kit generate` on the merged tree.
      Never renumber or edit one by hand.
- [ ] Run the gate on the merged state. Delete `.next` if it was built from
      another branch, so stale route types do not fail the typecheck.
- [ ] Fetch again just before opening the PR. Another agent may have merged
      in the meantime.

## 2. Never state what the books cannot know

- [ ] A `??` fallback must supply the **same fact** from another place, never
      a different fact. When the value is missing, return null and let the gap
      show. (#436 offered the document matched to a bank line as an invoice's
      VAT evidence.)
- [ ] Words matter: "due", not "paid", when only the obligation is known.
      (#459.)
- [ ] A rule whose deciding fact is not on the line **flags**; it never
      decides a treatment, rate or amount. A keyword is a proxy, not a fact.
      (#434's s.48 rule put 13.5% on anything mentioning "ceramic".)
- [ ] "The source says nothing about X" is not "the law has no X". Check what
      the source covers before relying on its silence. (#461's Part 11 notes
      cover ss.373–380 only, not the emissions rules in Chapter 1A.)
- [ ] A choice the law leaves to the person (an election, a claim, an amount
      from outside the books) is recorded as their decision. It is never
      assumed. If it cannot be decided now, flag it and open an issue. (#467.)

## 3. Test the invariant, not the output

- [ ] Every posting path has a lifecycle test that ends with the control
      accounts back at their expected balance. For example: create, approve and
      reimburse a claim, then assert the payable account is zero. (#426's
      private share left Staff expenses payable with a balance nobody was owed.)
- [ ] A statement or report asserts it closes at the ledger balance it
      summarises, such as a party's share of debtors or creditors. That catches
      a missing entry kind. (A shortfall written off was missing from the
      customer statement.)
- [ ] Before writing an expected value, ask whether the test states what the
      law or the invariant requires, or only what the code currently does.
      (A test asserted that corporation tax *used* a rule a person had
      rejected.)
- [ ] Cover boundaries across more than one period: a loss one year and a
      claim the next; a later-dated entry that changes an earlier check.

## 4. Check the preconditions you rely on

- [ ] If code depends on a condition, check the condition before relying on
      it. (#465's rounding residue assumed shares totalled 100%; when they did
      not, the missing share went silently to the precedent partner.)
- [ ] Read the provision's limits literally. (s.381 relieves the year's own
      loss, not losses brought forward from earlier years; #459.)

## 5. Validate every id and date

- [ ] Every id a caller supplies is checked: it belongs to this company, and
      it is the right kind of record. (A loan's money account, a claimant who
      was not a member of the company.)
- [ ] A check made "as at a date" also considers entries dated after it.
      (#465's back-dated loan repayment was checked against that day's balance
      only.) A default date never falls before the entry it follows. (A
      reversal defaulted to a date before the entry it reversed.)
- [ ] A rule like "never delete X while something uses it" is derived from the
      schema: grep every `.references(() => x.id)`. Never list the tables
      from memory. (#433 missed invoices, fixed assets and expense claims.)

## 6. Follow the neighbouring code's conventions

- [ ] Before writing a route, server action or posting path, open two existing
      ones and copy their checks. Routes and actions use
      `requireActor(action)`, which checks company membership and permission,
      never `currentUser()` alone. (#468; #372 tracks the older gaps.)
- [ ] A policy that applies in several computations is written once, in one
      helper, and documented. (Corporation tax, income tax and the cash-basis
      test each handled a rejected rule differently; #451.)
- [ ] Money is integer minor units, posted journals are never edited, and a
      path that posts more than one thing runs inside `atomically`. These are
      AGENTS.md's non-negotiables, and the review checks them.

## 7. Link the issues so they close

- [ ] Write one `Closes #N` for every issue the PR finishes, **including the
      epic**. GitHub closes nothing that is not named after a keyword. (Five
      epics stayed open because PRs named only their sub-issues.)
- [ ] Put a keyword before **each** number. "Also closes #276, and #418,
      #419" closes only #276.

## 8. Say what is not done

- [ ] Every open question becomes an issue, with the options and a
      recommendation, linked from the PR. A doubt in the PR description alone
      is lost at merge.
- [ ] The PR description reports the gate's result on the merged head: the
      test count and whether the build ran.

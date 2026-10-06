# 0020. Keep the statutory rules in one registry, with stable keys, typed links and shipped review

- **Status:** Proposed
- **Date:** 2026-10-06

## Context

The statutory rules replace a tax adviser's knowledge of Irish law. A rule that
is wrong, out of date, or silently depends on another rule that changed makes
every figure built on it wrong. The rules must be easy to look up, to update,
and to trace in both directions: what a rule relies on, and what relies on it.

A review of `src/domain/rules/` (October 2026) found the rules themselves well
governed: verbatim quotes against hashed sources, effective-dated versions that
supersede and never edit (ADR-0005), a review lifecycle, a coverage matrix
(`docs/rules/coverage-matrix.json`) and provenance tests. The links between
rules are not:

- **Only citations are stored as data.** `irish_tax_rules.crossReferences` is a
  list of free-text strings ("Taxes Consolidation Act 1997 s.472BB(3)"),
  resolved at read time by regex aliases (`dependencies.ts`). It records that a
  provision cites another, not that a rule relies on another. About 440 do not
  resolve.
- **The real rule-to-rule links live in TypeScript**, where no query can find
  them: `silencedBy` (`advisoryRules.ts`), `rateRefs` from a Schedule 3 rule to
  s.46 (`vatcaScheduleParagraphRules.ts`, `scheduleRates.ts`), the VAT-rate
  exclusivity group (`transactionLookup.ts`), and the rule keys each
  computation reads by string (about 55 in `corporationTax/computation.ts`, 27
  in `incomeTax/computation.ts`, 26 in `payroll/compute.ts`). No list says which
  computations read `ct.rate_standard`, so the effect of superseding or
  rejecting it cannot be queried.
- **Figures are kept in more than one place.** `config/vatTreatments.ts` seeds
  23%, 13.5%, 4.8%, 12.5% and 25%; `extraction/invoiceParser.ts` has its own
  list of known rates; `assets/register.ts` defaults the capital allowance rate
  to 12.5%; each curated constant is also a fallback beside its database row
  (`ruleFigures.ts`). Only the VAT rates are synchronised (`taxRateSync.ts`).
- **Review happens per book.** `irish_tax_rules.companyId` is required, so a
  rule's approval is stored in one business's book. Every rule ships
  `ai_extracted`; an expert's approval is never shipped, and each user would
  have to approve the law for themselves.
- **One predecessor per version cannot record what Finance Acts do**: split one
  rule into two (supplies moved out of the 13.5% rate to the 9% rate, issue
  #129), merge two into one, or keep an old rule for existing contracts under
  a transitional provision.
- **What was applied is recorded by key, not version.** `invoice_lines.vat_rule_keys`
  names the rule key; it cannot say which version of the rule applied.

Issue #293, with #443 and #556, has already decided that rules ship as a
committed data catalogue (URL, locator, excerpt) and are no longer derived from
`docs/statutes/` at run time. This ADR decides what that catalogue and the
runtime store must carry so dependencies are first-class. It does not reopen
#293.

Alternatives considered and declined:

- **An opaque ID per version (`vat1234` → `vat4321`), linked by a predecessor
  field.** Everything pointing at `vat1234` would keep pointing at the old
  version after a change, and every dependent would need editing. A reviewer
  also cannot see that `vat1234` is the reduced rate.
- **A JSON list of dependencies in a column on the rule.** It cannot enforce
  that the target exists, and "what depends on X" means scanning every row.
- **A graph database.** A few thousand rules and links are easy for SQLite with
  recursive queries, and a server-backed store contradicts ADR-0001.
- **Editing rules directly in a database.** It loses the git diff, the review of
  that diff, and the tests that run against it, which are what keep the rules
  accurate.

## Decision

The statutory rules form one registry with the following structure.

1. **Two identifiers.** The rule key (`vat.rate_reduced`, the existing
   `ruleKey`) is stable for the life of the rule and is what links, code and
   coverage rows name. The version ID (`vat.rate_reduced@3`: key plus
   `ruleVersion`) identifies one dated version, and is what a posting, a line
   or a return records as applied. A lookup is always key + date → the version
   in force on that date. Keys stay readable, dotted and prefixed by tax head.
2. **One rules table**, `irish_tax_rules`, holding every version of every rule.
   A rule may belong to more than one tax head (import VAT is `vat` and
   `customs`), so tax heads are a list, not a single column.
3. **One links table**, `irish_rule_links`, for every relationship between
   rules: `from_key`, `to_key` (or `to_provision_id` for a citation),
   `kind`, `effective_from`, `effective_to`, `note`, plus the shared provenance
   columns. The kinds are a closed list: `uses_value`, `rate_from`,
   `silenced_by`, `excludes`, `supersedes`, `cites`. Supersession is a link, so
   splits, merges and partial replacement are recorded; `supersedesRuleId`
   remains only as a consistency-checked shortcut for the one-to-one case. A
   relationship that exists only in code is a bug.
4. **Consumers are declared.** Each computation that reads rules exports a
   manifest of the keys it reads, and `resolveRuleFigure` accepts only a key
   from the caller's manifest (checked by the type system and by a test). The
   manifests are loaded as `consumed_by` entries, so "what is affected if this
   rule changes" includes the computations and returns, not only other rules.
5. **The graph is checked by tests.** The gate fails on a link to a key that
   does not exist; an in-force rule that relies on a key with no version in
   force over the same dates; a gap or an overlap in one key's versions; a
   cycle; and a figure in configuration or code that differs from the rule it
   copies.
6. **Rules are jurisdiction data, not company data.** The catalogue (#293)
   carries the rules, the links and the expert review (who approved each
   version, when, and against which source hash). It is loaded into a
   read-only rules store at install level, not copied into each book. A book
   keeps only its own decisions about a rule version (accept, reject, with a
   reason, as today) and the version IDs it applied. A book opened against a
   catalogue that lacks a version it references raises a review item; it never
   resolves a different version silently (AGENTS.md #7).
7. **A rule change is traced before it ships.** When a source drifts or a new
   Act amends a provision, the impact query lists every rule and computation
   that relies on it, directly or through other rules. Each one is re-confirmed
   or superseded before the catalogue is released, and books receive the
   affected keys as review items.
8. **An LLM may propose, never select.** A model may suggest a topic or explain
   a rule. The rule that applies and every figure taken from it come from the
   deterministic lookup, and a person confirms the result.

## Consequences

- "What does this rule rely on?" and "what relies on this rule?" become single
  queries, from the CLI, the rule page and the audit report. The dependencies
  that today exist only in code become data a reviewer can read.
- A Finance Act change becomes a traced change: the impact list is the review
  checklist, and nothing downstream of a changed figure can be missed by
  accident.
- Expert review is done once and shipped. A business's own decisions remain
  its own, and remain on record.
- Every posting can say exactly which version of which rule it used.
- **Cost:** every new rule needs its links written, and every computation needs
  its manifest kept current; the tests make forgetting fail rather than pass.
  The migration touches the schema, the catalogue format (#443), the loader,
  `ruleFigures.ts`, every computation that reads rules, and the per-book review
  data, which must be carried across without losing a decision. It is
  sequenced in its own issue so each step ships and passes the gate alone.
- **Cost:** a book now depends on an install-level rules store. The book stays
  self-describing through the version IDs and figures it snapshots
  (ADR-0005), but full explanation of an old entry needs a catalogue that still
  contains that version, so catalogue releases never drop a version.
- **Forbidden:** a rule-to-rule relationship expressed only in code; a
  computation reading a rule key it has not declared; a figure copied out of a
  rule without a test tying it back; recording an applied rule by key alone.

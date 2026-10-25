# 0022. Model statutory knowledge bitemporally and contract the evaluation of rules

- **Status:** Proposed
- **Date:** 2026-10-25

## Context

Issue #771 (https://github.com/aiscimi-code/Leabhar/issues/771) asks
Leabhar to ingest statutory knowledge — Acts, SIs, Revenue guidance —
and to answer two questions a single timeline cannot answer:

1. **What did the law say on legal date Y?** Valid time. ADR-0005
   already answered this for configuration: effective-dated rows,
   never overwritten. The knowledge base carries the same pair —
   `effective_from`/`effective_to` (via `effectiveDates` in
   `src/db/schema/_shared.ts`) — on `irish_knowledge_sources`,
   `irish_act_provisions` and `irish_tax_rules`, and
   `transactionLookup.ts` resolves rules as of the transaction's own
   date. **What did Leabhar believe on system date Z, about what
   applied on date Y?** Knowledge time. Nothing today records this.
   A retrospective amendment — a Finance Act passed in December that
   changes the VAT treatment of a supply made in March — is
   indistinguishable from an ordinary update: the row that was
   correct for March is replaced, and a figure computed in June
   cannot be explained by the knowledge that existed in June. The
   audit question "what did your system say in June about this
   March supply?" is unanswerable.

The same review found the pipeline's other contracts under-specified:

- **Amendment is unstructured.** `irish_act_provisions.amendsSection`
  and `effectiveClue` are free text. The stage4 VATCA extraction
  (provision schema v2.0, `provision-schema.json`) already separates
  F-tag amendment annotations from body text and derives
  `effective_from`/`effective_to` from them — but the amendment
  *operation* (insert, substitute, repeal, commence, transition,
  renumber) is still only a string inside an annotation, not a value
  a query can filter on.
- **Condition evaluation is two-valued.** `conditionEval.ts` returns
  `{ passed: boolean }`, and a missing fact returns `passed: false`
  (lines 40–42). For a statutory rule this collapses two legally
  different situations: "the transaction has no VAT registration
  number" (fact absent — *we do not know*) and "the transaction is
  explicitly not VAT-registered" (fact present, condition fails —
  *no*). Today both look identical to the caller, and
  `transactionLookup.ts` reports both as an ordinary non-match.
- **Rule kinds are not execution contracts.** `IRISH_RULE_TYPES`
  (`src/db/schema/irishRules.ts`: deductibility, rate, threshold,
  relief, exemption, definition, procedure, reporting, other)
  describe what a rule is *about*. Nothing says what an evaluator
  must *do* with one, and nothing stops a lookup from returning a
  half-evaluated rule as if it applied.
- **Confidence is a boolean plus a flag.** `TransactionLookupResult`
  carries `applicableRules`, `unresolvedFields` and
  `reviewRequired`. There is no machine-readable statement of *why*
  a result is not fully determined, and no distinction between "no
  rule was in force on that date" and "rules matched but conflict".

Alternatives considered and declined:

- **Valid time only (status quo).** Cheaper — no new columns —
  but it cannot answer the audit question, and it silently rewrites
  what a past computation was based on. This is the failure mode
  ADR-0005 already forbids for configuration, extended to the rules
  that feed it.
- **A separate "as known at" snapshot table.** Every query would
  join two tables and reconcile them; the bitemporal pair on the
  same row keeps one row per fact-version.
- **Deriving amendment operations at query time from
  `amendsSection` text.** Parsing free text at read time is what
  produced the unstructured columns in the first place; the
  operation belongs on the row that records the amendment.
- **Keeping two-valued logic and encoding "unknown" as a separate
  rule outcome.** The evaluator would still be lying about why it
  failed, and every caller would re-implement the distinction. The
  fix belongs in `conditionEval.ts`, which both engines already
  share.

## Decision

### 1. Bitemporal storage: valid time and knowledge time on the same row

Every dated knowledge row carries two independent time axes:

- **Valid time** — when the law applies: the existing
  `effective_from`/`effective_to` pair (ADR-0005). Unchanged.
- **Knowledge time** — when Leabhar learned about it: a new
  `knowledge_from`/`knowledge_to` pair (same shape as
  `effectiveDates`, nullable end, null == still the current belief)
  on the knowledge tables.

The seed of knowledge time already exists:
`irish_knowledge_sources.retrievedAt` becomes `knowledge_from` for
the source, and propagates to the provisions and rules derived from
it. A rule amended by a later Act gets a new version row (ADR-0020
§1) whose `knowledge_from` is the amendment's ingestion date; its
`effective_from` is the date the amendment takes legal effect, which
may be earlier.

The query the model answers is: *the row where `effective_from <= Y <= effective_to` and `knowledge_from <= Z <= knowledge_to`.* A retrospective amendment changes valid time for the past; knowledge time records when we learned it.

**Knowledge time never edits valid time** — the two columns are written by different events (a legal change vs. an ingestion) and no code path writes one from the other.

The provision-level contract is the stage4 provision schema v2.0
(`provision-schema.json`): `provision_id`, `instrument_id`,
`hierarchy`, `text`, `source` (with `instrument_sha256` and
character/line offsets), `annotations`, `cross_references`,
`amendment_notes`, `effective_from`/`effective_to`,
`effective_provenance`, `extraction`. This ADR extends that schema
with three fields — `knowledge_from`/`knowledge_to` (axis two),
`normalised_hash` (§6), `amendment_operation` (§2) — and adopts the
rest of v2.0 unchanged.

### 2. Amendment operations are a closed enum

A new column `amendment_operation` on `irish_act_provisions`,
replacing the unstructured pair `amendsSection` / `effectiveClue` as
the queryable record (both columns remain as the verbatim evidence
the enum was parsed from — the enum is derived, never invented):

```
insert      -- the provision is new text inserted into a principal Act
substitute  -- the provision replaces existing text of a cited section
repeal      -- the provision removes a cited section or instrument
commence    -- the provision brings a cited provision into force (an SI
              commencement order records the SI here)
transition  -- the provision applies only to situations existing before a
              date (existing contracts, grandfathered treatment)
renumber    -- the provision renumbers a cited section without changing it
none        -- the provision operates on its own instrument (default)
```

The mapping to the stage4 schema: `amendment_notes[]` already
carries F-tag markers with `action` strings ("inserted",
"substituted", "deleted", "repealed"); `amendment_operation` is the
normalised, closed-enum form of those actions, one value per
provision row, so "every provision that substituted text in TCA 1997"
is one indexed query instead of a text scan. Commencement orders
record the commencing SI on the provision it commences; a
`transition` provision carries its applicability window in
`effective_from`/`effective_to`, so a lookup can exclude it for
post-cutoff situations.

### 3. Rule types map to three execution contracts

`IRISH_RULE_TYPES` stays as the topical classification. Execution
behaviour is a separate, smaller axis — every rule type maps to
exactly one execution class:

- **`lookup`** (typically `rate`, `threshold`, `definition`):
  deterministic fact retrieval. Evaluates its conditions; if all are
  `true`, returns its figure/effect. **Never returns `unknown`** — a
  `lookup` rule with an `unknown` condition is a data defect, surfaced
  as `incomplete` at the `evaluate` level (§4), never silently
  defaulted.
- **`conditional`** (typically `deductibility`, `relief`,
  `exemption`, `procedure`, `reporting`): evaluates conditions; if
  any condition is `unknown`, the rule's result is `incomplete`
  (§4) and the missing fields are listed in `unresolvedItems`.
- **`judgement`** (typically `other` where the provision's wording
  leaves a matter to the person's circumstances): returns
  `requires_judgement` and is never auto-applied, whatever the
  facts. `humanReviewRequired` on the rule row (already in the
  schema) is the stored form of this.

`evaluate` returns one result shape:

```
{ appliedRules: RuleRef[], unresolvedItems: string[], confidenceClass: ConfidenceClass }
```

### 4. Confidence class is a closed enum

One field replaces the current `reviewRequired: boolean` +
`unresolvedFields: string[]` pair as the machine-readable outcome:

```
applied            -- at least one rule matched, all its conditions true,
                      no conflict
ambiguous          -- multiple rules matched with conflicting results
incomplete         -- some conditions unknown (missing facts); the fields
                      are named in unresolvedItems
requires_judgement -- a judgement rule matched; a human must decide
unsupported_date   -- no rule in force for the queried date
```

`applied` and `ambiguous` are distinguished by comparing the
matched rules' effects; `unsupported_date` is what an empty candidate
set means (today it is silently a non-match, indistinguishable from a
rule that failed its conditions). The existing
`TransactionLookupResult` fields stay as the human-readable rendering
of this enum, not a second source of truth.

### 5. Three-valued condition logic, plus `invalid`

`conditionEval.ts` (shared by `engine.ts` and
`transactionLookup.ts`) changes its result from `passed: boolean` to
a four-valued outcome:

```
true     -- fact present, condition met
false    -- fact present, condition not met
unknown  -- fact missing (absent from the subject). Distinct from false.
invalid  -- fact present but the wrong type/format (a string where
            a number was required, an unparseable date)
```

The change is at the shared evaluator, so both engines get the
same semantics; `engine.ts`'s `passed: boolean` consumers keep
working by treating `unknown` and `invalid` as not-passed, and the
statutory engine reads the full four values. The defect being
fixed: today `raw === null || raw === undefined` returns
`passed: false` (lines 40–42), and a non-numeric value in a numeric
comparison returns `passed: false` (lines 47–49) — both must become
`unknown` and `invalid` respectively. **A missing fact is
`unknown`, never `false`**: "the system does not know" and "the
condition fails" produce different confidence classes
(`incomplete` vs. a clean non-match) and different review items.

### 6. Four hashing layers, each with one job

- **Source hash** — SHA-256 of the ingested bytes. Exists:
  `irish_knowledge_sources.sha256`. Detects document drift.
- **Normalised provision hash** — NEW: `normalised_hash` on
  provisions. The SHA-256 of the normalised provision record (the
  stage4 schema's `text` plus hierarchy, without offsets that shift
  on re-extraction). Distinct from the file hash: it detects
  *provision-level* change when a re-extraction of the same
  instrument re-slices it, which a file hash cannot see.
- **Rule content hash** — exists (ADR-0020;
  `catalogue/released-versions.json` and
  `rules_store_seen.version_hashes` in ADR-0021 §3). Covers what a
  rule version says, never its review.
- **Release manifest hash** — NEW: one digest over the full ruleset
  — every `key@version` content hash plus every dependency (provision
  normalised hash, source hash) it was derived from. `rulesStoreSeen`
  records it; a store whose manifest hash differs from the book's
  last-seen one triggers the ADR-0021 §5 update check. A release
  manifest **never drops a version** (append-only).

### 7. Invariants

Stated here as the contract later deliverables implement; the gate
tests them:

1. A release manifest never drops a version (append-only).
2. A material content change invalidates approval: a rule whose
   content hash changes is no longer `approved`; the review
   lifecycle restarts.
3. Knowledge time never edits valid time.
4. Guidance never outranks legislation — the existing
   `sourceAuthorityRank` (`src/domain/rules/sourceHierarchy.ts`) is
   the only place the ordering is decided, and it is never
   duplicated as a stored column.
5. An `ai_extracted` rule cannot become `active` without
   `human_review` → `approved` (`IRISH_RULE_REVIEW_STATUSES`,
   already in the schema).

## Consequences

- The audit question is answerable: "what did Leabhar believe on
  system date Z about legal date Y" is one SQL query with two date
  predicates, and a figure computed in June about a March supply can
  be reproduced or shown to have been wrong under June's knowledge.
- **Cost:** new columns across the knowledge tables and the stage4
  provision schema, plus a migration that backfills `knowledge_from`
  from `retrievedAt` and `createdAt`. The derive pipeline and the
  store build (ADR-0021 §1) are the only writers, so the change is
  contained.
- **Cost:** `conditionEval.ts` is shared with the coding-rules
  engine. The four-valued result is a breaking change to
  `ConditionResult`; existing consumers are migrated in the same
  change. The behavioural difference for coding rules is limited to
  conditions referencing fields the transaction does not carry —
  those now say "unknown" instead of "false", surfacing as a review
  item rather than a silent non-match.
- **Cost:** the confidence enum replaces a boolean callers already
  read. `reviewRequired` remains as a derived convenience
  (`confidenceClass !== 'applied'`), but new code must read the
  enum.
- **Cost:** `amendment_operation` is derived data — it can disagree
  with the verbatim `amendsSection`/`effectiveClue` it was parsed
  from. The text columns stay as evidence; a test asserts the enum
  is consistent with the F-tag annotations in the stage4 records.
- **Forbidden:** editing `effective_from`/`effective_to` to record
  when something was learned; returning `false` for a missing fact;
  a `lookup` rule returning `unknown`; a judgement rule
  auto-applying; a release that drops a `key@version`; an approval
  surviving a content-hash change.

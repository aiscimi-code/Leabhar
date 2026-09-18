# Irish rules knowledge base

A structured, versioned, source-linked knowledge base for Irish accounting/tax
statutes and guidance, and a deterministic lookup engine that maps a
transaction to the rules that apply to it. The immediate source is the
Finance Act 2024 (2024 Act 43), ingested from
`docs/statutes/2024-act-43/2024-act-43-enacted.md`.

This is not a RAG system and it does not ask an LLM what the tax treatment
should be. The pipeline is:

```
source document -> parser -> provision extraction -> structured rule
extraction -> rule database -> deterministic lookup -> transaction context ->
applicable rules -> accounting/tax/VAT treatment -> (LLM explanation, if
useful) -> user confirmation
```

An LLM may assist extraction and explanation later; nothing in the lookup
path depends on one, and none of the code shipped here calls one. Every
number a rule states is a token the parser found in the source text, not a
model's claim.

## Architecture assessment

Before adding anything, the existing codebase was inspected for something to
extend rather than duplicate:

- **`src/domain/rules/engine.ts`** already implements a deterministic,
  data-driven rules engine — conditions and actions stored as JSON, evaluated
  against a bank-transaction "subject", confirmed rules outranking AI
  suggestions (README §18). This is a *coding rules* engine: it decides which
  account/VAT-treatment/status to apply to a bank transaction. It has no
  concept of a statute, a provision, a source citation, or an effective-dated
  legal rule — those didn't exist anywhere in the schema.
- **`src/domain/search/search.ts`** is a keyword/LIKE search across existing
  entity types (README §36) — there is no embeddings/vector infrastructure in
  the project to extend or to avoid duplicating. This matches the task's
  instruction not to make semantic search the decision mechanism: it already
  wasn't one anywhere in Leabhar.
- **`src/domain/extraction/`** is the invoice/receipt LLM+local extraction
  pipeline, with a `reviewItems` queue (`src/db/schema/operations.ts`) for
  anything that needs a human look before it's trusted.
- **`src/db/schema/_shared.ts`** already carries the three conventions this
  task needs most: `provenance` (who asserted a value and how confident),
  `effectiveDates` (superseded-not-overwritten configuration), and
  `ruleSource` (a source note/date shown in the UI). `docs/DOMAIN_MODEL.md`
  and `AGENTS.md` state these as non-negotiable invariants, enforced by tests,
  for the whole application — not something specific to this feature.

**Conclusion:** extend, don't duplicate. The new `irish_*` tables reuse
`provenance`/`effectiveDates`/`ruleSource` rather than re-inventing them, and
a derived rule can bind to an existing `tax_rates`/`vat_treatments` row
instead of restating one. The statute-derived rules are a distinct concept
from `rules` (user-authored coding rules): a coding rule says "code this
supplier to this account"; a statute-derived rule says "the Act states this
figure, in force from this date, subject to these conditions." They share an
evaluator (`conditionEval.ts`, factored out of `engine.ts` in this change) but
not a table, because their governance is different — a coding rule is
user-owned from creation; a statute-derived rule starts `ai_extracted` and is
never authoritative until a human approves it. Newly extracted rules are
surfaced through the *existing* `review_items` queue (kind
`unresolved_ai_suggestion`) rather than a second review inbox.

A dedicated `/rules` UI page for this KB was **not** built. Per the task's
own preference ("prefer CLI/scripts... if that fits the project better than a
large UI") and given the existing `src/app/rules/page.tsx` is the coding
rules engine's page, a CLI (`npm run cli:rules`) is the v1 admin/developer
workflow. See "Next steps" below for what a UI would add.

## Source hierarchy

Every source document is tagged with a `sourceType`, and the type is never
lost or merged away:

```
legislation | eu_source              -> rank 1 (primary law)
revenue_guidance | revenue_ebrief
  | cro_guidance                     -> rank 2 (explains primary law)
accounting_standard                  -> rank 3
leabhar_implementation_rule          -> rank 4 (this practice's own convention)
```

The ranking lives in one place, `src/domain/rules/sourceHierarchy.ts`
(`sourceAuthorityRank`), and nowhere else — it is never duplicated as a stored
column. A Revenue eBrief can update how a Tax and Duty Manual is read; it can
never edit, merge into, or outrank a `legislation` row. Today the KB holds one
source (`legislation`); the architecture is what makes adding a Revenue Tax
and Duty Manual later an *ingestion*, not a redesign — see "Adding a new
source" below.

## Schema

Four new tables (`src/db/schema/irishRules.ts`, migration
`drizzle/0004_irish_rules_kb.sql`), additive to the existing schema:

### `irish_knowledge_sources`
The document itself. Content-addressed by `sha256`; a citation may have more
than one source row over time (an amended re-print), but the same bytes can
never be ingested twice under the same citation (unique on
`citation, sha256`). Carries `sourceType`, `jurisdiction`, `sourceUrl`,
`publicationDate`, and the shared `effectiveDates`/`ruleSource` columns.
Source documents are never modified in place (AGENTS.md invariant #5) — a
changed document is a new row.

### `irish_act_provisions`
One row per statute section, as parsed. `provisionText` is a normalised
verbatim extract; `sourceStart`/`sourceEnd` are character offsets into the
*original* source document, so the exact slice is always recoverable and
re-checkable — never trusted. `relevant`/`relevanceReason` record an explicit
judgement (procedural, repeal-only, penalty and pure-definition provisions
default to not relevant; everything else defaults to relevant; category
`other` defaults to not relevant *and* flagged for human review). A curated
rule key (see below) overrides the mechanical default, because mapping a key
is itself a human editorial judgement.

### `irish_tax_rules`
A rule derived from one provision. Key columns:

- `ruleKey` — a stable, human-curated key for deterministic lookup (never
  derived from prose).
- `ruleType`, `topic` — what kind of rule it is and what it's about.
- `statement` — built only from the provision's own wording.
- `extractedFact`, `numericValue`, `unit`, `qualifier` — the verbatim figure
  and its stated qualifier, never a value the extractor invented.
- `conditions` / `exceptions` — structured JSON. `conditions` reuses the same
  shape `rules.conditions` already uses (see `conditionEval.ts`); `exceptions`
  are `{condition, effect}` plain-language pairs the extractor found but does
  not yet parse into evaluable conditions (see "Limitations").
- `accountingEffect` / `taxEffect` / `vatEffect` / `reportingEffect` — the
  four treatment dimensions the task asks for, populated only where the rule
  actually speaks to that dimension.
- `crossReferences` — other sections/Acts this provision cites.
- `requiresGuidance`, `humanReviewRequired`, `reviewStatus`, `reviewedBy`,
  `reviewedAt`, `reviewNotes` — the governance lifecycle (see "Versioning and
  review" below).
- `ruleVersion`, `supersedesRuleId`, plus the shared `effectiveFrom`/
  `effectiveTo`/`active` — versioning (below).
- `taxRateId` / `vatTreatmentId` — optional binding to an *existing*
  `tax_rates`/`vat_treatments` row, so a derived rule can point at rather than
  restate Leabhar's own configuration.

### `irish_tax_rule_tests`
Generated or hand-written test cases: `testType`
(`positive|negative|exception|boundary|effective_date`), `input` (a
transaction context), `expected` (`{matches, reviewRequired?, notes?}`), and
the result of the last run (`lastRunAt`/`lastRunPassed`).

## Ingestion pipeline

`src/domain/rules/statuteParser.ts` parses the Finance Act 2024 Markdown
*textually*, never semantically: it locates each `^<num>. ` section, and the
heading printed on its own line (occasionally wrapped across two) directly
*above* the section number in this Act's layout — verified against the actual
document, not assumed. It records exact source offsets, strips pdftotext
page-break boilerplate (running headers, bare page numbers) from the
normalised text, and categorises each provision by deterministic keyword
match on heading+body (never an LLM). `assessRelevance` then makes the
relevance call described above.

`src/domain/rules/factExtractor.ts` mechanically scans a provision's verbatim
text for stated monetary amounts, percentages and year-counts — regex over
text, no inference about what a figure "should" be. A small curated table,
`SECTION_RULE_KEYS`, is the *only* place a human decides that a given
section's figure deserves a stable, lookup-advertised key (today: sections 2,
3, 13 and 48 — a USC threshold, an income-tax threshold, the pension standard
fund threshold, and the film relief rate). An uncurated section's figures are
still on disk (in `provisionText`, auditable), but the pipeline never invents
a key for them.

`src/domain/rules/irishRules.ts` ties it together:

- `ingestFinanceAct2024(db, { companyId, markdown, ingestVersion })` — parses
  and stores the source + every provision. Idempotent by content.
- `deriveTaxRules(db, { companyId, sourceId? })` — for each provision with a
  curated key, extracts the fact and writes an `irish_tax_rules` row.
  Idempotent: unchanged figures create nothing new. A changed figure closes
  the old version (`effectiveTo`/`active`) and inserts a new one
  (`ruleVersion + 1`, `supersedesRuleId`) — never an in-place edit. Every new
  rule also gets a `review_items` row (see above), so it surfaces where a
  practice already looks for things needing attention.

## Rule format

Conceptually, a stored rule looks like:

```json
{
  "rule_id": "taxrule_...",
  "rule_key": "usc.first_band_threshold",
  "topic": "usc",
  "rule_type": "threshold",
  "statement": "Finance Act 2024 s.2: (1) Section 531AN of the Principal Act is amended— (a) in subsection (3), by the substitution of “€27,382” for “€25,760”, and ...",
  "extracted_fact": "€27,382",
  "conditions": [],
  "exceptions": [],
  "effect": { "tax": "USC first band ceiling: €27,382 (year of assessment 2025).", "accounting": null, "vat": null, "reporting": null },
  "source": { "citation": "2024 Act 43", "section": "2", "source_url": "https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/pdf" },
  "effective_from": "2025-01-01",
  "effective_to": null,
  "requires_guidance": false,
  "human_review_required": true,
  "review_status": "ai_extracted"
}
```

`conditions` is empty here because this particular rule is a flat statutory
fact (a threshold that applies whenever its topic and effective window
match), not a rule conditioned on transaction attributes — see "Empty
conditions mean different things in the two engines" below.

## Transaction lookup

`src/domain/rules/transactionLookup.ts` implements:

```
transaction -> normalise -> identify topics -> deterministic candidate
retrieval -> evaluate conditions -> evaluate exceptions -> apply effective
dates -> applicable rules -> unresolved fields -> possible treatment ->
source citations -> review-required
```

`identifyTopics` is a fixed, versioned keyword table
(`TOPIC_RULES` in `transactionLookup.ts`) — e.g. a non-Irish
supplier or a description matching `saas|software|digital service` routes to
`vat`; `bank|fee|charge` routes to `banking`; every transaction is also
routed to `business_expense`, since deductibility is a candidate question for
any transaction. This is deliberately not semantic similarity: the task is
explicit that "semantic search may retrieve candidates; it must not by
itself determine the accounting treatment," and here it isn't even
semantic — it's a lookup table a reviewer can read top to bottom.

For each identified topic, `listTaxRulesByTopic` retrieves rules **in force
on the transaction's own date**, not today's — so a historical transaction
resolves against the rule that applied when it happened
(`irishRules.test.ts` and `transactionLookup.test.ts` both test this against
2024 dates, before the Act's rules take effect, and 2025 dates, after).
Conditions (when a rule has any) are evaluated with the same
`evaluateAllConditions` the coding-rules engine uses. Exceptions are
plain-language today (see "Limitations"), so a rule with any exception is
never silently applied — it's flagged for review instead.

**The result never claims a treatment the KB doesn't support.** Run against
the task's own worked examples (`transactionLookup.test.ts`,
"task example scenarios"):

- A €10 Revolut bank charge → topics `banking`, `business_expense` →
  zero applicable rules (this KB, so far, only holds income-tax/USC/pension/
  film-relief facts from the Finance Act) → `reviewRequired: true`,
  `possibleTreatment` entirely empty. No invented VAT rate, no invented
  deductibility claim.
- An AI SaaS charge from a US supplier → topic `vat` → zero applicable rules
  → `reviewRequired: true`. The system does not guess at reverse-charge VAT
  treatment it has no ingested rule for.
- A personal purchase charged to the business account → topic
  `director_transaction` → zero applicable rules → `reviewRequired: true`.

### Empty conditions mean different things in the two engines

`engine.ts` (user-authored coding rules) treats a rule with zero conditions as
matching **nothing** — a safety default against a half-finished rule
silently reclassifying the whole ledger. `transactionLookup.ts`
(statute-derived rules) treats zero conditions as matching **whenever the
topic and effective window match** — because every rule here passed through
curated extraction, so an empty condition list is a reviewed statement that
the fact is unconditional (e.g. "the USC first band ceiling is €27,382"),
not an omission. This is documented at both call sites, not left implicit.

## Versioning and review

Rules are versioned, never silently modified:

```
OLD RULE  effective_to = change date, active = false
NEW RULE  effective_from = change date, supersedes_rule_id = OLD RULE.id, rule_version += 1
```

Review lifecycle (`src/domain/rules/review.ts`,
`setRuleReviewStatus`):

```
draft -> ai_extracted -> human_review -> approved -> active -> superseded
                                                   \-> rejected
```

Only `active` turns off `humanReviewRequired` for lookup purposes (and only
a human transition does that — nothing in the extraction pipeline sets it).
`rejected` disables the rule (`enabled = false`) so it can never resurface as
a candidate, while the row and the rejection reason stay on record. Every
rule extracted by this v1 pipeline starts, and today remains, `ai_extracted`
— none has been through human review yet (see the audit report).

## Testing

`generateDefaultTestCases`/`runTestCases`
(`src/domain/rules/testCases.ts`) write and run a positive case (rule applies
on its effective-from date) and an effective-date case (the same context, one
day earlier, where it must not yet apply) per active rule — a floor, not a
substitute. The hand-written suite in `transactionLookup.test.ts` covers all
five case types the task asks for against real data:

| Type | Test |
|---|---|
| Positive | payroll transaction on 2025-01-01 resolves the USC threshold |
| Negative | a transaction matching no topic keyword surfaces no candidate |
| Exception | a rule with a stated exception is flagged, never silently applied |
| Boundary | 2024-12-31 vs 2025-01-01 give different answers |
| Effective-date | a 2010 transaction resolves against no Finance-Act-2024 rule |

`npm test` (692 tests, whole project) and `npm run typecheck` both pass as of
this change.

## Audit report

Generated by `src/domain/rules/audit.ts` (`generateAuditReport`); a snapshot
from a fresh ingest is committed at
[`docs/statutes/2024-act-43/audit-report.json`](statutes/2024-act-43/audit-report.json)
and reproducible with `npm run cli:rules -- ingest && npm run cli:rules --
extract && npm run cli:rules -- audit`. Headline numbers:

- 118 provisions ingested, 57 judged relevant to transaction classification,
  61 not (procedural/repeal/penalty/pure-definition, or uncategorised and
  flagged for review).
- 4 rules extracted (the curated set), all `ai_extracted`, all
  `human_review_required = true` — **zero rules in this KB are authoritative
  yet.**
- 0 rules with unevaluable exceptions, 0 duplicate rule keys.
- 421 cross-references the report cannot resolve — expected, not a bug: the
  Finance Act 2024 *amends* the Taxes Consolidation Act 1997 and other Acts,
  none of which are themselves ingested yet, so "section 531AN" et al. have
  nothing to resolve against inside this KB alone.

**This is not a claim that the knowledge base is legally complete.** It is a
record of what was ingested, what was judged relevant, what was extracted,
and what still needs a human — which is what the task asks the audit report
to be.

## CLI

`npm run cli:rules -- <command>` (`src/cli/irishRules.ts`):

```
ingest [--file <path>]     Ingest the Finance Act 2024 Markdown
extract                    Derive irish_tax_rules from ingested provisions
list-provisions [--category <c>] [--relevant-only]
show-provision --section <n>
list-rules [--topic <t>] [--status <s>]
review --rule <id> --status <s> --by <name> [--notes "..."]
lookup --json '<transaction context>'
generate-tests
test                        Exit code 1 if any test case fails
audit
```

`--format human` on any command for a readable render instead of JSON.

## Limitations (explicit, not hidden)

- **Only the Finance Act 2024 is ingested.** The Taxes Consolidation Act 1997
  and Value-Added Tax Consolidation Act 2010 it amends are not — so a lookup
  on a VAT or general income-tax question will almost always come back with
  zero applicable rules and `reviewRequired: true`. That is the system
  working as designed (never inventing a treatment it has no source for), not
  a bug, but it does mean the KB is presently much narrower than "Irish tax
  law."
- **Only 4 of 57 relevant provisions have a curated rule key.** The other 53
  are ingested (text, offsets, category all on disk) but not yet extracted
  into named rules — `provisionsWithoutExtractedRule` in the audit report
  would show these once curated; today it's empty because the curated set and
  the derived set match exactly.
- **Exceptions are plain-language, not structured.** `exceptions` stores
  `{condition, effect}` text the extractor found stated near a rule, but there
  is no parser turning "save where the Minister otherwise directs" into an
  evaluable condition yet. A rule with any exception is always flagged for
  review rather than silently applied or silently ignored.
- **No sentence-boundary NLP.** `factExtractor`'s "evidence" sentence is
  everything between two periods in the source text, which for statute
  prose (semicolons and lettered sub-paragraphs, not full stops) can be a
  long run-on quotation. It is still verbatim and traceable to its offsets,
  just not always a tidy single sentence.
- **`Part`/`Chapter` are not yet populated** on `irish_act_provisions` (the
  columns exist for when this is worth doing); a provision's location is
  fully identified by section number + source offsets in the meantime.
- **The pre-existing drizzle-kit snapshot chain is broken** (`drizzle/meta/
  0000_snapshot.json` through `0002` all share one id/prevId, unrelated to
  this change — `npm run db:generate` fails on it). Migration 0004 here was
  therefore hand-written in the existing SQL style rather than generated, and
  applies and runs cleanly (`npm test`, `npm run db:migrate` both exercise
  it), but a future schema change will hit the same `drizzle-kit generate`
  failure until that chain is repaired — out of scope for this change.

## Adding a new source (Revenue guidance, EU law, another Act)

This is meant to be an ingestion, not a redesign:

1. Add a parser for the new document's layout (a Tax and Duty Manual is not
   laid out like an enacted Act) producing the same `ParsedProvision` shape,
   or a document-specific equivalent.
2. Call `irishKnowledgeSources` insert with the correct `sourceType`
   (`revenue_guidance`, `revenue_ebrief`, `cro_guidance`, `eu_source`,
   `accounting_standard`) — never `legislation` for anything that isn't an
   Act.
3. Extract provisions/rules using the same `irish_act_provisions`/
   `irish_tax_rules` tables and the same curated-key discipline.
4. `sourceAuthorityRank` (`sourceHierarchy.ts`) already orders the new source
   type correctly relative to existing ones — nothing to change there unless
   the ranking itself needs revisiting.

## Next steps

- Curate rule keys for the remaining ~53 relevant provisions (or accept that
  most Finance Act sections are amendments best resolved once the underlying
  Act — TCA 1997 / VATCA 2010 — is itself ingested).
- Ingest VATCA 2010 and/or a first Revenue Tax and Duty Manual, to give the
  `vat`/`business_expense` topics real candidates for the AI-SaaS/bank-charge
  style transactions this task uses as its worked examples.
- A structured-exception parser, once there's a large enough exception corpus
  to justify one.
- A `/rules` (or a section of the existing one) admin UI for
  browse/review/approve, once the CLI workflow has been used enough to know
  what it needs.

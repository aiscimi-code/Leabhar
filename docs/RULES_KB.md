# Irish rules knowledge base

A structured, versioned, source-linked knowledge base for Irish accounting/tax
statutes and guidance, and a deterministic lookup engine that maps a
transaction to the rules that apply to it. Two sources are ingested:

- the Finance Act 2024 (2024 Act 43), from
  `docs/statutes/2024-act-43/2024-act-43-enacted.md`;
- the Value-Added Tax Consolidation Act 2010 (2010 Act 31), from
  `docs/statutes/vatca-2010/vatca-2010-enacted.md`.

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
never edit, merge into, or outrank a `legislation` row. Today the KB holds two
sources, both `legislation` (Finance Act 2024, VATCA 2010); the architecture
is what makes adding a Revenue Tax and Duty Manual later an *ingestion*, not a
redesign — see "Adding a new source" below.

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

### VATCA 2010

The Value-Added Tax Consolidation Act 2010 is a *principal* Act (it states
the law directly, unlike the Finance Act's "section X of the Principal Act is
amended by..." form) and is printed in the Irish Statute Book's "marginal
note" layout: each section's short heading and predecessor-provision citation
sit in a column beside the section rather than above it. Getting from the PDF
to parseable text needed its own, reusable step:

- `scripts/convert-statute-pdf.ts` — a one-time PDF→Markdown converter (not
  part of the runtime pipeline, the same way the Finance Act's own PDF→text
  step wasn't). It reads pdfjs's raw text items per page and splits each page
  into a main-text column and a margin-note column by a single x threshold
  per page parity (the margin sits on the right on odd pages, the left on
  even ones — a printed book's mirrored inner/outer margins). That threshold
  is derived once for the whole document, not guessed: plotting every item's
  x position for a given parity across all 232 pages shows two dense
  clusters with a completely empty band between them, and the boundary is
  the midpoint of that gap. (Earlier approaches — a per-row widest-gap test,
  or per-page bootstrapping from that page's own citations, or a small fixed
  tolerance around one anchor x — each broke on a real case: a main/margin
  gap as small as 6pt on some lines, pages with no citation to bootstrap
  from, and multi-word citations whose sub-glyphs render up to 65pt further
  from the anchor than an ordinary word gap. A global, whole-document
  gap search sidesteps all three.) The heading is re-attached above its
  section number in the same convention `statuteParser.ts` already reads,
  bounded so it never runs past the *next* section's own heading — needed
  for a short run of sections (VATCA ss.121-123) that cite no predecessor
  provision at all and so have no `[...]` citation line to stop the
  collection otherwise. See the script's own header for the full algorithm.
  Cross-checked against the Act's own "ARRANGEMENT OF SECTIONS" table of
  contents (embedded in the source PDF): all 125 body sections (1-125) are
  found, every extracted heading matches its TOC entry (aside from two
  sections where the TOC and the body margin render the same words with a
  different dash glyph — a font detail, not a content error), and the
  verbatim-excerpt test below has never needed a `provisionText` workaround
  since. Schedules remain out of scope.
- `src/domain/rules/vatcaParser.ts` — parses the converted Markdown, reusing
  `statuteParser.ts`'s generic (source-independent) `categoriseProvision`,
  `assessRelevance` and `provisionSlug` rather than re-implementing them.
- `src/domain/rules/vatcaCuration.ts` — hand-authored rules for 5 sections
  (charge to VAT, reverse charge for services from abroad, place of supply of
  services, general input VAT deduction, the food/drink/entertainment/motor
  deduction exclusions). Unlike the Finance Act's mechanical figure
  extraction, VATCA mostly states *conditional* rules ("if a taxable person
  receives a service from a supplier established outside the State..."), so
  turning that into a `conditions` array is an interpretive act, not a regex
  match — recorded as such: `provenanceStatus: 'ai_suggestion'` (not
  `'system_rule'`), lower `confidence` (70, not 90), and an
  `interpretationNote` on every curated rule explaining exactly how its
  condition maps onto `TransactionContext` fields and where that mapping is
  a simplification (e.g. `supplierCountry != 'IE'` stands in for "established
  outside the State", which is a location test, not a country-code test).
  Every `statementExcerpt` is verified (`vatcaParser.test.ts`) to be a
  verbatim substring of the parsed provision text.
- `src/domain/rules/vatcaIngestion.ts` — `ingestVatca2010`/`deriveVatcaRules`,
  mirroring the Finance Act functions' idempotency and versioning.

A real bug surfaced by adding this second source, fixed before it shipped:
`deriveTaxRules`/`deriveVatcaRules` originally looked up "the provision for
section N" across *every* ingested source in the company, not just their own
— harmless with one source, silently wrong with two, since both Acts have
their own "section 3", "section 12", etc. Both functions now default to
scoping by their own source's citation (`vatcaIngestion.test.ts`, "never
matches a curated section number against a DIFFERENT source's provision with
the same number", is the regression test).

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
conditions mean different things in the two engines" below. A VATCA rule, by
contrast, usually does carry conditions, because the provision itself states
a conditional test:

```json
{
  "rule_key": "vat.reverse_charge_services_from_abroad",
  "topic": "vat",
  "rule_type": "other",
  "conditions": [
    { "field": "supplyType", "operator": "equals", "value": "services" },
    { "field": "supplierCountry", "operator": "not_equals", "value": "IE" },
    { "field": "vatRegistered", "operator": "equals", "value": "true" }
  ],
  "effect": { "vat": "The RECIPIENT (not the overseas supplier) is accountable for, and liable to pay, Irish VAT on the supply, as if the recipient had supplied it themself (the reverse charge)...", "accounting": null, "tax": null, "reporting": null },
  "source": { "citation": "2010 Act 31", "section": "12" },
  "effective_from": "2010-11-01",
  "requires_guidance": true,
  "human_review_required": true,
  "review_status": "ai_extracted"
}
```

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

**The result never claims a treatment beyond what the KB actually supports.**
Run against the task's own worked examples (`transactionLookup.test.ts`,
"task example scenarios"), now that VATCA 2010 is ingested alongside the
Finance Act:

- A €10 Revolut bank charge (VAT-registered, invoice available) → topics
  `banking`, `business_expense`, `vat` → resolves VATCA's general input VAT
  deduction rule (`vat.input_deduction_general`, s.59) — deductible, since no
  exclusion (s.60) matches — but `reviewRequired: true` regardless, because
  no VATCA rule has been through human review yet.
- An AI SaaS charge from a US supplier (`supplyType: 'services'`) → topic
  `vat` → resolves the reverse-charge rule (`vat.reverse_charge_services_from_abroad`,
  s.12), the general B2B place-of-supply rule (`vat.place_of_supply_b2b_general`,
  s.34) and the input-deduction rule (s.59) — the recipient self-accounts for
  VAT under the reverse charge and can normally recover it. Omit
  `supplyType` and the reverse-charge rule does **not** apply — it shows up
  in `unresolvedFields` instead of being silently assumed either way.
- A personal purchase charged to the business account (0% business use, no
  invoice) → topic `director_transaction` → only the foundational "VAT is
  chargeable" declaration applies; the deductibility rule's own conditions
  (an invoice, business use > 0%) are not met, so no deduction is invented
  for it.
- A client dinner at a restaurant → resolves *both* the general deduction
  rule (s.59) *and* the food/drink/entertainment exclusion (s.60,
  `vat.deduction_exclusions_entertainment`) at once — the system surfaces the
  conflict for a human to resolve rather than picking a side.

Every one of these still comes back `reviewRequired: true`: no rule in this
KB has reached `reviewStatus: 'active'` yet (see "Versioning and review").

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

`npm test` (708 tests, whole project) and `npm run typecheck` both pass as of
this change.

Note: `generateDefaultTestCases`'s synthetic positive case only sets `topic`
and `transactionDate` — for a VATCA rule whose conditions need other fields
(`supplyType`, `vatRegistered`, ...) that generic context correctly fails to
satisfy them, so `npm run cli:rules -- test` shows 3 "failures" for the
condition-bearing VATCA rules. That is the generator's known limitation, not
a defect in the rules themselves — see "Limitations".

## Audit report

Generated by `src/domain/rules/audit.ts` (`generateAuditReport`); a snapshot
from a fresh ingest of both sources is committed at
[`docs/statutes/2024-act-43/audit-report.json`](statutes/2024-act-43/audit-report.json)
and reproducible with:

```
npm run cli:rules -- ingest --source finance-act-2024 && npm run cli:rules -- extract --source finance-act-2024
npm run cli:rules -- ingest --source vatca-2010 && npm run cli:rules -- extract --source vatca-2010
npm run cli:rules -- audit
```

Headline numbers:

- 243 provisions ingested across both sources (118 Finance Act 2024, 125
  VATCA 2010 — all 125 body sections now convert and parse cleanly), 147
  judged relevant to transaction classification, 96 not
  (procedural/repeal/penalty/pure-definition, or uncategorised and flagged
  for review).
- 9 rules extracted (4 Finance Act, 5 VATCA), all `ai_extracted`, all
  `human_review_required = true` — **zero rules in this KB are authoritative
  yet.**
- 3 rules with a stated exception the system flags rather than evaluates
  (VATCA's place-of-supply, input-deduction and deduction-exclusion rules),
  0 duplicate rule keys.
- 442 cross-references the report cannot resolve — expected, not a bug: the
  Finance Act 2024 *amends*, and VATCA 2010 heavily cross-refers to, the
  Taxes Consolidation Act 1997 and other Acts not themselves ingested yet, so
  "section 531AN", "section 654A" et al. have nothing to resolve against
  inside this KB alone.

**This is not a claim that the knowledge base is legally complete.** It is a
record of what was ingested, what was judged relevant, what was extracted,
and what still needs a human — which is what the task asks the audit report
to be.

## CLI

`npm run cli:rules -- <command>` (`src/cli/irishRules.ts`):

```
ingest [--source <s>] [--file <path>]
                            Ingest a source's Markdown (--source: finance-act-2024
                            [default] | vatca-2010)
extract [--source <s>]     Derive irish_tax_rules from ingested provisions
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

- **Only the Finance Act 2024 and VATCA 2010's *enacted* text are ingested.**
  The Taxes Consolidation Act 1997 (which the Finance Act amends, and which
  VATCA cross-refers to constantly) is not, so most cross-references resolve
  nowhere inside this KB alone. VATCA's own rate section (s.46) states
  21%/13.5%/4.8%/0% *as enacted in 2010* — the standard rate has since
  changed to 23% by later Finance Acts not ingested here, so that section is
  deliberately **not** curated into a live rule: a stale rate presented as
  current is worse than no rule at all. Everything else curated from VATCA
  (reverse charge, place of supply, deductibility) is a structural mechanism
  that has not been fundamentally rewritten since 2010, so curating its
  *existence* is safe even though the ingested text is not fully current.
- **Only 9 of 147 relevant provisions have a curated rule key** (4 Finance
  Act, 5 VATCA). Everything else is ingested (text, offsets, category all on
  disk) but not yet extracted into named rules —
  `provisionsWithoutExtractedRule` in the audit report would show these once
  curated; today it's empty because the curated set and the derived set match
  exactly.
- **VATCA's conditions are curated, not mechanically extracted — and this is
  recorded, not glossed over.** Mapping "a supplier established outside the
  State" onto `supplierCountry != 'IE'` is an interpretation; every VATCA
  rule's `interpretationNote` says exactly what its condition mapping does
  and does not capture (e.g. it cannot tell a place-of-supply exception
  applies, or that a motor-vehicle purchase qualifies for a carve-out). Its
  `confidence` (70) and `provenanceStatus` (`ai_suggestion`) are lower than
  the Finance Act's mechanical figure extraction (90, `system_rule`) for
  exactly this reason.
- **The entertainment/food/motor-vehicle exclusion rule (VATCA s.60) matches
  by keyword on the transaction description**, not by reading the actual
  supply — a "hotel" transaction that IS qualifying-conference accommodation
  is excepted from the exclusion (`exceptions` records this), but the keyword
  match cannot itself tell the two apart. It surfaces the candidate for
  review; it does not classify it.
- **Exceptions are plain-language, not structured**, beyond the fact of
  their existence. `exceptions` stores `{condition, effect}` text found
  stated near a rule, but there is no parser turning "save where the
  Minister otherwise directs" into an evaluable condition. A rule with any
  exception is always flagged for review rather than silently applied or
  silently ignored.
- **No sentence-boundary NLP.** `factExtractor`'s "evidence" sentence is
  everything between two periods in the source text, which for statute
  prose (semicolons and lettered sub-paragraphs, not full stops) can be a
  long run-on quotation. It is still verbatim and traceable to its offsets,
  just not always a tidy single sentence.
- **`convert-statute-pdf.ts` does not parse Schedules.** Schedules 1–5 on
  VATCA 2010 (exempt activities, zero/reduced-rate goods and services) are
  out of scope entirely — the conversion stops at the first `SCHEDULE`
  heading. All 125 numbered body sections are converted and cross-checked
  against the Act's own table of contents (see "VATCA 2010" above); the
  Schedules gap is the only remaining one, and it's a documented stopping
  point, not a silent failure.
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

- Curate rule keys for the remaining ~106 relevant provisions (many Finance
  Act sections are amendments best resolved once the underlying Act — TCA
  1997 — is itself ingested; several more VATCA sections — place-of-supply
  exceptions, exemption/zero-rating in the Schedules once those are in
  scope, registration thresholds — are readily curatable now).
- Ingest the Taxes Consolidation Act 1997 and/or a first Revenue Tax and Duty
  Manual (e.g. on VAT registration or reverse charge), to resolve the ~440
  currently-unresolved cross-references and to bring VATCA's rate section
  (s.46) up to date safely (a Revenue TDM stating the *current* rate, dated,
  would let that be curated without the staleness risk described above).
- Extend the converter (`convert-statute-pdf.ts`) to also parse Schedules
  (numbering resets per Schedule, which the current stop-at-`SCHEDULE` scope
  sidesteps) — Schedules 1–3 hold the exemption/zero-rate/reduced-rate lists
  that would materially deepen `vat` topic coverage.
- A structured-exception parser, once there's a large enough exception corpus
  to justify one.
- A `/rules` (or a section of the existing one) admin UI for
  browse/review/approve, once the CLI workflow has been used enough to know
  what it needs.

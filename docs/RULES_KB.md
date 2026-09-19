# Irish rules knowledge base

A structured, versioned, source-linked knowledge base for Irish accounting/tax
statutes and guidance, and a deterministic lookup engine that maps a
transaction to the rules that apply to it. Two sources are ingested:

- the Finance Act 2024 (2024 Act 43), from
  `docs/statutes/finance-act-2024/2024-act-43-enacted.md`;
- the Value-Added Tax Consolidation Act 2010 (2010 Act 31), from
  `docs/statutes/vatca-2010/vatca-2010-enacted.md`;
- VATCA 2010 Schedules 2 and 3 (zero-rated / reduced-rate goods and
  services), from the LRC's revised text at
  `docs/statutes/vatca-2010-revised/schedule-{2,3}.md` — ingested as their own
  sources, distinct from the principal Act's as-enacted text above (see
  "VATCA 2010 Schedules 2 and 3" below);
- TCA 1997 s.530 (RCT definitions) and Revenue TDMs 18-02-04, 18-02-05 and
  18-02-11 (the current post-2011 RCT procedure and rate criteria) — a
  wholly different tax (a withholding regime, never VAT) from
  `docs/statutes/tca-1997/s530.md` and `docs/statutes/rct/tdm-18-02-{04,05,11}.md`
  (see "Relevant Contracts Tax (RCT)" below);
- VATCA 2010 s.46 (rates of tax), from the LRC's revised text at
  `docs/statutes/vatca-2010-revised/s046.md` — the *current* 23%/13.5%/4.8%
  VAT rates, ingested as its own source distinct from every other VATCA
  source above (see "VATCA 2010 current rates" below);
- TCA 1997 s.284 (wear and tear allowances), from
  `docs/statutes/tca-1997/s284.md` — the first non-VAT, non-RCT TCA 1997
  curation, and the first to demonstrate the generic `tca1997Ingestion.ts`
  pipeline (see "Capital allowances" below);
- S.I. No. 639 of 2010 (Value-Added Tax Regulations 2010), as-made text at
  `docs/statutes/si-639-2010/2010-si-639.md` — a whole 47-regulation
  statutory instrument, curated for Regulation 25 (moneys-received/cash
  basis of VAT accounting requires a Revenue authorisation, not a bookkeeping
  election) (see "S.I. 639/2010 (VAT Regulations 2010)" below);
- S.I. No. 156 of 2012 (Tax Returns and Payments (Mandatory Electronic
  Filing and Payment of Tax) Regulations 2012), from
  `docs/statutes/si-156-2012/2012-si-156.md` — curated for Regulation 4
  (VAT-accountable persons must file and pay electronically), the first
  source where the local transcript is only *partly* verbatim (see "S.I.
  156/2012 (Mandatory Electronic Filing)" below);
- S.I. No. 69/2025 (European Union (Value-Added Tax) Regulations 2025),
  Regulation 8 only, from `docs/statutes/si-69-2025/2025-si-69.md` — the
  *current* VATCA 2010 s.80(1) moneys-received/cash-basis eligibility
  thresholds (90% test / €2,000,000 turnover), closing a gap "S.I. 639/2010
  (VAT Regulations 2010)" above explicitly left open (see "S.I. 69/2025
  (Cash Accounting Thresholds)" below).

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

### VATCA 2010 Schedules 2 and 3

Schedules 2 (zero-rated goods and services) and 3 (goods and services
chargeable at the reduced rate) are ingested from a **different source and a
different point-in-time text** than the principal Act's own sections above —
never conflated with it:

- The as-enacted PDF `convert-statute-pdf.ts` converts stops at the first
  `SCHEDULE` heading (documented in "Limitations" below), so the Schedules
  come instead from the LRC's revised-Act HTML
  (`revisedacts.lawreform.ie/eli/2010/act/31/schedule/{2,3}/revised/en/html`),
  fetched and converted by `docs/statutes/scripts/extract_vat_sources.py` into
  `docs/statutes/vatca-2010-revised/schedule-{2,3}.md`. That conversion strips
  LRC's own page chrome, inline amendment-footnote markers
  (`<span class="commentary-reference">`), and the substitution-bracket print
  convention (`<span class="markup">`) at the HTML level — a raw-HTML capture
  showed a wrapped footnote citation ("commenced as per s.\n86.") was
  otherwise indistinguishable, once flattened to plain text, from a genuine
  top-level paragraph "86." starting fresh, corrupting the paragraph
  numbering. See the script's own `html_to_md()` for the fix.
- `src/domain/rules/vatcaScheduleParser.ts` — a Schedule paragraph opens as a
  bare `N.` / `N. (1)` / `NA.` at the start of a line, not the principal Act's
  `N .—` convention, and unlike the principal Act, a paragraph's marginal-note
  heading sits one blank line *above* its number rather than adjacent to it.
  Blank lines are not otherwise a reliable paragraph boundary here — the
  HTML→text flattening emits one for some inline cross-reference links
  mid-sentence too — so, exactly like `vatcaParser.ts`, a paragraph's extent
  is found by locating every paragraph-opening *line* and slicing to just
  before the next one, never by grouping blank-line-delimited blocks.
- `src/domain/rules/vatcaScheduleIngestion.ts` — `ingestVatcaSchedule`/
  `deriveVatcaScheduleRules`, ingesting each Schedule under its own citation
  (`2010 Act 31 Sch.2` / `Sch.3`, read from the file's own front matter) as
  its own `irish_knowledge_sources` row — never merged into `2010 Act 31`
  (the principal Act's citation), and scoped so that Schedule 2's paragraph 9
  (printed matter) is never confused with Schedule 3's own, unrelated
  paragraph 9 (private dwelling services).
- `src/domain/rules/vatcaScheduleCuration.ts` — 8 hand-authored rate rules (4
  per Schedule): intra-Community goods dispatch, export outside the
  Community, printed books, and children's clothing/footwear (Schedule 2,
  zero-rate); dwelling construction/repair/cleaning, solid fuel, repair of
  movable goods, and cinema admission (Schedule 3, reduced rate) — the
  paragraphs most likely to bear on an ordinary business's transactions, out
  of the ~39 total across both Schedules. Every rule's condition is a
  *description keyword match*, the same imperfect-proxy approach as the
  principal Act's `vat.deduction_exclusions_entertainment` rule: matching
  words against what is actually a legal list (a specific good, a specific
  class of service, each with its own exclusions) is an unassessable-by-
  keyword factor, so `requiresGuidance` is always true and every rule
  surfaces for human review before any classification is authoritative.

### Relevant Contracts Tax (RCT)

RCT is a withholding regime on payments under a "relevant contract" in
construction, forestry and meat processing — **never a VAT rate**, a wholly
independent tax from every source above (`docs/statutes/rct/README.md`).
Four sources, each its own `irish_knowledge_sources` row:

- **TCA 1997 s.530** (`legislation`, as-enacted 1997) — Chapter 2's
  foundational definitions (relevant contract, relevant operations,
  construction/forestry/meat-processing operations). `src/domain/rules/
  tca1997SectionParser.ts` is a new parser shape: each `docs/statutes/
  tca-1997/*.md` file holds exactly one section (there is no LRC-revised
  TCA to fetch as a single document — see that directory's own README), so
  unlike `vatcaParser.ts`/`statuteParser.ts` this parser finds one section
  per file rather than many sections in one converted Markdown, and drops a
  single leading `[FA70 s17...]`-style amendment-history citation bracket
  that isn't statutory text.
- **Revenue TDM Part 18-02-04** (`revenue_guidance`) — "RCT for Principal
  Contractors", the only verbatim source this KB holds for the actual
  2011-restructured procedure. TCA 1997 ss.530A-530V (which actually govern
  the modern electronic RCT system, including the deduction rate) have **no
  1997 as-enacted page to fetch** — they were inserted by Finance Act 2011
  s.20, a different Act not yet ingested here. Ingested as one whole-document
  provision (continuous prose with numbered headings, not an addressable
  statute), tagged `revenue_guidance` so it can never outrank a statute
  covering the same ground once one is ingested (`sourceHierarchy.ts`).
- **Revenue TDM Part 18-02-05** (`revenue_guidance`) — "RCT for
  Subcontractors". Its §3.5 states, verbatim, Revenue's own published
  criteria for the zero/20%/35% rate tiers (3-year tax compliance history,
  fixed place of business, record keeping) — used for
  `rct.subcontractor_compliance_criteria` below.
- **Revenue TDM Part 18-02-11** (`revenue_guidance`) — the electronic RCT
  system's ROS mechanics (re-opening a closed contract, unreported payment
  windows, bulk rate review). Ingested for citability but not currently
  curated into a rule: it is genuinely verbatim, but its content (screen
  navigation, closed-contract time windows) is UI procedure rather than a
  transaction-classification rule.
- `src/domain/rules/rctCuration.ts` — 4 curated rules: the relevant-
  operations scope gate (from s.530), the payment-notification procedural
  requirement, a rule that states the 0%/20%/35% deduction rate **cannot be
  determined from transaction data at all**, and a rule describing Revenue's
  own published rate criteria (from TDM 18-02-05) without evaluating them.
  Unlike every VAT rate rule in this KB, RCT's rate is not a fact stated in
  legislation or guidance for a given transaction: it is an individualised
  determination Revenue issues per payment notification, based on the
  subcontractor's own compliance history — a 3-year record no transaction
  carries. Curating a guessed rate here would be exactly the "silently
  repaired" failure AGENTS.md invariant #7 forbids, so both rate rules
  surface the criteria/absence-of-a-rate as the finding, never a number.
- **S.I. 651/2011 (the 2011 eRCT Regulations) is deliberately not used as a
  source**, even though it is genuinely verbatim: Revenue's own TDM 18-02-04
  §14 records that it "were subsequently revoked and replaced by [S.I.
  576/2012]... These regulations came into effect on 24 December 2012",
  itself later amended by S.I. 412/2013 and S.I. 5/2015 — none of which are
  ingested. This was discovered while curating RCT and is recorded rather
  than silently worked around (`docs/statutes/si-651-2011/README.md`).
- **TDM 18-02-01 (Relevant Operations) and 18-02-02 (Who is a Principal
  Contractor), both listed in `docs/statutes/rct/README.md`, are NOT used as
  sources**: both are still paraphrased summaries in this repo (no page
  markers, no source hash) rather than the verbatim text this KB's
  provenance policy requires before curating anything from them.

### VATCA 2010 current rates

`vatcaCuration.ts`'s own header explains a deliberate gap: the as-enacted
s.46 states 2010's rates (21%/13.5%/4.8%/0%), the standard rate has since
changed (23% today), and curating a live rule from stale text would let a
current transaction resolve against a wrong rate with no signal that it's
wrong — so it was left uncurated. This gap is now closed, without touching
that reasoning, by ingesting s.46 from a *different, continuously-updated*
source instead of trying to fix the frozen one:

- A real bug was found and fixed on the way here: every individual VATCA
  revised-section file (`docs/statutes/vatca-2010-revised/s002.md` through
  `s108C.md`, ~50 files — already fetched for other purposes, but never
  ingested) still had unstripped LRC nav chrome ("Act as originally
  enacted", "Next Section") even after the Schedule chrome fix earlier in
  this KB's history. Root-caused with a fresh raw-HTML capture of s.46: an
  ordinary section page's container is `<section class="sect" id="SEC46">`,
  not `class="section"` as the earlier fix assumed (Schedules do use
  `class="schedule"`, which is why *they* came out clean from the same fix
  while every ordinary section didn't) — `extract_vat_sources.py`'s
  `html_to_md()` now selects `section.sect, section.schedule`.
- `src/domain/rules/vatcaRevisedSectionParser.ts` — a third VATCA parser
  shape, for one-section-per-file LRC-revised text. Its operative-text
  marker is inconsistently formatted across real files ("46\n.—(1)",
  "91A\n.\n—\nIn", "108A\n.\n—\n(1)" all appear), so rather than match one
  line pattern it searches the whole post-title text for `<sectionNumber>`
  then `.` then `—` with any whitespace (including newlines) between each —
  verified against four different real files chosen specifically to cover
  that variation, not just s.46.
- `src/domain/rules/vatcaRevisedIngestion.ts` — ingests s.46 as its own
  source (`2010 Act 31 s.46`), distinct from `2010 Act 31` (the as-enacted
  whole-Act source) and from any Schedule source. Built generically so a
  future pass can ingest more of the ~50 available revised sections without
  a new ingestion function each time.
- `src/domain/rules/vatcaRevisedCuration.ts` — 3 rate rules (23% standard,
  13.5% reduced, 4.8% livestock), the first in this KB to carry a real
  `numericValue`/`unit: 'percent'` rather than `conditions` to evaluate: a
  rate is a fact, not a test, the same reason `vat.charge_general` (s.3) has
  no conditions either. The standard rate's `effectiveFrom` (2021-03-01) is
  not a guess — s.46(1A)'s own text states a temporary 21% substitution
  running only "from 1 September 2020 to 28 February 2021", which is itself
  proof, from the statute's own words, that 23% resumed immediately after.
  The 13.5%/4.8% rules carry no comparable textual evidence of an exact
  commencement date, so their `effectiveFrom` is honestly the date this KB
  confirmed them, not a claim about how long they've actually been in force.
  Deliberately not curated: five narrower, date-boxed 9% carve-outs in the
  same subsection (one of which is in force at the time of writing) — each
  needs the same care as the headline rates and is left for a future pass.

### Capital allowances

The first curation from TCA 1997 outside RCT, and the first to use a new
generic pipeline rather than a one-off module:

- `src/domain/rules/tca1997Ingestion.ts` — a generic `ingestTca1997Section`
  built on `tca1997SectionParser.ts` (already written for RCT's s.530),
  taking any curated-rules set keyed by section number rather than one
  hard-coded citation. `rctIngestion.ts`'s own `ingestTca1997S530` predates
  this and is left as-is (it carries RCT-specific commentary that doesn't
  belong in a generic module); every TCA 1997 section ingested after this
  one should use the generic function instead of writing a new hand-rolled
  ingestion module each time.
- `src/domain/rules/capitalAllowancesCuration.ts` /
  `capitalAllowancesIngestion.ts` — one rule from TCA 1997 s.284 (wear and
  tear allowances): capital expenditure on machinery/plant, wholly and
  exclusively for the trade, qualifies for a wear-and-tear allowance.
  **Deliberately excludes the allowance percentage.** s.284(2) states 15%
  (general plant/machinery) and 20% (certain vehicles) as enacted in 1997 —
  this file's own front matter carries the standing "No LRC revised TCA;
  later Finance Acts may have substituted this section" warning, and
  Ireland's actual capital allowances regime for most plant/machinery today
  is 12.5% straight-line, not either enacted figure. Curating either
  percentage as current would repeat exactly the mistake "VATCA 2010
  current rates" above exists to fix, with no fresher TCA 1997 source yet
  ingested to fix it the same way — so only the *qualification* test is
  curated, and the rule's own `taxEffect` says explicitly that the rate is
  not determined by it.

### S.I. 639/2010 (VAT Regulations 2010)

The first statutory instrument (secondary legislation, not an Act) ingested
into the KB, and a new whole-document parser shape:

- `src/domain/rules/si639Parser.ts` — parses the entire 47-regulation as-made
  document at `docs/statutes/si-639-2010/2010-si-639.md` in one pass, the
  same "many provisions, one file" shape as the VATCA Schedules parser
  (`vatcaScheduleParser.ts`), reusing its line-based extent-finding for a
  bare `"N."` regulation opener. Unlike the Schedules, this document also has
  an official "EXPLANATORY NOTE" appendix that re-numbers 1–47 in prose
  summary form; both the table of contents and the Explanatory Note are
  excluded by finding the real body's own start (the enacting clause) and end
  (the "EXPLANATORY NOTE" heading) markers first, rather than trying to
  distinguish a real regulation-opener from a TOC or summary line by pattern
  alone.
- `src/domain/rules/si639Curation.ts` / `si639Ingestion.ts` — one rule from
  Regulation 25 (moneys-received/cash basis of accounting):
  `vat.cash_accounting_requires_authorisation`. A business cannot simply
  elect to account for VAT on receipts rather than invoices; Regulation
  25(1) requires a written application and a written Revenue authorisation
  first. **Deliberately states no numeric threshold.** The turnover/
  customer-mix eligibility test for cash-basis accounting lives in VATCA
  2010 s.80(1)(a)/(b) itself, not in this Regulation, and is not restated or
  curated here — Regulation 25 is purely procedural (the authorisation
  process and its own connected-persons/withdrawal exceptions), so unlike
  VATCA s.46 or TCA 1997 s.284, there was no stale-figure risk to guard
  against in the first place.
- Regulation 14A (postponed accounting for import VAT) is **not** curated,
  even though it is the VAT procedure most referenced elsewhere in
  `docs/statutes/import-vat/`: reg.14A did not exist in this 2010 as-made
  text at all — it was inserted by S.I. 734/2020, a separate instrument not
  ingested here. The short reference file
  `docs/statutes/si-639-2010/reg-14A-si-734-2020.md` is a paraphrase of that
  later instrument's own text, not verbatim, so it cannot back a rule under
  this KB's verbatim-only policy either.
- The other short per-regulation files already in `docs/statutes/si-639-2010/`
  (`reg-14.md`, `reg-19.md`, `reg-21.md` through `reg-29.md`, etc.) are all
  hand-written prose summaries, not verbatim statutory text — none of them is
  used as a source; the whole-document parse above is the only verbatim
  source for these regulations.

### S.I. 156/2012 (Mandatory Electronic Filing)

The first source where the local Markdown transcript is only **partly**
verbatim, and the KB's handling of that is deliberate rather than an
oversight:

- `docs/statutes/si-156-2012/2012-si-156.md` quotes Regulations 1, 2 and 4 of
  the instrument in full, official-text form, but Regulation 3 has no body at
  all in the file and Regulations 5-9 are replaced with a single editorial
  summary sentence ("5–9. Capacity exclusions, Appeal Commissioners review,
  revocation of exclusion, and electronic payment timing rules as in the
  official instrument."). That sentence is a paraphrase, not a source.
- `src/domain/rules/si156Parser.ts` never emits a provision for the
  placeholder section — its numbered-opener regex requires a period after
  the leading digits ("N. "), which "5–9." (an en-dash, not a period) does
  not match, so the exclusion happens by construction rather than a special
  case. Only regs 1, 2 and 4 are ever parsed.
- `src/domain/rules/si156Curation.ts` / `si156Ingestion.ts` — one rule from
  Regulation 4: `vat.mandatory_electronic_filing`. A VAT-accountable person
  must file returns and pay VAT electronically (via ROS or another
  electronic channel) from the date they became accountable, or 1 June 2012
  if already accountable on that date — this is a compliance/procedure fact
  with no numeric figure, so no stale-figure risk. Its `exceptions` records
  that a Regulation 5 "capacity" exclusion exists (insufficient internet
  access, or an individual prevented by age/infirmity), **without** stating
  what specifically qualifies for it, because that text is exactly the part
  this local file only summarises rather than quotes — asserting the actual
  criteria would mean inventing text this KB does not hold.

### S.I. 69/2025 (Cash Accounting Thresholds)

Closes a gap flagged, not fixed, in an earlier pass:

- `src/domain/rules/si692025Parser.ts` extracts exactly one named
  regulation (Regulation 8) from the whole instrument, rather than parsing
  every regulation — this document's ten top-level regulations sit
  alongside a newly-inserted VATCA Chapter (sections 92B, 92C, 92D)
  *embedded inside* Regulation 9's own substituted text, and "92B." would
  itself match a naive bare-number-opener regex the way S.I. 639/2010's
  regulations do. Rather than build a whole-document parser that has to
  tell a top-level regulation boundary apart from a nested inserted-section
  number, `parseSi692025Regulation` finds one named regulation's own
  `"^N. "` line-start marker and the next top-level regulation's marker (or
  end of document) as its boundary — the same targeted approach
  `vatcaRevisedSectionParser.ts` uses for a single VATCA section.
- `src/domain/rules/si692025Curation.ts` / `si692025Ingestion.ts` — two
  rules from Regulation 8, which substitutes the *current* text of VATCA
  2010 s.80(1)(a) and (b) (the eligibility test for the moneys-received/
  cash basis of VAT accounting): `vat.cash_accounting_turnover_threshold`
  (€2,000,000 total annual turnover, not exceeded and not likely to exceed,
  in any continuous 12-month period — stored as `200,000,000` `eur_minor`
  per AGENTS.md invariant #1, money is integer minor units) and
  `vat.cash_accounting_supplies_to_unregistered_persons_test` (at least 90%
  of annual turnover from supplies to unregistered persons). A person need
  only satisfy one test, not both.
- This is exactly the threshold "S.I. 639/2010 (VAT Regulations 2010)"
  above explicitly said was *not* curated there: "the real threshold lives
  in VATCA 2010 s.80(1) itself" (Regulation 25 only requires the Revenue
  authorisation, it states no eligibility figure of its own). With this
  source ingested, both eligibility limbs are now real, current, curated
  rules — effective from 6 March 2025, the date this instrument was made
  (it carries no separate commencement clause).
- Regulation 7 (restricting VAT deductibility for a person availing of the
  EU cross-border SME exemption scheme this same instrument introduces) is
  **not** curated in this pass — a distinct, narrower rule that deserves
  its own review, left for a future pass, along with Regulations 1-6, 9 and
  10 (the cross-border SME exemption scheme itself).

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
[`docs/statutes/audit-report.json`](statutes/audit-report.json)
and reproducible with:

```
npm run cli:rules -- ingest --source finance-act-2024 && npm run cli:rules -- extract --source finance-act-2024
npm run cli:rules -- ingest --source vatca-2010 && npm run cli:rules -- extract --source vatca-2010
npm run cli:rules -- ingest --source vatca-2010-sch2 && npm run cli:rules -- extract --source vatca-2010-sch2
npm run cli:rules -- ingest --source vatca-2010-sch3 && npm run cli:rules -- extract --source vatca-2010-sch3
npm run cli:rules -- ingest --source rct-tca530 && npm run cli:rules -- ingest --source rct-tdm
npm run cli:rules -- ingest --source rct-tdm-05 && npm run cli:rules -- ingest --source rct-tdm-11
npm run cli:rules -- extract --source rct
npm run cli:rules -- ingest --source vatca-2010-revised && npm run cli:rules -- extract --source vatca-2010-revised
npm run cli:rules -- ingest --source tca1997-s284 && npm run cli:rules -- extract --source tca1997-s284
npm run cli:rules -- ingest --source si639 && npm run cli:rules -- extract --source si639
npm run cli:rules -- ingest --source si156 && npm run cli:rules -- extract --source si156
npm run cli:rules -- ingest --source si69-2025 && npm run cli:rules -- extract --source si69-2025
npm run cli:rules -- audit
```

Headline numbers:

- 347 provisions ingested across thirteen sources (118 Finance Act 2024, 125
  VATCA 2010, 15 VATCA 2010 Schedule 2, 32 VATCA 2010 Schedule 3, 1 TCA 1997
  s.530, 1 Revenue TDM 18-02-04, 1 VATCA 2010 s.46 revised, 1 TCA 1997
  s.284, 1 Revenue TDM 18-02-05, 1 Revenue TDM 18-02-11, 47 S.I. 639/2010, 3
  S.I. 156/2012, 1 S.I. 69/2025 reg.8), 192 judged relevant to transaction
  classification, 155 not (procedural/repeal/penalty/pure-definition, or
  uncategorised and flagged for review).
- 29 rules extracted (4 Finance Act, 5 VATCA principal-Act, 4 Schedule 2, 4
  Schedule 3, 4 RCT, 3 current VAT rates, 1 capital allowances, 1 S.I.
  639/2010 cash accounting, 1 S.I. 156/2012 mandatory e-filing, 2 S.I.
  69/2025 cash-accounting eligibility thresholds), all `ai_extracted`, all
  `human_review_required = true` — **zero rules in this KB are authoritative
  yet.**
- 15 rules with a stated exception the system flags rather than evaluates,
  0 duplicate rule keys.
- 442 cross-references the report cannot resolve — expected, not a bug: the
  Finance Act 2024 *amends*, and VATCA 2010 heavily cross-refers to, the
  Taxes Consolidation Act 1997 and other Acts not themselves ingested yet, so
  "section 531AN", "section 654A" et al. have nothing to resolve against
  inside this KB alone. (The Schedule, RCT, current-rates, S.I. 639/2010 and
  S.I. 156/2012 sources add none of their own; S.I. 69/2025's own
  `amendsSection: "80"` resolves locally since VATCA 2010 is already
  ingested, so it adds no new unresolved reference either — see "VATCA 2010
  Schedules 2 and 3", "Relevant Contracts Tax (RCT)", "VATCA 2010 current
  rates", "S.I. 639/2010 (VAT Regulations 2010)", "S.I. 156/2012 (Mandatory
  Electronic Filing)" and "S.I. 69/2025 (Cash Accounting Thresholds)"
  above.)

**This is not a claim that the knowledge base is legally complete.** It is a
record of what was ingested, what was judged relevant, what was extracted,
and what still needs a human — which is what the task asks the audit report
to be.

## CLI

`npm run cli:rules -- <command>` (`src/cli/irishRules.ts`):

```
ingest [--source <s>] [--file <path>]
                            Ingest a source's Markdown (--source: finance-act-2024
                            [default] | vatca-2010 | vatca-2010-sch2 | vatca-2010-sch3 |
                            rct-tca530 | rct-tdm | rct-tdm-05 | rct-tdm-11 |
                            vatca-2010-revised | tca1997-s284 | si639 | si156 | si69-2025)
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

- **The Finance Act 2024 and VATCA 2010's *enacted* text are ingested in
  full; the Taxes Consolidation Act 1997 (which the Finance Act amends, and
  which VATCA cross-refers to constantly) is not**, apart from the single
  s.530 extract RCT needed — so most cross-references still resolve nowhere
  inside this KB alone. VATCA's own as-enacted rate section (s.46) states
  21%/13.5%/4.8%/0% as they stood in 2010; that text is still deliberately
  **not** curated (a stale rate is worse than no rule), but the *current*
  rates (23%/13.5%/4.8%) are now curated separately from the LRC-revised
  text — see "VATCA 2010 current rates" above. Everything else curated from
  the as-enacted VATCA text (reverse charge, place of supply, deductibility)
  is a structural mechanism that has not been fundamentally rewritten since
  2010, so curating its *existence* from the frozen text remains safe.
- **Only 29 of 192 relevant provisions have a curated rule key** (4 Finance
  Act, 5 VATCA principal-Act, 4 Schedule 2, 4 Schedule 3, 4 RCT, 3 current
  rates, 1 capital allowances, 1 S.I. 639/2010, 1 S.I. 156/2012, 2 S.I.
  69/2025). Everything else is ingested (text, offsets, category all on
  disk) but not yet extracted into named rules —
  `provisionsWithoutExtractedRule` in the audit report would show these
  once curated; today it's empty because the curated set and the derived
  set match exactly.
- **RCT's actual deduction rate (0%/20%/35%) is not in this KB at all**,
  by design (see "Relevant Contracts Tax (RCT)" above) — TCA 1997
  ss.530A-530V, which govern it, were inserted by Finance Act 2011 s.20 and
  have no 1997 as-enacted page; that Act is not yet ingested. The curated
  `rct.deduction_rate_not_determinable` rule states this gap as the finding
  rather than guessing a rate.
- **The wear-and-tear allowance *percentage* (TCA 1997 s.284(2)) is not in
  this KB either, for the same reason and by the same design**: the enacted
  15%/20% figures are very likely stale (most plant/machinery is commonly
  written off at 12.5% straight-line today), and no LRC-revised or current
  TCA 1997 text is ingested to safely curate a live figure the way "VATCA
  2010 current rates" did for VAT. Only the qualification test is curated;
  computing an actual allowance amount from this KB alone would be wrong.
- **S.I. 639/2010 reg.25 itself still states no numeric eligibility
  threshold — that gap is now filled by a different source, not by
  reg.25.** Regulation 25 only requires the Revenue authorisation; the
  actual VATCA 2010 s.80(1)(a)/(b) eligibility tests are now curated
  separately from S.I. 69/2025 Regulation 8 (see "S.I. 69/2025 (Cash
  Accounting Thresholds)" above) — the two rules together are what a reader
  needs (the authorisation requirement, and the tests it is granted
  against). Regulation 14A (postponed accounting for import VAT) remains
  excluded for a distinct reason: it was inserted by a later, un-ingested
  instrument (S.I. 734/2020), and the only local reference to its text is a
  paraphrase, which the verbatim-only
  policy already rules out as a source regardless of the ingestion gap.
- **S.I. 156/2012's own local transcript is only partly verbatim, and the
  ingestion is scoped to match.** Regulations 1, 2 and 4 are the official
  text; regs 3 and 5-9 are either absent or replaced by one editorial
  summary sentence. Only regs 1, 2 and 4 are parsed into provisions at all —
  `si156Parser.ts`'s numbered-opener regex excludes the placeholder section
  by construction — and only reg.4's mandatory-e-filing obligation is
  curated. Regulation 5's actual "capacity" exclusion criteria are not
  restated anywhere in this KB: the curated rule's `exceptions` records that
  an exclusion regime exists without asserting what qualifies for it, since
  that text is exactly the part this local file only summarises rather than
  quotes verbatim.
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
- **`convert-statute-pdf.ts` does not parse Schedules**, so the as-enacted
  principal-Act pipeline's Schedules gap (all 125 numbered body sections
  convert and cross-check against the Act's own table of contents; the
  conversion stops at the first `SCHEDULE` heading) is real and documented.
  Schedules 2 and 3 are, however, now ingested from a *different* source (the
  LRC's revised HTML, not the as-enacted PDF — see "VATCA 2010 Schedules 2
  and 3" above), so they are not a gap in the knowledge base overall, only in
  this one converter. Schedules 1, 4 and 5 remain uningested from any source.
- **The Schedule 2/3 curation covers 8 of ~39 total paragraphs** across both
  Schedules — the ones judged most likely to bear on an ordinary business's
  transactions (see "VATCA 2010 Schedules 2 and 3" above for the list).
  Everything else in both Schedules is ingested (text, offsets, category all
  on disk, queryable via `list-provisions`/`show-provision`) but not yet
  extracted into a named rule.
- **`Part`/`Chapter` are populated only where a source states one cleanly**
  (VATCA Schedule paragraphs get `part`; TCA 1997 s.530 gets `chapter`).
  Finance Act 2024 and VATCA 2010's own principal-Act provisions still leave
  both null — a provision's location there is fully identified by section
  number + source offsets instead.
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

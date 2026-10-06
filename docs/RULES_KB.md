# Irish rules knowledge base

A structured, versioned, source-linked knowledge base for Irish accounting and
tax law and guidance, and a deterministic lookup engine that maps a
transaction to the rules that apply to it. It stands in for a tax adviser's
knowledge, so it is kept as a registry: every rule has a stable key and dated
versions, and every relationship between rules is a row, not a constant in
code (ADR-0020, issue #686).

The sources a book loads are `SOURCES` and `DERIVES` in
`src/domain/rules/knowledgeBase.ts`; `npm run cli:rules -- ingest-all` loads
them all. Counts go stale, so this document gives none: `npm run cli:rules --
audit` reports what a book holds, and `docs/rules/coverage-matrix.json` says
which statute rows are covered. The sections after "Ingestion pipeline"
record, source by source, how each was curated.

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

## The rules registry (ADR-0020)

**Keys and versions.** A rule is a stable key (`vat.rate_standard_current`)
with one row per version in `irish_tax_rules`. A version holds for its own
dates (`effective_to` exclusive); `active` marks only the latest. A new version
of the same key is chained to the one before by `supersedesRuleId`. Where a
rule is applied, the book records its version ID, `key@version`
(`ruleVersionId`): on invoice lines (`vat_rule_versions`), in payslip rule
figures (`versionId`), and in the CT and income tax computations
(`ruleVersions`).

**Links.** `irish_rule_links` holds how one rule relies on another. Links name
keys, so a new version keeps every link, and are dated like rules. A link is
never edited or deleted: one the curation drops is set inactive.

| kind | from → to | declared in |
|---|---|---|
| `silenced_by` | an advisory rule → the rule that settles its question | `ruleLinks.ts` |
| `excludes` | a rule that wins → the rule it drops when both match | `ruleLinks.ts`; the conditioned-over-headline VAT rate half is derived from the book |
| `rate_from` | a Schedule 3 rule → the s.46 rate rule it bears, dated | `ruleLinks.ts`, from `SECOND_REDUCED_WINDOWS` (`scheduleRates.ts`) |
| `uses_value` | a rule → a rule whose figure it takes | `ruleLinks.ts` |
| `supersedes` | a new key → an old key (merge, split, rename, carve-out) | `supersessions.ts` |
| `cites` | a rule → a provision its cross-references resolve to | derived from the book (`dependencies.ts`) |
| `consumed_by` | a rule → `consumer:<name>`, a computation that reads it | each area's `ruleManifest.ts`, collected in `consumers.ts` |

`syncRuleLinks` writes them into a book at the end of
`loadStatutoryKnowledgeBase`. The code that acts on a relationship reads the
declared links (`declaredLinksFrom`, `declaredLinksTo`), so a book loaded
before a link was declared answers the same as one loaded after.

**Graph checks.** `checkRuleGraph` (`ruleGraph.ts`) reports a link to a key the
book does not hold, a rule relying on a key with no version in force over the
same dates, a gap or overlap between one key's versions (other than the gaps
the sources leave, declared in `DECLARED_VERSION_GAPS`), a cycle, and a
`supersedesRuleId` across keys with no `supersedes` link. `ruleGraph.test.ts`
runs it on a freshly loaded book, so the gate fails on any of them.

**Impact.** `npm run cli:rules -- impact <ruleKey|provision>` lists everything
that relies on a rule or provision, directly and transitively, and the
computations that read any of it; `depends <ruleKey>` walks the other way.
The provision page shows both for each rule, and the audit report lists the
link counts, the graph findings and the most relied-on rules.

**Consumers.** The transaction lookup and the VAT suggestion read rules by
topic and conditions, not by key (`TOPIC_RULE_CONSUMERS`, #694): the lookup
reads every rule of a topic it routes to (`LOOKUP_TOPICS`), and the
suggestion acts on the keys its binding and deduction-block tables name
(`VAT_SUGGESTION_RULE_KEYS`). Their `consumed_by` links are derived from the
book and those tables, so `impact` reaches them and a new curated rule is
covered without an edit. `catalogue:extract` prints each rule version whose
window moved, and what reads it, before the entry is committed.

Each computation that reads a figure declares the keys it reads in a
`ruleManifest.ts` beside it. `resolveRuleFigure` accepts only a declared key
(`ManifestRuleKey`), so an undeclared figure fails the typecheck;
`consumers.test.ts` checks each declared key exists and each key a consumer's
source names is declared.

**One source per figure.** A rate copied outside the rules (the CT seed rates,
the invoice parser's known rates, the asset register's default wear and tear,
the browser books' rates) is held to its rule by `figureCopies.test.ts`; the
VAT seed rows by `config/seeds.test.ts`.

**Tax heads.** `topic` routes a lookup; `tax_heads` lists every head a rule
belongs to (`taxHeads.ts`): a capital allowance is corporation tax and income
tax, import VAT is VAT and customs. `listTaxRulesByHead` reads them.

**Catalogue.** A ported source is one JSON entry under `catalogue/` (#443):
the official file's URL and SHA-256, its provisions' verbatim excerpts, and
the rules derived from them with their quotes, links and expert review. The
official file is kept beside the entry byte for byte (`s046.json`,
`s046.html`; `vatca-2010-enacted.json`, `vatca-2010-enacted.pdf`); the gate re-checks its hash, and a provision's provenance
re-hashes it (AGENTS.md #5).
`npm run catalogue:extract -- <entry>` writes one from the official page;
`catalogue.test.ts` fails the gate when an entry no longer matches what the
curation derives. All 39 loaded LRC-revised VATCA sections, Schedules
1-3, VATCA 2010 as enacted, the Finance Acts 2024 and 2025 as enacted,
TCA 1997 ss.530, 530A, 530E, 530G, 530H, 530I and 284, and Finance Act
2003 s.23 are in it; the other sources wait on #556. Each of ss.530A-530I
is its own source with FA 2011 s.20's page beside it, cut from that page
at its heading. A provision can carry its Chapter (`chapter`).
An entry can state the source's own publication and commencement dates
(the enacted Act's 1 November 2010) and a note; a provision can carry the
sections it cites (`amendsSection`), which the dependency graph reads, and
for a Finance Act the Act it amends (`principalAct`), the Acts it names
(`citedActs`) and the words that say when it takes effect (`effectiveClue`),
from which `deriveTaxRules` dates a rule.
The enacted Acts' excerpts are the parse the statute copies gave, including
the next section's heading at the end of each (#701, #703). A Schedule entry holds one
provision per paragraph, with its Part, and its paragraph windows are read
from the LRC page kept beside it. Its page is the one the parser was
verified against: the LRC's re-rendered pages break lines where the
line-based schedule parser misreads them (#699).

A quote matches its provision word for word, ignoring line breaks and
quote-mark style (`containsIgnoringLayout`): the LRC re-renders its pages
and has printed both straight and curly quotes, and neither changes the law.
An LRC entry can carry the page's amendment footnotes (`lrcAnnotations`), so
a rule's window is still read from the footnotes on the words it quotes.
A port adds them only where the statute copy had its HTML, so no rule's
dates move as a side effect; adding them is its own reviewed change (#691
added them to ss.27, 34, 60, 61, 66 and 86, moving six rules to the date
the words they quote took effect). A footnote can date a substitution wider
than the words it changed: a rule whose quote stands as enacted says so
(`wordsAsEnacted`), the derivation checks the quote is in the 2010 Act as
enacted, and the rule keeps its 2010 start: `vat.blocked_food_drink_accommodation`
(Finance Act 2024 s.81 replaced s.60(2)(a)(i) but changed only its tail),
`vat.invoice_prescribed_particulars` (S.I. 354/2012 substituted s.66(1)
around the quoted words) and `vat.flat_rate_farmer_purchase` (Finance Act
2016 s.47 changed the s.86(1) percentage, a separate fact) (#695). A quote of
inserted or replaced words does not take it.

A book that loaded a source from its statute copy before the port keeps
that source, since its words are the same. Once the copy is gone, its
footnotes and page are read from the entry with the same citation and words
(`catalogueEntryForSource`), so its rules keep their dates (#698).

A book numbers a rule's versions as it derives them, so a book that held a
version before it was corrected numbers the correction 2 where a new book
has it as 1. `checkCatalogueVersions` matches a book's version to the
catalogue by what it says (dates and quote), not by its number.

**Source drift.** `npm run cli:rules -- verify-sources [--entry <e>] [--trace]`
fetches each entry's official file (online, only when asked) and reports it
unchanged, changed or unreachable, naming each rule version whose quote is no
longer in the text. `--trace` raises a review item for every rule taken from
a changed source and every rule relying on one (`sourceDrift.ts`); nothing is
edited, and an approval stands only against the hash it was given on.

**Stated periods.** A version whose dates its own quote does not state
names the words that do (`statedPeriod`, `vatcaRevisedCuration.ts`): the
words that set the period, then each Act that substituted its end date. The
derivation checks every quote against its Act, that each substitution
replaces the date before it, and that the last ends the day before
`effectiveTo`; a family that does not check out is not derived, and a review
item says why (#688: s.46(1)(cb) 2020-2023 rests on Finance Act 2020 s.39,
the 2021 and 2022 Covid Acts and Finance Act 2023 s.5).

**Decisions.** A book's own decisions about a rule version are kept in
`irish_rule_decisions`, append-only: `review` (`setRuleReviewStatus`) adds
one each time, with who, when and why, and migration 0058 carried across
every decision taken before. The expert review ships in the catalogue, read
as an install-level, read-only store (`catalogueRuleStore`).
`effectiveRuleReview` gives the book's latest decision when it has one, else
the catalogue's. Loading the knowledge base raises a review item for every
version the book holds or an invoice line applied, from a catalogued source,
that the installed catalogue does not ship (`checkCatalogueVersions`);
nothing is switched to another version.

**Not yet.** The rule rows themselves are still copied into each book: they
move to the install-level store once every source is in the catalogue
(#556). Until then a lookup reads the row's review columns, which
`setRuleReviewStatus` keeps in step with the latest decision.

A relationship between rules that exists only in code is a bug: declare it
as a link.

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
never edit, merge into, or outrank a `legislation` row. Adding a source of
any type is an *ingestion*, not a redesign — see "Adding a new source" below.

## Schema

Five tables (`src/db/schema/irishRules.ts`; the first four from migration
`drizzle/0004_irish_rules_kb.sql`). The fifth, `irish_rule_links`, is
described under "The rules registry" above.

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
re-checkable — never trusted. `locator` records how the source *itself*
points a reader to the provision (issue #442, the #293 model): a page
number for a PDF, an anchor or section for an HTML page, a box code for a
return form, an article for an EU regulation — never invented here. `relevant`/`relevanceReason` record an explicit
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

`src/domain/rules/statuteParser.ts` parses the Finance Acts 2024 and 2025,
as `pdftotext -layout` lays out the Irish Statute Book PDF (the catalogue
extraction runs it; the entries under `catalogue/finance-act-2024/` and
`catalogue/finance-act-2025/` keep the PDF beside them),
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
- `src/domain/rules/vatcaParser.ts` — parses the converted text into the
  catalogue entry `catalogue/vatca-2010/vatca-2010-enacted.json` (written by
  `npm run catalogue:extract -- vatca-2010/vatca-2010-enacted`, which runs
  the converter on the PDF; #556), reusing
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
  a simplification (e.g. `supplierEstablishedOutsideStateResolved` falls
  back to an ISO-3166-validated `supplierCountry != 'IE'` proxy only when
  the caller supplies no direct establishment determination — "established
  outside the State" is a multi-factor legal test (EU Reg 282/2011
  arts.10-11), not a country-code test; see issue #136 bug 4 / issue #138
  and docs/statutes/282-2011/articles-10-13b-establishment.md).
  Every `statementExcerpt` is verified (`vatcaParser.test.ts`) to be a
  verbatim substring of its section's excerpt in the catalogue entry.
- `src/domain/rules/vatcaIngestion.ts` — `ingestVatca2010FromCatalogue`
  (what the knowledge base loads), `ingestVatca2010` (a Markdown copy given
  to the CLI with `--file`) and `deriveVatcaRules`, mirroring the Finance Act
  functions' idempotency and versioning.

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
- `src/domain/rules/vatcaScheduleIngestion.ts` — `ingestVatcaScheduleFromCatalogue`
  (or `ingestVatcaSchedule` for a Markdown copy) and
  `deriveVatcaScheduleRules`, ingesting each Schedule under its own citation
  (`2010 Act 31 Sch.2` / `Sch.3`) as
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
- **TCA 1997 ss.530A, 530E, 530G, 530H, 530I** (`legislation`,
  as-enacted-2011; issue #131) — the load-bearing rate-determination
  sections, inserted by Finance Act 2011 s.20. Confirmed (2026-09-20) that
  **no LRC-revised TCA 1997 exists for ss.530A-530V**: every
  `revisedacts.lawreform.ie/eli/1997/act/39/section/530X/revised/en/html`
  404s, as does the Act-level revised page. These were fetched instead from
  the eISB **as-enacted Finance Act 2011 s.20** page — the inserting Act's
  own text, which quotes each new section in full — split one file per
  section (`docs/statutes/tca-1997/s530A.md`-`s530V.md`, all 22 letters,
  same shared `source_html_sha256` since they share one physical page).
  `src/domain/rules/financeAct2011RctSectionParser.ts` is a new parser: the
  section-opening line here is `"530A.— (1) ..."` (number and first
  subsection on one line), not `s530.md`'s isolated bare `"530."`, so
  `tca1997SectionParser.ts` doesn't match this source's shape as-is. Only
  the six load-bearing sections are ingested; the other sixteen (530B-D,
  530J-V — registration, returns, assessment, penalties, record-keeping)
  exist verbatim on disk for a future pass. The six loaded sections are now
  in the rules catalogue (#556): each entry keeps FA 2011 s.20's page and
  `catalogue:extract` cuts its section from it.
- **Revenue TDM Part 18-02-04** (`revenue_guidance`) — "RCT for Principal
  Contractors", still the only verbatim source this KB holds for the
  2011-restructured payment-notification *procedure* (ss.530B/530C are
  verbatim on disk too but not ingested). Ingested as one whole-document
  provision (continuous prose with numbered headings, not an addressable
  statute), tagged `revenue_guidance` so it can never outrank a statute
  covering the same ground once one is ingested (`sourceHierarchy.ts`).
- **Revenue TDM Part 18-02-05** (`revenue_guidance`) — "RCT for
  Subcontractors". Its §3.5 states, verbatim, Revenue's own published
  criteria for the zero/20%/35% rate tiers (3-year tax compliance history,
  fixed place of business, record keeping) — `rct.subcontractor_compliance_
  criteria` below. Now that ss.530G/530H are ingested, this KB also holds
  the actual statutory test the TDM restates.
- **Revenue TDM Part 18-02-11** (`revenue_guidance`) — the electronic RCT
  system's ROS mechanics (re-opening a closed contract, unreported payment
  windows, bulk rate review). Ingested for citability but not currently
  curated into a rule: it is genuinely verbatim, but its content (screen
  navigation, closed-contract time windows) is UI procedure rather than a
  transaction-classification rule.
- `src/domain/rules/rctCuration.ts` — 11 curated rules. From s.530: the
  relevant-operations scope gate. From s.530A: who counts as a "principal"
  obliged to operate RCT (broader than the obvious construction-industry
  business — also a local authority, a Minister, certain statutory bodies,
  and gas/water/electricity/dock/canal/railway undertakings). From TDM
  18-02-04: the payment-notification procedural requirement. From s.530E:
  the real zero rate (`rct.rate_zero`, 0%), the 35% default/no-authorisation
  rate (`rct.rate_default_35pct`, also citing s.530F(2)(a)'s independent
  35% liability), and a standard-rate cross-reference
  (`rct.rate_standard_reference`) that deliberately states **no**
  `numericValue` — s.530E/530H only say "the standard rate (within the
  meaning of section 3)", and TCA 1997 s.3 itself is not ingested, so this
  KB does not assert the figure (currently 20% per Revenue's own public
  guidance, but not independently verified here). From s.530G/s.530H: the
  real statutory zero-rate and standard-rate subcontractor criteria
  (superseding `rct.subcontractor_compliance_criteria`'s TDM paraphrase as
  the load-bearing source, per `sourceHierarchy.ts`). From s.530I: a
  procedure rule for Revenue's determination-and-appeal mechanism, and a
  **re-sourced** `rct.deduction_rate_not_determinable` — narrowed, not
  retired: the three tiers are now real curated facts, but *which* tier a
  given subcontractor gets is still Revenue's own individualised
  determination, not a fact any transaction record can supply. Curating a
  rule that guessed *which* tier applies would be exactly the "silently
  repaired" failure AGENTS.md invariant #7 forbids.
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
- `src/domain/rules/vatcaRevisedCuration.ts` — originally 3 rate rules (23%
  standard, 13.5% reduced, 4.8% livestock), the first in this KB to carry a
  real `numericValue`/`unit: 'percent'` rather than `conditions` to
  evaluate: a rate is a fact, not a test, the same reason `vat.charge_general`
  (s.3) has no conditions either. The standard rate's `effectiveFrom`
  (2021-03-01) is not a guess — s.46(1A)'s own text states a temporary 21%
  substitution running only "from 1 September 2020 to 28 February 2021",
  which is itself proof, from the statute's own words, that 23% resumed
  immediately after. The 13.5%/4.8% rules carry no comparable textual
  evidence of an exact commencement date, so their `effectiveFrom` is
  honestly the date this KB confirmed them, not a claim about how long
  they've actually been in force. Deliberately not curated at first: five
  narrower, date-boxed 9% carve-outs in the same subsection — **curated in a
  later pass, see "The five 9% second-reduced-rate carve-outs (issue #129)"
  below.**
- **VAT rate exclusivity (issue #136 bugs 1 and 8) — added in a later pass.**
  Because the three headline rate rules above carry no `conditions`, and
  `transactionLookup.ts` treats an empty condition list as "matches whenever
  the topic and effective window match" (the opposite default from the
  coding-rules engine, deliberately, for statute-derived facts — see "Empty
  conditions mean different things in the two engines" below), all three
  matched *every* VAT-topic transaction: a solicitor invoice or a US SaaS
  reverse charge would quote 23%, 13.5% and 4.8% simultaneously. Two fixes,
  both in `vatcaRevisedCuration.ts` and `transactionLookup.ts`:
  1. `vat.rate_livestock_current` now carries a real condition — a keyword
     match against VATCA s.2(1)'s own "livestock" definition — instead of
     matching unconditionally.
  2. Two new rules give the one Schedule 3 sub-category issue #136 bug 8
     named (restaurant/catering/hot-takeaway food) an explicit, dated pair:
     `vat.rate_restaurant_catering_reduced_current` (13.5%, keyword-
     conditioned, `effectiveTo: '2026-07-01'`) and
     `vat.rate_hospitality_9pct_not_modelled` (same keyword condition,
     `effectiveFrom: '2026-07-01'`, `vatEffect: null` — it deliberately
     asserts no rate). The cutoff date comes from
     `docs/statutes/vat-rates/schedule-moves-2025-2026.md` (Revenue's own
     administrative rates table, citing Finance Act 2025 ss.70-71 — not yet
     independently verified against that Act's enacted text, which this KB
     does not ingest), not a guess.
  3. `transactionLookup.ts`'s new `resolveVatRateExclusivity` (called from
     `lookupTransactionRules`, right before `possibleTreatment` is built):
     among matched `topic: 'vat'`, `ruleType: 'rate'` rules, if any matched
     with a *real* (non-empty) condition — a Schedule 2/3 item, the
     conditioned livestock rule, or the hospitality-gap rule — every
     empty-condition rate rule is dropped. Otherwise, only
     `VAT_STANDARD_RATE_FALLBACK_RULE_KEY`
     (`vat.rate_standard_current`) survives among the empty-condition rate
     rules; `vat.rate_reduced_current` on its own is never presented as the
     answer, because an unconditioned "the reduced rate is 13.5%" fact is
     not itself evidence that a given transaction is within Schedule 3. A
     reviewReason records what was excluded and why. Restaurant/catering
     supplies dated on or after 1 July 2026 therefore come back with *no*
     asserted rate and a review reason naming the modelling gap — matching
     issue #136 bug 8's own stated expectation ("review + '9% second
     reduced rate not modelled'"), not a guessed 23% or a stale 13.5%.
- `docs/statutes/vat-rates/current-vat-rates.md`, `schedule-moves-2025-2026.md`
  and `rates.json` are **not sources** and back no rule: none carries a
  source hash, and each is a hand-compiled reference table (a Revenue rates
  page transcribed by year, and a note cross-referencing Finance Act 2025 and
  S.I. 69/2025 provisions not yet ingested here). `rates.json`'s own `note`
  field makes the same point the LRC-revised-text fix above already
  established from a real source: "Do not use VATCA s.46 as enacted (21%)".
  They are useful for a human cross-checking this KB's curated rates by eye,
  but are never read by any ingestion code.

### Issue #143: E2E persona harness findings

A 15-business, 26-transaction end-to-end retest (sole traders, an LTD, a
partnership, a farmer, a non-established EU supplier, a principal
contractor, hospitality, a garage, a bookshop, a children's-clothing
retailer, an unregistered RCT subcontractor) surfaced eight further gaps
once the issue #136 fixes above were in place. All eight are fixed here;
none required new ingestion, all are curation/engine changes on top of
already-ingested sources.

- **Finding A — unregistered SMEs never reached the `vat` topic.**
  `identifyTopics`'s `vat` test already routed on a bare `supplyType`
  (issue #136's own topic-routing fix), but a caller who stated
  `vatRegistered: false` or supplied only a turnover figure, with no
  `supplyType` and no VAT keyword yet, still never opened the topic — so
  `supplyType`'s own absence never even got a chance to become an
  `unresolvedFields` entry. Fixed by adding `vatRegistered === false`,
  `annualTurnoverCurrentYearMinor != null` and
  `annualTurnoverPreviousYearMinor != null` as further routes into `vat`.
- **Finding B — the VATCA s.6(1)(c)(ii) 90%-of-turnover test was missing.**
  `vat.registration_threshold_goods` conditioned on the euro figure and the
  turnover-window field, but not on the statute's own proviso: paragraph
  (c)(i)'s goods-threshold test "shall apply only if at least 90 per cent
  of the total annual turnover... is derived from the supply of taxable
  goods" — so a mixed trader below that share (e.g. 70% goods / 30%
  fitting services) would incorrectly match the goods threshold on euro
  figure alone. Fixed by adding a new `goodsShareOfAnnualTurnoverPercent`
  `TransactionContext` field and a `>= 90` condition
  (`financeAct2024VatThresholdsCuration.ts`); absent, the rule is
  unresolved rather than assuming a pure-goods share.
- **Finding C — `RCT_SCOPE_RE`'s `\brenovat\b` never matched "renovation".**
  A bare word-boundary around the four-letter stem `renovat` only matches
  that literal string as a complete word, which never occurs in real
  English ("renovation"/"renovate"/"renovating" all failed). Fixed by
  widening it to `renovat\w*` (`rctCuration.ts`) — construction-on-a-
  dwelling is the core RCT/VAT overlap this regex exists to catch.
- **Finding D — deductibility exclusivity was not enforced.**
  `vat.input_deduction_general` (s.59) and
  `vat.deduction_exclusions_entertainment` (s.60(2)(a)) can both genuinely
  match the same transaction (a client restaurant meal, or petrol) — the
  general rule's own curated `exceptions` already record that the
  exclusion overrides it, but nothing before this fix actually enforced
  that. `transactionLookup.ts`'s new `resolveDeductionExclusivity` (called
  right after `resolveVatRateExclusivity`) drops
  `VAT_GENERAL_DEDUCTION_RULE_KEY` whenever any rule in
  `VAT_DEDUCTION_EXCLUSION_RULE_KEYS` (both exported from
  `vatcaCuration.ts`) also matched.
- **Finding E — the two declaratory SI 69/2025 facts polluted every VAT
  transaction.** `vat.registration_threshold_turnover_test` and
  `vat.annual_turnover_definition` (added for issue #136 bug 2) are
  citation facts, not per-transaction determinations, but their
  `topic: 'vat'` meant they attached to any VAT-topic transaction
  regardless. Retopic'd to `vat_reference` (`si692025Curation.ts`) — a
  topic `identifyTopics` never routes to, so they stay directly citable by
  `ruleKey` (`lookupTaxRule`) without auto-attaching.
- **Finding F — the company's own profile never reached the lookup.**
  `companyType`, `vatRegistrationStatus` and `vatAccountingBasis` are
  columns on the `companies` row, never previously read by
  `lookupTransactionRules`; a cash-basis trader's own accounting-basis
  setting was silent unless the *transaction description* happened to say
  "cash basis". `lookupTransactionRules` now fetches the company row and
  exposes `companyType`/`companyVatRegistrationStatus`/
  `companyVatAccountingBasis` as facts a condition can reference —
  additively, never overwriting the transaction's own fields (a specific
  transaction's `vatRegistered` still means what the caller stated for
  it). A new derived `cashBasisIndicated` fact (true on either the
  description keyword match or `vatAccountingBasis === 'cash_receipts'`)
  is what `vat.cash_accounting_turnover_threshold`/
  `_supplies_to_unregistered_persons_test` now condition on, replacing the
  description-only match. `companyType` (sole trader vs LTD vs partnership
  vs foreign company) and the farmer flat-rate scheme remain unconsumed by
  any curated rule — no rule cites them yet, which is a curation gap, not
  a plumbing one; the flat-rate scheme specifically needs its own source
  pass before there is anything to condition on.
- **Finding G — the restaurant/hospitality rules matched goods, not just
  services.** "Takeaway coffee" sold as `supplyType: 'goods'` (a bag of
  beans, not a hot prepared drink) matched the hospitality-gap rule on
  keyword alone. Restaurant/catering is a supply of *services* (VATCA
  Schedule 3 paragraph 1(1)); both
  `vat.rate_restaurant_catering_reduced_current` and
  `vat.rate_hospitality_9pct_not_modelled` now also require
  `supplyType: 'services'`.
- **Finding H — `rct.deduction_rate_not_determinable` was typed as a
  `ruleType: 'rate'`.** It states that no rate can be determined, not a
  rate figure, so it showed up in the same list as real 23%/13.5%/4.8%
  matches and could confuse any consumer filtering `ruleType === 'rate'`
  (including this KB's own VAT rate-exclusivity logic, had it ever shared
  a topic with a VAT rate rule). Changed to `ruleType: 'other'`
  (`rctCuration.ts`).

### Issue #145: an accounting test pack's exception rows were posted, not flagged

Issue #143 fixed the deterministic *lookup*, but a separate accounting test
pack (200 bank rows, 26 sales invoices, 32 purchase invoices) showed that the
*posting* path — `createInvoice`, `calculateVat`/`createVatEntries` — still
trusted evidence it should not have, and that the lookup's own topic routing
still let a non-trading bank line reach a VAT rate. All five defects below
are fixed here without changing what any curated rule states — only what a
document's own figures are trusted to mean once posted.

- **Defect 1 — a stated VAT amount was trusted even when it could not be
  right.** `calculateVat` used `statedVatMinor` unconditionally whenever it
  was supplied, with no check against the treatment's own rate or the
  supplier's country. Fixed on two fronts:
  - `vatDiscrepancy` (already written, never called) is now actually used:
    `createInvoice` compares a purchase line's stated VAT against what the
    treatment's own rate implies, and when they disagree by more than one
    cent, the VAT is still costed as stated (the evidence is not
    overwritten) but held back from recovery — `recoverableVatMinor` is
    forced to zero via a new `recoverableOverrideMinor` on
    `CalculateVatInput`/`CreateVatEntriesInput` — and a
    `uncertain_vat_treatment` review item is raised.
  - The same override fires when a non-reverse-charge (domestic) treatment
    is applied to a line whose supplier's country is not `IE`: a non-Irish
    supplier is not entitled to charge Irish VAT, so a domestic treatment
    trusting a figure off their document is never assumed correct.
- **Defect 3 (VAT engine half) — a reverse-charge line trusted whatever the
  foreign document stated as its self-assessed amount.** A supplier who is
  not Irish-VAT-registered cannot validly state Irish VAT at all, so a
  figure on their invoice is not evidence of anything — yet
  `calculateVat` fed `statedVatMinor` straight through even under
  `treatment.isReverseCharge`. Fixed: under reverse charge, `calculateVat`
  now *always* self-assesses via the treatment's own rate on the net,
  on both the net and gross input paths, and ignores any stated figure
  entirely. `createInvoice` separately raises a review item (no numeric
  override — self-assessment is already correct) when a reverse-charge
  line's document states a nonzero VAT figure, since that is itself worth
  a human's attention regardless of whether the number happens to agree.
- **Defect 2 — the same commercial document, entered twice under different
  invoice numbers, was posted twice.** `duplicateInvoiceNumbers`
  (`review/anomalies.ts`) only ever caught the *same* invoice number
  appearing twice. A new `nearDuplicatePurchaseInvoices` check groups
  purchase invoices by supplier + net amount + currency and flags any pair
  dated within 5 days of each other, regardless of invoice number — wide
  enough to catch a duplicate entry, narrow enough that a genuine monthly
  subscription at a flat price (a month apart) is not flagged.
- **Defect 3 (lookup half) — a non-trading bank line still reached a VAT
  rate.** `identifyTopics`'s `vat` test opens on `vatRegistered === true`
  alone (needed so an ordinary VAT-registered purchase reaches the topic at
  all), which also opened it for director drawings, a Revenue VAT/PAYE
  settlement, an ATM withdrawal, or an unidentified receipt — none of which
  is a supply of goods or services. Fixed with a
  `NON_TRADING_BANK_NARRATIVE_RE` gate (director/drawings/funds
  introduced/revenue payment/VAT settlement/PAYE/ATM/cash withdrawal/
  unknown/unidentified) that closes the `vat` topic for a bare bank
  narrative — but only when `supplyType` is absent, so a real invoice is
  never affected by how its own narrative happens to read.
- **Defect 4 — lookup and posting could name two different rates for the
  same meal.** `lookupTransactionRules` proposes the reduced hospitality
  rate for a restaurant/catering narrative, but nothing checked that an
  *already-posted* purchase line agreed. A new `hospitalityRateMismatches`
  anomaly (`review/anomalies.ts`) flags a purchase line whose description
  matches the restaurant/catering keyword set but was posted at the 23%
  standard rate — informational, since a bundled bill can genuinely mix
  rates, but worth a look. (The separate section 60 entertainment-deduction
  question — issue #143 finding D — is independent of the rate charged and
  was already handled by `resolveDeductionExclusivity`.)
- **Defect 5 — a donation was posted as an ordinary zero-rated purchase.**
  A donation is not a trading supply; posting it as a purchase line
  conflates a non-trading appropriation with turnover. A new
  `possibleNonTradingPurchases` anomaly flags a purchase line whose
  description reads as a donation or charitable payment
  (`/\b(donation|donated|charity|charitable)\b/i`) — informational, asking
  for reclassification rather than assuming it.

### Issue #147: test-pack leftovers after #145

A further retest of the same accounting test pack against `main` `cc2a1a4`
(after #145) found four more misses, all narrower gaps in the fixes above
rather than new categories of problem. Two rows from the pack are left as
explicit, documented gaps rather than fixed here.

- **Finding 1 — the hospitality keyword set was narrower than the pack's
  own wording.** The bank narrative for `ENT-001` ("Restaurant - business
  dinner") matched `HOSPITALITY_KEYWORD_RE`, but purchase invoice PI-017's
  own line description is only "Business dinner" — no
  "restaurant"/"catering" wording at all, so `hospitalityRateMismatches`
  never fired on it. Widened to also match
  `dinner|lunch|meal|entertainment` — the same vocabulary
  `vat.deduction_exclusions_entertainment`'s own condition already uses.
- **Finding 2 — a bare "CARD PAYMENT" narrative still opened the `vat`
  topic.** `NON_TRADING_BANK_NARRATIVE_RE` (issue #145 defect 3) covered
  `unknown`/`unidentified` but not a card payment with literally no other
  identifying text (UNKNOWN-002). A new `BARE_CARD_PAYMENT_RE` closes the
  topic specifically for a description that, trimmed, is exactly "CARD
  PAYMENT" — deliberately an exact match rather than a substring test, so
  "CARD PAYMENT - AWS DUBLIN" (a real, evidenced merchant) is unaffected.
  MISMATCH-001 (a named merchant, "Computer Equipment Ltd", whose bank
  amount disagrees with its matched invoice by €5) is a **known, explicit
  gap**: that is an invoice-vs-bank-transaction reconciliation question,
  not a topic-routing one, and `identifyTopics` has no visibility into a
  transaction's matching state at all — a real merchant name is correctly
  routed to `vat`, whatever the mismatch turns out to be.
- **Finding 3 — an invoice from "Unknown Supplier" was posted and its VAT
  fully recovered.** The supplier *name* is the only signal `createInvoice`
  had; nothing read it. A new `UNIDENTIFIED_SUPPLIER_RE` check
  (`invoices.ts`) holds back recovery (`recoverableOverrideMinor: 0`) and
  raises a review item whenever a purchase invoice's own supplier record
  matches `/\bunknown\b|\bunidentified\b/i` — checked first and applied
  regardless of treatment, including under reverse charge, since not
  knowing who was actually paid undermines a reverse-charge
  self-assessment just as much as a domestic one.
- **Finding 4 — bank-side duplicate payments were never scanned.**
  `nearDuplicatePurchaseInvoices` (issue #145 defect 2) only ever looks at
  invoices; DUP-001/DUP-002 (two outflows of the same amount to the same
  supplier, days apart, with no second invoice at all) and DUP-ANT-01 (a
  second payment against an already-settled invoice) are bank-only facts.
  A new `duplicateBankPayments` anomaly groups bank transactions by
  counterparty (`supplierId` or `customerId`) and *signed* `amountMinor`
  (so an outflow and an inflow of the same magnitude are never treated as
  duplicates of each other) and flags a pair within 5 days — the same
  window, and the same recurring-charge rationale, as the invoice-side check.
- **Finding 5 (lower priority, not fixed) — a supplier refund still reads
  as a standard-rated supply.** `REF-001`–`REF-004` correctly should not be
  counted as income, but nothing in this KB distinguishes a refund/offset
  of an earlier purchase from a new supply — there is no `transactionType`
  or similar signal for it yet. Left as an explicit gap: inventing a
  "refund" heuristic without a concrete signal to condition on would be
  exactly the kind of guess AGENTS.md invariant #7 exists to prevent.

### Issue #149: the bank duplicate detector never fired on a fresh import

PR #148's `duplicateBankPayments` was correct but never reached on the path
a user actually hits: a raw statement import.

- **Defect 1 — the check required `supplierId`/`customerId`, which
  `importStatement` never sets.** Classification (coding rules, accepted
  matches) is what fills those in, and a fresh company has neither yet — so
  a 200-row import produced zero `duplicate_bank_payment` hits, even though
  the same rows produced 14 once something else had already classified
  them. `bankCounterpartyKey` (`anomalies.ts`) now falls back to a
  normalised description when neither id is set, so the check works before
  any classification has happened. A new `GENERIC_BANK_NARRATIVE_RE` keeps
  two otherwise-unrelated, un-narrated lines (a bare "CARD PAYMENT", an ATM
  withdrawal) from being treated as identified at all — the same
  evidence-free vocabulary `NON_TRADING_BANK_NARRATIVE_RE`
  (`transactionLookup.ts`, issue #145 defect 3) already uses, so "two card
  payments of the same amount" is never mistaken for "two payments to the
  same counterparty".
- **Defect 2 — the 5-day window missed the pack's own labelled pair.**
  DUP-001 (21 Mar) and DUP-002 (2 Jul) are the same counterparty and the
  same €1,230 outflow, four months apart — a 5-day window answers "paid
  twice this week", not "paid the same amount again months later", and
  widening it outright would just trade false negatives for false
  positives on any genuine recurring charge. A new, separate
  `possibleAnnualDuplicatePayments` check groups the same way but over a
  full calendar year, at `info` (not `warning`) severity, and reports
  independently of the 5-day check rather than replacing it.

### Issue #151: annual bank-dup check too noisy; exact-string grouping too strict

Two narrower problems in the issue #149 fix, found by the same retest.

- **Finding 1 — `bankCounterpartyKey`'s description fallback required
  exact-string equality.** DUP-ANT-01's own pair of raw bank rows — "SEPA
  PAYMENT Anthropic" and "ANTHROPIC duplicate payment" — describe the same
  counterparty on the same day for the same amount, but do not normalise
  to the same string once bank-generated boilerplate ("SEPA PAYMENT",
  "duplicate payment") surrounds the merchant name differently in each. The
  fallback key is now the *sorted set* of words left after stripping a
  `BANK_NARRATIVE_BOILERPLATE` list (payment/sepa/duplicate/transfer/direct
  debit/standing order/etc.) rather than the whole normalised string — both
  narratives above reduce to `anthropic`. `GENERIC_BANK_NARRATIVE_RE` still
  runs first, so a narrative that is *only* boilerplate (no merchant word
  survives stripping) is still treated as unidentified rather than grouped
  on an empty key.
- **Finding 2 — the annual check flagged every recurring monthly charge.**
  `possibleAnnualDuplicatePayments` grouped on counterparty + amount + year
  with no test for how many times that combination is expected to recur —
  a monthly subscription or fee (GitHub, a Revolut charge) is the same
  amount ten-plus times a year *by design*, and the check produced roughly
  100 `info` rows on one real statement, burying the two rows
  (DUP-001/DUP-002) it exists to surface. Gated to exactly two occurrences
  in the year: three or more is itself evidence of a recognised recurring
  charge, not a duplicate, so those groups are now suppressed entirely
  rather than each occurrence adding another row.

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
  `capitalAllowancesIngestion.ts` — from TCA 1997 s.284 (wear and tear
  allowances): `income_tax.wear_and_tear_allowance_qualifies` — capital
  expenditure on machinery/plant, wholly and exclusively for the trade,
  qualifies for a wear-and-tear allowance. s.284(2) states 15% (general
  plant/machinery) and 20% (certain vehicles) as enacted in 1997 — this
  file's own front matter carries the standing "No LRC revised TCA; later
  Finance Acts may have substituted this section" warning, and Ireland's
  actual capital allowances regime for most plant/machinery today is 12.5%
  straight-line, not either enacted figure — so this rule states only the
  *qualification* test, never a rate.
- **The current 12.5% rate itself (issue #132).** Unlike VATCA 2010, there
  is no LRC-revised TCA 1997 corpus to fetch the current text from, so the
  VATCA-s.46 pattern (ingest the revised text) doesn't directly apply.
  Instead, `income_tax.wear_and_tear_rate_current` is curated from
  **Finance Act 2003 s.23** — the amending Act that actually inserted TCA
  1997 s.284(2)(ad), 12.5% of actual cost, for capital expenditure incurred
  on or after 4 December 2002 — confirmed by first reading Finance Act 2001
  s.53 (which inserted an earlier 20% rate from 1 January 2001) and finding
  it itself superseded by FA 2003 s.23. `docs/statutes/finance-act-2001/
  s53.md` exists verbatim on disk for the trail but is not ingested — no
  rule needs to state a superseded, decades-stale figure. `capitalAllowances
  Ingestion.ts` reuses `parseTca1997Section` directly for the FA 2003 s.23
  file (same one-section-per-file, bare-`"N."`-opener shape as s.530; both
  are now read from their pages in the rules catalogue, #556),
  since that parser's logic is structural, not TCA-1997-specific — only the
  knowledge-source citation/URL metadata needed a small dedicated ingestion
  function, `ingestFinanceAct2003S23`. A companion Revenue TDM
  (`docs/statutes/tdm-04-08-12/04-08-12.md`, Part 04-08-12 "Capital
  Allowances and Rented Residential Premises") restates the same 12.5%
  figure for the Case V furnished-lettings context — exists verbatim on
  disk but is not itself ingested, since the statute already states the
  figure and `sourceHierarchy.ts` would rank it above the TDM anyway.

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
  criteria would mean inventing text this KB does not hold. (A companion
  rule sourced from Revenue's own guidance now states those criteria in
  full — see "Revenue TDM 38-01-03b (Mandatory E-Filing Exclusion)" below.)

### S.I. 69/2025 (Cash Accounting Thresholds, the Registration-Threshold Turnover Test, and the Cross-Border SME Scheme's Deductibility Restriction + Union Threshold)

Closes gaps flagged, not fixed, in earlier passes — Regulation 8 first,
Regulations 5 and 9 added later for issue #136 bug 2 / issue #137, Regulation
7 and the Regulation 9 "Union threshold" definition added later still for
issue #130:

- `src/domain/rules/si692025Parser.ts` extracts one named regulation at a
  time from the whole instrument, rather than parsing every regulation —
  this document's ten top-level regulations sit alongside a newly-inserted
  VATCA Chapter (sections 92B, 92C, 92D) *embedded inside* Regulation 9's
  own substituted text, and "92B." would itself match a naive
  bare-number-opener regex the way S.I. 639/2010's regulations do. Rather
  than build a whole-document parser that has to tell a top-level
  regulation boundary apart from a nested inserted-section number,
  `parseSi692025Regulation` finds one named regulation's own `"^N. "`
  line-start marker and the next top-level regulation's marker (or end of
  document) as its boundary — the same targeted approach
  `vatcaRevisedSectionParser.ts` uses for a single VATCA section. It is
  generic over the regulation number, so `si692025Ingestion.ts` calls it
  for Regulations 5, 7, 8 and 9 from the same already-fetched file, each
  becoming its own `irish_act_provisions` row under one shared
  `irish_knowledge_sources` row (same citation, same content hash — it is
  one physical instrument; the ingestion's idempotency check is scoped to
  citation + hash + *this regulation's own section number*, not "does this
  source have any provision at all", so ingesting a second regulation from
  an already-ingested file doesn't get silently skipped). Regulation 9's own
  provision row is the *entire* inserted Chapter 5 text (ss.92B-92D
  together) — since a curated rule's `statementExcerpt` only needs to be a
  verbatim substring of its own regulation's already-extracted text, citing
  a fact from inside s.92B or s.92C/92D needs no further sub-section
  boundary parsing of its own.
- `src/domain/rules/si692025Curation.ts` / `si692025Ingestion.ts` — six
  rules in total:
  - Two from Regulation 8, which substitutes the *current* text of VATCA
    2010 s.80(1)(a) and (b) (the eligibility test for the moneys-received/
    cash basis of VAT accounting): `vat.cash_accounting_turnover_threshold`
    (€2,000,000 total annual turnover, not exceeded and not likely to
    exceed, in any continuous 12-month period — stored as `200,000,000`
    `eur_minor` per AGENTS.md invariant #1, money is integer minor units)
    and `vat.cash_accounting_supplies_to_unregistered_persons_test` (at
    least 90% of annual turnover from supplies to unregistered persons). A
    person need only satisfy one test, not both.
  - `vat.registration_threshold_turnover_test`, from Regulation 5, which
    substitutes the current "has not exceeded, in the current calendar
    year or the previous calendar year" test into VATCA s.6(1)(c)/(d) — the
    actual accountable-person test the flat s.2(1)/s.78 threshold figures
    (see "Finance Act 2024 VAT Registration Thresholds" below) are tested
    against. Declaratory (empty `conditions`, like a citation fact); the
    Finance Act rules are the ones that actually gate on it.
  - `vat.annual_turnover_definition`, from Regulation 9, stating VATCA
    s.92B's definition of "annual turnover" (excludes VAT and capital-asset
    disposals entirely; includes goods/services/immovable-goods/insurance
    supplies unless incidental) — the definition both the turnover test
    above and the EU cross-border SME scheme rely on. Also declaratory.
  - `vat.cross_border_sme_scheme_input_deductibility_restriction` (issue
    #130), from Regulation 7, which inserts VATCA s.60(4): a person may not
    deduct input VAT on expenditure incurred for the purpose of supplies
    made under the cross-border SME exemption scheme (VATCA Chapter 5 of
    Part 10, inserted by Regulation 9). States no numeric figure — a real
    deductibility restriction, but declaratory (`topic: 'vat_reference'`,
    empty `conditions`): this KB has no transaction-context signal for
    "this expenditure relates to a cross-border SME scheme supply", so it
    is not wired to a mechanical, always-on condition.
  - `vat.cross_border_sme_scheme_union_threshold` (issue #130), from
    Regulation 9, stating VATCA s.92B's definition: `'Union threshold' means
    €100,000` — stored as `10,000,000` `eur_minor` per AGENTS.md invariant
    #1. The figure a taxable person's Union (cross-Member-State) annual
    turnover must not exceed to remain eligible for the cross-border scheme
    (ss.92C(1)(c), 92D(1)(e)). Also declaratory.
- This closes exactly the threshold "S.I. 639/2010 (VAT Regulations 2010)"
  above explicitly said was *not* curated there: "the real threshold lives
  in VATCA 2010 s.80(1) itself" (Regulation 25 only requires the Revenue
  authorisation, it states no eligibility figure of its own). With this
  source ingested, both eligibility limbs are now real, current, curated
  rules — effective from 6 March 2025, the date this instrument was made
  (it carries no separate commencement clause).
- ss.92C/92D's own registration, notification and quarterly-reporting
  mechanics (the 35-working-day response window, the 15-working-day
  threshold-breach report, the quarterly turnover report, and so on) remain
  **not** curated — they are Revenue-administration procedure, not a VAT
  amount or deductibility test, and feed no figure this KB computes today.
  Regulations 1-4, 6 and 10 (definitions, consequential/commencement
  provisions, and a Schedule 9 insertion) also remain **not** curated in
  this pass — left for a future pass.

### Finance Act 2024 VAT Registration Thresholds

Not a new source — Finance Act 2024 was already ingested in full above —
just a missed derive step, found while auditing what the already-ingested
Act still holds:

- `src/domain/rules/financeAct2024VatThresholdsCuration.ts` /
  `financeAct2024VatThresholdsIngestion.ts` — two rules from s.78
  (amendment of VATCA 2010 s.2(1)'s "goods threshold" and "services
  threshold" definitions): `vat.registration_threshold_goods` (€85,000) and
  `vat.registration_threshold_services` (€42,500), both effective 1 January
  2025, stated in the section's own text.
- Both rules also condition on `annualTurnoverMaxMinor` (`gte` the
  threshold) — a field `transactionLookup.ts` derives as the greater of
  `annualTurnoverCurrentYearMinor`/`annualTurnoverPreviousYearMinor`,
  implementing the actual VATCA s.6(1)(c)/(d) test (see
  `vat.registration_threshold_turnover_test` above). Before this condition
  existed, the rule matched off `supplyType` alone, so a single low-value
  invoice "matched" a registration-threshold rule regardless of the
  business's actual turnover (issue #136 bug 2 / issue #137) — now, absent
  turnover data, the rule is correctly unresolved rather than falsely
  matched.
- s.78 states two independent euro figures in one section, which the
  generic `SECTION_RULE_KEYS`/`extractFactsFromProvision` pipeline
  (`factExtractor.ts`) is not built to split — that pipeline picks a single
  fact per curated section. Rather than extend a shared, already-relied-on
  mechanism for one two-value section, this is a small dedicated curation
  in the same style as the S.I. modules above: explicit statement excerpts
  and explicit numeric values (`8,500,000` / `4,250,000` `eur_minor` — real
  cents, per AGENTS.md invariant #1), verified verbatim against the stored
  provision text by a dedicated test.
- s.78's mechanical category is `'definitions'` — its text says "in the
  definition of ... threshold", which matches the definitions keyword rule
  before anything VAT-specific — so Finance Act 2024's original ingest
  marked it *not relevant* by the default categoriser, and it was never
  extracted. `deriveFinanceAct2024VatThresholds` corrects that provision's
  `relevant` flag when it derives these rules: the same curated-override
  judgement `SECTION_RULE_KEYS` makes for other sections at ingest time,
  just applied after the fact since this section was reviewed later than
  the rest of the Act.
- The two rules route on an explicit `supplyType` ('goods' | 'services')
  field, never inferred from free text — this KB cannot tell from a
  description alone whether a transaction is a supply of goods or of
  services, and guessing wrongly here would apply the wrong threshold.

### Revenue TDM 38-01-03b (Mandatory E-Filing Exclusion)

The first source ingested purely to close a gap left by a *different*
already-ingested source, rather than to extract new content in its own
right:

- `src/domain/rules/tdm3801_03bParser.ts` extracts one named passage —
  "Exclusion from Mandatory Electronic Filing and Payment of Tax" — from
  Revenue's 40+ page "Guidelines for VAT Registration" TDM
  (`docs/statutes/tdm-38-01-03b/38-01-03b.md`, genuinely verbatim: a real
  `source_pdf_sha256` from a `pdfplumber`-extracted PDF, not a hand-written
  summary). The passage repeats byte-identically four times in the source
  document (once per registrant-type scenario — resident/non-resident
  individual/company); the parser verifies all four match before extracting
  the first, and throws rather than silently picking one if they ever
  diverge.
- `src/domain/rules/tdm3801_03bCuration.ts` / `tdm3801_03bIngestion.ts` —
  one rule, `vat.mandatory_electronic_filing_capacity_exclusion`: a
  taxpayer who lacks "capacity" (insufficient internet access, or — for an
  individual — prevented by age or mental/physical infirmity) can apply in
  writing to their local tax office to be excluded from S.I. 156/2012
  reg.4's mandatory-electronic-filing obligation.
- This is exactly the gap "S.I. 156/2012 (Mandatory Electronic Filing)"
  above explicitly left open: reg.5's own "capacity" exclusion criteria are
  not restated in this KB because the local si-156-2012 transcript only
  summarises regs 5-9 rather than quoting them. Revenue's own current
  guidance states the same criteria and the application procedure, verbatim
  and independently — a different, lower-ranked source (`revenue_guidance`,
  not `legislation` — see "Source hierarchy" below) than the Regulation
  itself, but genuinely citable rather than invented.

## Rule format

Conceptually, a stored rule looks like:

```json
{
  "rule_id": "taxrule_...",
  "rule_key": "usc.medical_card_2pct_threshold",
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
    { "field": "supplierEstablishedOutsideStateResolved", "operator": "equals", "value": "true" },
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

The `vat` topic also routes on a bare `supplyType` now, `vatRegistered` or
not (a fix that followed the bugs 1/2/4/8 fixes above): the registration-
threshold rules (`vat.registration_threshold_goods`/`_services`) exist to
catch a trader who has crossed the threshold and should therefore *become*
registered, which by definition is usually a currently-*unregistered*
trader — gating the whole `vat` topic on `vatRegistered === true` made that
population unreachable, i.e. `lookupTransactionRules` never even retrieved
the threshold rules as candidates for the exact case they exist to flag.

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

This default is exactly right for a genuinely unconditional fact, but wrong
for a VAT *rate* — exactly one of standard/zero/reduced/livestock always
applies to a real supply, so an unconditioned "the reduced rate is 13.5%"
rule matching every VAT-topic transaction is not a fact, it's a fallback
being mistaken for a determination (issue #136 bug 1). See "VAT rate
exclusivity" above and `resolveVatRateExclusivity` in
`transactionLookup.ts` for how this KB now tells the two apart without
changing the empty-conditions default itself.

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

`provenance.test.ts` proves the provenance every rule claims (issue #442):
each active rule resolves to a source with a URL, names a section and a
locator (the source's own reference, or the re-checkable offsets), carries an
effective date that is never the day the source was fetched (#216), quotes
text verbatim from the provision as ingested with >=90% token coverage in the
re-read file slice, and — where it takes part in transaction matching — has a
stored test case.

`npm test` and `npm run typecheck` both pass as of this change.

Note: `generateDefaultTestCases`'s synthetic positive case only sets `topic`
and `transactionDate` — for a VATCA rule whose conditions need other fields
(`supplyType`, `vatRegistered`, ...) that generic context correctly fails to
satisfy them, so `npm run cli:rules -- test` shows 3 "failures" for the
condition-bearing VATCA rules. That is the generator's known limitation, not
a defect in the rules themselves — see "Limitations".

## Audit report

Generated by `src/domain/rules/audit.ts` (`generateAuditReport`). An early
snapshot is committed at
[`docs/statutes/audit-report.json`](statutes/audit-report.json); its counts are
long out of date. Reproduce a current one with:

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
npm run cli:rules -- ingest --source si69-2025-reg5
npm run cli:rules -- ingest --source si69-2025
npm run cli:rules -- ingest --source si69-2025-reg9
npm run cli:rules -- extract --source si69-2025
npm run cli:rules -- extract --source finance-act-2024-vat-thresholds
npm run cli:rules -- ingest --source tdm-38-01-03b && npm run cli:rules -- extract --source tdm-38-01-03b
npm run cli:rules -- audit
```

or, for every source, `npm run cli:rules -- ingest-all` then `audit`.

The report counts sources, provisions, rules by review status, rules needing
a person or guidance, cross-references resolved and not (with the reason),
duplicate keys and test results, and the rule links: how many of each kind,
the graph findings, and the rules most others rely on. It gives no figures
here because they change with every source added; run it on a loaded book.
Until a person approves them, every rule is `ai_extracted` and
`human_review_required`: none is authoritative.

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
                            vatca-2010-revised | tca1997-s284 | si639 | si156 |
                            si69-2025 (alias si69-2025-reg8) | si69-2025-reg5 | si69-2025-reg9 | tdm-38-01-03b)
extract [--source <s>]     Derive irish_tax_rules from ingested provisions
list-provisions [--category <c>] [--relevant-only]
show-provision --section <n>
list-rules [--topic <t>] [--status <s>]
review --rule <id> --status <s> --by <name> [--notes "..."]
lookup --json '<transaction context>'
generate-tests
test                        Exit code 1 if any test case fails
audit
impact <ruleKey|provisionId|reference>
                            What relies on a rule or provision, transitively, and the computations reading it
depends <ruleKey>           What a rule relies on: rules, and the provisions behind them
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
- **Not every relevant provision has a curated rule key.** Everything is
  ingested (text, offsets, category), but only curated provisions become named
  rules. `docs/rules/coverage-matrix.json` gives each statute row's status
  (`rule`, `not_applicable` with a reason, or `deferred` to an issue), and
  `coverage.test.ts` keeps it current.
- **RCT's actual 0%/standard/35% deduction-rate structure is now in this KB
  (issue #131)**, sourced from TCA 1997 ss.530A/530E/530G/530H/530I as
  inserted by Finance Act 2011 s.20 (as-enacted text — no LRC-revised TCA
  1997 exists for these sections; every `revisedacts.lawreform.ie` URL for
  them 404s, reconfirmed 2026-09-20). What is still **not** in this KB, by
  design: *which* of the three tiers a given subcontractor gets (an
  individualised Revenue determination under s.530I, not a fact any
  transaction record can supply — `rct.deduction_rate_not_determinable`
  states this as the finding), and the numeric value of "the standard rate
  (within the meaning of section 3)" (TCA 1997 s.3 itself is not ingested,
  so `rct.rate_standard_reference` states no `numericValue`, even though
  it is currently published as 20%).
- **The current wear-and-tear allowance percentage is now in this KB
  (issue #132)**: `income_tax.wear_and_tear_rate_current` states 12.5%,
  sourced from Finance Act 2003 s.23 — the Act that actually substituted
  TCA 1997 s.284(2)(ad), not the enacted-1997 s.284(2) text itself (which
  still states the stale 15%/20% figures and is not used for the rate).
  See "Capital allowances" above.
- **S.I. 639/2010 reg.25 itself still states no numeric eligibility
  threshold — that gap is now filled by a different source, not by
  reg.25.** Regulation 25 only requires the Revenue authorisation; the
  actual VATCA 2010 s.80(1)(a)/(b) eligibility tests are now curated
  separately from S.I. 69/2025 Regulation 8 (see "S.I. 69/2025 (Cash
  Accounting Thresholds, and the Registration-Threshold Turnover Test)"
  above) — the two rules together are what a reader
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
  State" onto `supplierEstablishedOutsideStateResolved` (itself a caller's
  direct determination, falling back to an ISO-3166-validated
  `supplierCountry != 'IE'` proxy) is an interpretation; every VATCA
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
- **The pre-existing drizzle-kit snapshot chain was broken** (`drizzle/meta/
  0000_snapshot.json` through `0002` all shared one id/prevId, unrelated to
  this change — `npm run db:generate` failed on it). Migration 0004 here was
  therefore hand-written in the existing SQL style rather than generated;
  it applied and ran cleanly (`npm test`, `npm run db:migrate` both exercised
  it), but a future schema change would have hit the same `drizzle-kit
  generate` failure until that chain was repaired. **Fixed in issue #134**:
  `drizzle/0005_repair_snapshot_chain.sql` (an intentional no-op — see its
  own header comment for the full diagnosis) gave 0001/0002 their own ids
  correctly chained from 0000, and gave migration 0004 the
  `0004_snapshot.json` it never got, so `npm run db:generate` now reports
  "No schema changes, nothing to migrate" against current `schema.ts` and
  will correctly diff any future one.

## Documents reviewed, not curated

Every file below was read and judged during the documents-intake pass, not
skipped. Each is excluded for a stated, checkable reason — verbatim-only
policy, no rule-worthy content, or (a new category below) real-looking
statute text this KB still can't prove is verbatim. None of these back a
curated rule.

**Paraphrase / hand-written summary — no source hash, cannot back a rule:**

- `docs/statutes/tca-1997/s18.md` — a five-sentence prose summary of
  Schedule D Cases I-V, no statutory text at all.
- `docs/statutes/tca-1997/s52.md` — a one-paragraph pointer describing Part
  4's interpretation section, no statutory text.
- `docs/statutes/tca-1997/1997-act-39-ss-885-887.md` — a hand-written
  summary of record-keeping obligations (6-year retention, electronic
  storage, tax-reference-number-on-invoices duty); explicitly says "Full
  section: [link]" rather than quoting it, confirming it is not a capture.
- `docs/statutes/vat3-rtd/vat3-rtd-boxes.md` — a hand-built reference table
  mapping VAT3/RTD return boxes (T1-T4, E1/E2, ES1/ES2, PA1) to their
  meaning, useful for a human but not a capture of an official document.
- `docs/statutes/companies-act-2014/companies-act-2014.md` — a hand-written
  summary of several sections (s.282 accounting records, s.280A/D/E small/
  micro company thresholds, s.352 abridged filing, ss.358-360 audit
  exemption). The thresholds it describes are real and not currently in
  this KB, but this file cannot back them — it would need re-capturing from
  the LRC-revised Companies Act 2014 HTML with a source hash first.
- `docs/statutes/frs-102/frs-102.md` — a citation index only, by design: its
  own front matter says "Do not store the standard text in this repo" (FRC
  copyright). Maps accounting decisions to FRS 102 section numbers; not
  eligible for verbatim ingestion at all.

**Verbatim, reviewed, no new rule-worthy content found:**

- `docs/statutes/import-vat/customs-manual-import-vat.md` — genuinely
  verbatim (`source_pdf_sha256` present). Confirms the Postponed Accounting
  mechanics already understood from other sources (VAT3 boxes T1/T2/PA1,
  CP42 Onward Supply Relief) but states no new numeric threshold or
  obligation beyond what S.I. 639/2010 and the VAT3/RTD box mapping above
  already establish. Left uningested rather than ingested-for-citability-
  only, since no other rule in this KB currently cites it.

**Real-looking statute text with no provenance proof — a genuine gap, not a
paraphrase, and flagged rather than guessed past:**

- `docs/statutes/tca-1997/s235.md`, `s288.md`, `s299.md`, `s496.md`,
  `s613.md` — each reads as full verbatim TCA 1997 section text (s.235:
  athletic/sports body exemption; s.288: balancing allowances/charges on
  disposal of machinery/plant; s.299: deemed ownership for lessees'
  capital allowances; s.496: an obsolete pre-euro relief scheme; s.613: CGT
  exemptions for savings bonuses/betting winnings/certain settlements) —
  but **none carries a `source_pdf_sha256`/`source_html_sha256` or a
  `conversion:` marker** the way every other genuinely verbatim source in
  this KB does (compare s.530 or s.284, whose copies did; both are now
  read from their pages in the rules catalogue). This KB's verbatim-only policy is about provable provenance,
  not just plausible-looking prose, so these five are **not** ingested
  despite reading like the real thing. s.288 in particular (capital
  allowances balancing mechanics) would be a genuine curation candidate if
  re-captured with a real hash; s.496 and s.613 are outside this KB's VAT/
  registration/RCT/cash-accounting scope even if re-captured.

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

### Companies Act 2014 size thresholds (issue #135)

The first source outside VAT, RCT and capital allowances — company size
classification (small/micro company) and the filing/audit-exemption
consequences that turn on it, a distinct subject from every prior source
(never a VAT rate, never a withholding rate). Previously the KB held only a
hand-written paraphrase, `docs/statutes/companies-act-2014/companies-act-2014.md`,
which carries no source hash and cannot back a curated rule under this KB's
verbatim-only policy.

- Eight sections fetched verbatim from the LRC-revised Companies Act 2014
  (`docs/statutes/companies-act-2014/s282.md`, `s280A.md`, `s280D.md`,
  `s280E.md`, `s352.md`, `s358.md`, `s359.md`, `s360.md`), each with a real
  `source_html_sha256`, via a new `extract_companies_act_2014()` in
  `docs/statutes/scripts/extract_vat_sources.py` — the same per-section LRC
  fetch shape `vatca-2010-revised/` already uses. s.359(3)-(12) are genuine
  LRC deletions (superseded by the 2016/2017 statutory-audit restructuring),
  rendered as bare "…" in the fetched text; nothing is curated from them.
- `src/domain/rules/companiesAct2014SectionParser.ts` — a new parser shape:
  this Act's operative-text marker is a bare `"<N>."` alone on its own line,
  with no em-dash at all (unlike VATCA's `"46\n.—(1)"` convention, which
  never matches here), verified against all eight fetched files.
- `src/domain/rules/companiesAct2014Ingestion.ts` —
  `ingestCompaniesAct2014Section`/`ingestAllCompaniesAct2014Sections`/
  `deriveCompaniesAct2014Rules`, mirroring `vatcaRevisedIngestion.ts`'s
  idempotency and per-section-as-its-own-source discipline; wired into the
  CLI as `--source companies-act-2014` (ingests all eight; no single
  default file to point `--file` at).
- `src/domain/rules/companiesAct2014Curation.ts` — ten rules from six of the
  eight sections: the s.280A small-company 2-of-3 test's three independent
  limbs (turnover €15m, balance sheet €7.5m, employees 50) as three separate
  rule keys (the same split `financeAct2024VatThresholdsCuration.ts` uses
  for one section stating two independent figures); the s.280D micro-company
  test's same three-limb split (€900,000/€450,000/10 employees); the s.352
  abridged-filing exemption; and the s.358/s.359/s.360 audit-exemption gate/
  gate/effect. s.280E (states no figure of its own) is ingested for
  citability but backs no separate rule.
- **Every rule carries `conditions: []`, deliberately.** Unlike VATCA's
  registration/cash-accounting thresholds — wired to real
  `TransactionContext` fields (`annualTurnoverCurrentYearMinor` etc.) — this
  KB has no company-level "turnover", "balance sheet total" or "average
  employees" field anywhere (neither on `companies` nor on
  `TransactionContext`), and Companies Act "turnover" is not the same legal
  concept as VAT taxable turnover. Fabricating a condition against a
  nonexistent field, or silently reusing the VAT field for a different test,
  would be exactly the kind of invented match AGENTS.md invariant #7
  forbids — so these rules state the figures/tests for a human to apply, the
  same "criteria without evaluating them" treatment `rctCuration.ts` already
  gives Revenue's rate criteria (a 3-year compliance history is not
  transaction data either).
- `topic: 'company_filing_reference'` is deliberately not one of
  `transactionLookup.ts`'s `TOPIC_RULES`, so none of these ten rules is ever
  auto-routed to for a bank transaction or invoice lookup — the same
  `_reference` convention `si692025Curation.ts` established for declaratory
  citation facts. All ten remain directly citable by `ruleKey` via
  `lookupTaxRule`.
- Not curated: s.280A(2)/(4) and s.280D(2)/(4)'s own multi-year/exclusion
  provisos (referenced in each rule's `interpretationNote`, not modelled);
  s.317 (the employee-averaging method both Act sections defer to); s.280B
  (the small-group test s.358/s.359 both defer to); s.353/s.355/s.356 (what
  "abridged" statements must contain, their approval, and the special
  auditors' report s.352 defers to) — none of these is ingested here.
- **Issue #554** adds s.280B (small groups), s.280C (the small companies
  regime) and s.280F (medium companies) to the fetched set, three medium-
  company limbs (€50m / €25m / 250 employees), and Schedule 3A
  (`schedule-3A.md`, whose Format 1 headings `src/domain/reports/schedule3A.ts`
  quotes verbatim). The s.280A, s.280D and s.280F turnover and balance
  sheet thresholds were re-dated from 2026-09-20 (the day they were fetched)
  to 2024-07-01, when S.I. No. 301 of 2024 substituted them. The two-year and
  exclusion provisos are now applied by `src/domain/reports/companySize.ts`
  on the books' figures, with a person recording what the books cannot know
  (exclusions, the year before, the average number of employees where
  payroll does not hold it).
- **Issue #555** ingests S.I. No. 301 of 2024 (`docs/statutes/si-301-2024/`,
  `sizeCriteriaIngestion.ts`). Reg. 2 is only its commencement (1 July
  2024); reg. 9 inserts s.280I, under which the company elects whether the
  substituted figures apply to financial years beginning on or after
  1 January 2024 or 1 January 2023. The replaced figures (€12m / €6m small,
  €700,000 / €350,000 micro, €40m / €20m medium) are curated from regs 4, 6
  and 7 as `_pre_2024` rule keys dated from the 2017 insertion, alongside
  `company.size_criteria_financial_year_election`. The size test picks the
  set per financial year from its start date and the recorded election. The
  employee limbs, never amended, now date from 9 June 2017.

### Tax rate sync (issue #133)

The first change in this KB's history that writes to the *application's own*
tables (`tax_rates`), not just `irish_knowledge_sources`/`irish_act_provisions`/
`irish_tax_rules`. `docs/statutes/vat-rates/rates.json` (a hand-compiled,
effective-dated VAT rates table, cross-checked against this KB's curated
figures but carrying no source hash of its own) had sat unused since it was
added — this issue's own text posed the choice explicitly: load it directly
into `tax_rates`, or drive `tax_rates` from the already-verified curated
rules instead and leave `rates.json` reference-only.

**Decision: the latter.** `rates.json` backs no rule under this KB's
verbatim-only policy (`docs/statutes/SOURCE-REGISTER.md`), so it was never a
candidate to drive live financial configuration that directly determines
invoice VAT — only a source-hash-verified fact is. `tax_rates` is instead
synced from the curated VATCA s.46 rate facts already ingested and tested
(`vatcaRevisedCuration.ts`'s `vat.rate_standard_current`/
`vat.rate_reduced_current`/`vat.rate_livestock_current`), the same three
this KB independently confirmed against the LRC-revised text for "VATCA
2010 current rates" above.

- `src/domain/rules/taxRateSync.ts` — `syncTaxRatesFromIrishRules(db,
  {companyId})`, mapping each of the three ruleKeys above to its
  `tax_rates.code` (`VAT_STD`/`VAT_RED`/`VAT_LIVESTOCK`, from
  `DEFAULT_TAX_RATES` in `src/domain/config/vatTreatments.ts`). A curated
  rule is only trusted to drive live config once a human has approved it
  (`reviewStatus: 'approved'` or `'active'`) — an `ai_extracted` rule is
  exactly as unreviewed here as everywhere else in this KB, and live
  invoicing config is not the place to relax that gate. Wired into the CLI
  as `npm run cli:rules -- sync-tax-rates`, a deliberate manual step (not
  automatic on app load), consistent with this KB's `ingest` -> `extract`
  -> `review` -> (now) `sync-tax-rates` pipeline.
- Never edits a `tax_rates` row in place: a changed figure closes the
  current row's effective window (`src/domain/config/mutations.ts`'s
  existing `supersedeTaxRate`, extended with an optional `source` param so
  the resulting audit event is correctly attributed `'derived'` rather than
  the hardcoded `'user'` every other caller of that function is) and opens
  a new one — README §6 / AGENTS.md invariant #6, the same discipline every
  other rate change in this app already follows. Idempotent: an unchanged
  figure is a no-op past the first run, which only sets the `irish_tax_rules
  .taxRateId` back-link (present in the schema since the original KB design
  but never populated by any curation until now) so a curated rate and the
  config row it backs are traceable to each other.
- Every sync-driven change is also raised as an `info`-severity review item
  (kind `other`, since no existing `review_items.kind` fits a config-sync
  event specifically) — even a verified, approved source changing live
  financial config is surfaced for a human to see, never a silent write
  (AGENTS.md invariant #7).
- Deliberately excluded: `VAT_SECOND_RED` (the second-reduced/9% rate) and
  every non-VAT `tax_rates` row (corporation tax etc.). This KB curates no
  current, unconditional fact for any of them —
  `vat.rate_hospitality_9pct_not_modelled` (see "VAT rate exclusivity"
  above) exists specifically because the second-reduced rate has no such
  fact today (issue #129 tracks modelling it); syncing from an absent
  source would mean inventing one. `DEFAULT_TAX_RATES`' own seeded
  `VAT_SECOND_RED` figure was found, while investigating this issue, to
  already read as stale (seeded as if a standing rate from 2021, when it is
  in fact a temporary hospitality-only carve-out per
  `docs/statutes/vat-rates/schedule-moves-2025-2026.md`) — left as-is
  rather than guessed at here, since fixing it correctly needs the same
  sourced ingestion issue #129 already tracks, not a hand-edited date.
- Since issue #617, `DEFAULT_TAX_RATES` is seeded from these curated rules,
  history included, and cites them:
  - `VAT_STD`: 23% from 2012-01-01, 21% for 2020-09-01 to 2021-02-28 (s.46(1A)), and 23% from 2021-03-01.
  - `VAT_RED`, `VAT_LIVESTOCK` and `VAT_ZERO`: from 2010-11-01.
  - `VAT_SECOND_RED`: from 2020-11-01, the earliest curated 9% period. Which supplies bear it is still decided per
    Schedule 3 paragraph (`scheduleRates.ts`).

  `src/domain/config/seeds.test.ts` fails if a seed and its curated rule disagree. A book seeded earlier gets the
  missing windows from `ensureHistoricalTaxRates`, which fills only dates before a code's earliest row and audits
  each addition. No rate is seeded for a date the sources do not cover, such as the standard rate before 2012, so a
  posting then is refused until a person configures the rate.

### The five 9% second-reduced-rate carve-outs (issue #129)

`vatcaRevisedCuration.ts`'s own header deferred curating s.46(1)'s five
lettered 9% carve-outs — (ca), (caa), (cab), (cac), (cb) — "each needs the
same care as the headline rates". Both source documents this needed were
already ingested (s.46, now `catalogue/vatca-2010-revised/s046.json`, for the carve-outs
themselves, `catalogue/vatca-2010-revised/schedule-3.json` for what each one's Schedule
3 references actually cover), so this closes the gap without any new
ingestion.

- Each lettered paragraph bundles multiple, legally distinct Schedule 3
  subjects under one sentence — (ca) alone covers periodicals, sporting
  facilities AND heat pumps together, and (cb) covers six unrelated
  subjects. Rather than one rule per paragraph with a single grab-bag
  keyword condition (which would blur which Schedule 3 category actually
  matched a given transaction), this curates one rule per distinct subject,
  11 in total, reusing the same paragraph's `statementExcerpt` across
  sibling rules where it bundles more than one — the same pattern
  `vat.rate_restaurant_catering_reduced_current` and `vat.rate_reduced_current`
  already shared one s.46(1)(c) excerpt.
- (ca) (periodicals, sporting facilities, heat pumps) states no commencement
  date of its own in the fetched text, unlike its four siblings, which each
  state an explicit "during the period from X to Y" — its three rules use
  the date this KB confirmed the text as `effectiveFrom`, the same
  "confirmed accurate as of ingest" convention the source-ingestion layer
  already uses, not a historical commencement claim.
- **A real bug was found and fixed on the way**: `vat.rate_restaurant_catering_reduced_current`
  ran from 2010-11-01 with no carve-out for s.46(1)(cb), which
  verbatim-states this exact category (Schedule 3 paragraph 3(1)/(3)) at
  9% — not 13.5% — from 1 November 2020 to 31 August 2023 (a COVID-era
  hospitality relief window). Left uncorrected, a 2021 restaurant
  transaction would have matched both rules at two different rates with no
  way to tell which applied. Corrected by splitting into three
  non-overlapping periods: `vat.rate_restaurant_catering_reduced_pre_9pct_window`
  (13.5%, to 2020-11-01), `vat.rate_restaurant_catering_9pct_2020_2023`
  (9%, the verified window), and the original rule narrowed to start
  2023-09-01. A regression test (`vatcaRevisedIngestion.test.ts`) asserts
  the three periods tile exactly with no gap and no overlap.
- **A subtle date-boundary convention, easy to get backwards**: `lookupTaxRule`'s
  window test is `effectiveFrom <= asOf && (!effectiveTo || effectiveTo >
  asOf)` — a strict `>`. A window meant to cover 31 August 2023 inclusive
  therefore needs `effectiveTo: '2023-09-01'` (the day the NEXT period
  starts), not `'2023-08-31'` (the day the statute's own prose names as the
  last day) — this file's `effectiveTo` values got this backwards on a
  first pass and were corrected before landing; `deriveVatcaRevisedRules`'s
  own supersede step already confirms the convention (a closed row's
  `effectiveTo` is set to the literal `effectiveFrom` of what replaces it,
  never a day earlier). This is the opposite of `src/domain/config/mutations.ts`'s
  `supersedeTaxRate`, which uses `addDays(effectiveFrom, -1)` for `tax_rates` —
  the two tables' effective-dating conventions are NOT interchangeable; the
  boundary semantics must be checked per table, not assumed.
- **Known, deliberate, unresolved overlap**: the new
  `vat.rate_admission_9pct_2020_2023` rule (cinema/theatre/fairground/
  exhibition admission, 2020-2023) genuinely overlaps
  `vat.reduced_rate_cinema_admission` (13.5%, open-ended) in
  `vatcaScheduleCuration.ts` for that same window. That rule's own ingestion
  pipeline (`vatcaScheduleIngestion.ts`) hardcodes one open-ended
  `effectiveFrom` per rule with no per-rule `effectiveTo` support at all —
  unlike this file's pipeline — so it cannot currently express "13.5% except
  during this window" the way the restaurant/catering rule was corrected
  above. For a matching transaction dated in that window, both rules
  surface side by side (13.5% and 9%) rather than one silently winning —
  the safer of two imperfect outcomes, but a genuine follow-up:
  `vatcaScheduleIngestion.ts` needs `effectiveTo` support before this can be
  resolved cleanly.
- `vat.rate_hospitality_9pct_not_modelled` (added for issue #136 bug 8,
  asserting no rate for restaurant/catering from 1 July 2026, sourced only
  from the non-verbatim `schedule-moves-2025-2026.md` reference table) is
  now independently confirmed by this pass: the actual s.46(1)(ca)-(cb) text
  contains no reference to a 1 July 2026 date or to restaurant/catering at
  all. Its "not modelled" stance was correct, not merely pending — left
  unchanged.

### VAT rates by date: Schedules 2 and 3, s.46 versions, Finance Act 2025 (issue #205)

This supersedes the rule keys and gaps described in the two sections above.

- **Every Schedule 2 and 3 paragraph** has a rule (`vatcaScheduleCuration.ts`,
  `vatcaScheduleParagraphRules.ts`), or a justified `not_applicable` row in
  `docs/rules/coverage-matrix.json`.
  - Each rule's window starts on its paragraph's latest LRC amendment
    (`lrcAnnotations.ts`).
  - A Schedule 3 rule states no rate. `scheduleThreeRate` gives the rate for
    its sub-paragraph on the line's date, from the s.46 clauses and Finance
    Act 2025 s.71.
- **A rate is a family of dated versions under one key**, chained by
  `supersedesRuleId`, with only the latest `active`. `deriveVatcaRevisedRules`
  leaves an unchanged version alone and inserts a new one. A stored row that
  no version accounts for is retired: its window is emptied and it is marked
  inactive, never deleted.
  - `vat.rate_standard_current`: 23% from 1 January 2012 (LRC footnote F95),
    21% for the s.46(1A) period, then 23% from 1 March 2021.
  - `vat.rate_hospitality` (Sch.3 3(1), 3(3)) and `vat.rate_hairdressing`
    (13(3)): 9% under (cb), November 2020 to August 2023; 13.5% from January
    2025 to June 2026; 9% from 1 July 2026 under Finance Act 2025 s.71, cited
    from its catalogue entry (`catalogue/finance-act-2025/`).
  - The (ca) categories (periodicals, sporting facilities, heat pumps) start
    on 1 January 2025 (F101), not the retrieval date.
- **Retired keys** (`RETIRED_S46_RULE_KEYS`):
  - `vat.rate_restaurant_catering_reduced_current`
  - `vat.rate_restaurant_catering_reduced_pre_9pct_window`
  - `vat.rate_hospitality_9pct_not_modelled`
  - `vat.rate_restaurant_catering_9pct_2020_2023`
  - `vat.rate_hairdressing_9pct_2020_2023`

  The 2010–2020 13.5% restaurant window is dropped, not moved: s.46(1)(ca)
  put hospitality at 9% for part of that period.
- **Periods the sources cannot settle have no version**, so a line dated in
  one is flagged, not given a rate. These are Schedule 3 lines before
  2025, whose (ca) list is not in the repository, and the standard rate
  before 2012.

### Revenue Notes for Guidance, and the corporation tax and income tax rules (issues #211, #212)

There is no LRC revised TCA 1997, so Revenue's Notes for Guidance (NfG) on the
TCA 1997, Finance Act 2025 edition, are the current statement of each section.
They are a source family of their own:

- Each part is one `revenue_guidance` knowledge source, kept as a pdftotext
  conversion in `docs/statutes/tca-1997-nfg/partNN.md`. Guidance ranks below
  the Act (see "Source hierarchy"), and every rule quoting it says so.
- `tcaNfgParser.ts` cuts one provision per section note. It reads a left-margin
  heading followed by "Summary", "Details" or "Definitions" as a note; the
  indented contents list is skipped. A section the contents list names is a
  note even without those words (a repealed section's note is a sentence or
  two). A test requires every part's parsed sections to equal its contents list,
  so a note can no longer be merged into the one before it (issue #287).
- `tcaNfgIngestion.ts` ingests the sections `NFG_SECTIONS` lists, and
  `corporationTaxCuration.ts` curates rules from them. Each `statementExcerpt`
  is verbatim from the note (a test checks it). These rules carry no transaction
  conditions: the corporation tax computation cites them and reads its rates
  from them.
- `incomeTaxCuration.ts` holds the income tax, USC and PRSI Class S rules for
  sole traders and partners. They quote the Finance Acts, the LRC revised Social
  Welfare Consolidation Act 2005 and NfG Part 18D. `incomeTaxIngestion.ts`
  ingests the SWCA sections and derives every curated rule. PAYE is out of scope.
- A figure that changes is a **version-chained** rule family outside VAT too:
  one `ruleKey`, each version dated from the year its Act says, each
  superseding the one before it, only the latest `active`. A later Act's
  figure is a new version, never an edit.

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

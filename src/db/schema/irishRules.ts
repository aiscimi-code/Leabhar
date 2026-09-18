import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance, ruleSource, effectiveDates } from './_shared';
import { companies } from './company';
import { taxRates, vatTreatments } from './config';

/**
 * Irish accounting/tax rules knowledge base (docs/RULES_KB.md).
 *
 * Four tables carry the statute-to-rule pipeline described there:
 *
 *   irishKnowledgeSources  -- the authoritative document (never modified, see
 *                             `sha256`), tagged with a `sourceType` so a later
 *                             Revenue interpretation can never be confused
 *                             with, or silently outrank, the underlying
 *                             legislation it explains.
 *   irishActProvisions     -- a verbatim, offset-addressable slice of a source,
 *                             with a `relevant` flag: parsing a provision does
 *                             not imply it bears on transaction classification.
 *   irishTaxRules          -- a rule derived from one provision. Conditions,
 *                             exceptions and effects are structured data, in
 *                             the same shape the existing `rules` engine
 *                             (src/domain/rules/engine.ts) already uses for
 *                             bank-transaction conditions, so a derived
 *                             statutory rule and a user-authored coding rule
 *                             are evaluated the same way.
 *   irishTaxRuleTests      -- generated test cases (positive/negative/
 *                             exception/boundary/effective-date) per rule.
 *
 * Every one of these is additive to the schema already in this repo (reusing
 * `provenance`, `ruleSource`, `effectiveDates` from `_shared.ts`, and pointing
 * at `taxRates`/`vatTreatments` rather than re-stating them) rather than a
 * parallel subsystem — see docs/RULES_KB.md "Architecture assessment".
 */

/** Source-type hierarchy (docs/RULES_KB.md "Source hierarchy"). */
export const IRISH_SOURCE_TYPES = [
  'legislation',
  'revenue_guidance',
  'revenue_ebrief',
  'cro_guidance',
  'eu_source',
  'accounting_standard',
  'leabhar_implementation_rule',
] as const;
export type IrishSourceType = (typeof IRISH_SOURCE_TYPES)[number];

/**
 * A source document ingested into the knowledge base.
 *
 * Content-addressed by `sha256`: re-ingesting identical bytes is a no-op, and
 * a changed document creates a new source row rather than mutating one, so a
 * rule extracted last year still points at the exact text it was extracted
 * from (AGENTS.md invariant #5, "documents are never modified", applied here).
 *
 * `sourceType` is what stops a later Revenue interpretation from overwriting
 * or outranking the underlying legislation: rules extracted from a
 * `revenue_guidance` source are never merged into, or allowed to supersede,
 * rules extracted from a `legislation` source. `authorityRank` in
 * `src/domain/rules/sourceHierarchy.ts` derives a precedence order from this
 * column; the column itself is the only thing ever stored.
 */
export const irishKnowledgeSources = sqliteTable('irish_knowledge_sources', {
  id: text('id').primaryKey(),
  /** Null for jurisdiction-wide sources (legislation, EU law); set for a
   *  practice's own Leabhar implementation rule sources. */
  companyId: text('company_id').references(() => companies.id),
  sourceType: text('source_type', { enum: IRISH_SOURCE_TYPES }).notNull(),
  /** e.g. "Finance Act 2024" / "VAT Tax and Duty Manual — Postal Services". */
  title: text('title').notNull(),
  /** e.g. "2024 Act 43" / "VATCA 2010" — a short, human-readable identifier. */
  citation: text('citation').notNull(),
  jurisdiction: text('jurisdiction').notNull().default('IE'),
  /** URL to the authoritative source (Irish Statute Book, revenue.ie, ...). */
  sourceUrl: text('source_url').notNull(),
  /** Path within the repo of the converted Markdown extract, when local. */
  localPath: text('local_path'),
  /** SHA-256 of the ingested bytes, so a re-ingest detects drift. */
  sha256: text('sha256').notNull(),
  /** Semver-ish ingest version so re-ingestion is auditable. */
  ingestVersion: text('ingest_version').notNull(),
  publicationDate: text('publication_date'),
  retrievedAt: text('retrieved_at').notNull(),
  ...effectiveDates,
  ...ruleSource,
}, (t) => [
  // A citation may have more than one source row over time (a later Act
  // amending an earlier one, or a corrected re-transcription) — content is
  // what must be unique, so two genuinely different documents can never
  // collide, and the same bytes can never be ingested twice under one citation.
  unique('irish_knowledge_sources_citation_sha256_unique').on(t.citation, t.sha256),
  index('irish_knowledge_sources_type_idx').on(t.sourceType),
]);

/** Broad category for a provision, for lookup and reporting. */
export const IRISH_PROVISION_CATEGORIES = [
  'income_tax', 'corporation_tax', 'vat', 'usc', 'capital_allowances',
  'capital_gains_tax', 'relief', 'exemption', 'penalty', 'procedure',
  'definitions', 'repeal', 'other',
] as const;
export type IrishProvisionCategory = (typeof IRISH_PROVISION_CATEGORIES)[number];

/**
 * A provision (section/subsection/clause) extracted from a source document.
 *
 * `provisionText` is a normalised extract of the provision's own words —
 * never an LLM's paraphrase — and `sourceStart`/`sourceEnd` are character
 * offsets into the source document, so the exact slice is always recoverable
 * and re-checkable rather than trusted. `humanExplanation` is an optional
 * plain-language gloss, always `ai_suggestion` provenance until a user
 * confirms it, kept in a separate column so an invention can never be
 * confused with what the source says.
 *
 * `relevant`/`relevanceReason` record an explicit relevance judgement: the
 * task's instruction not to assume every section bears on transaction
 * classification (procedural, repeal and pure-definition sections mostly do
 * not) is a first-class, auditable field rather than an implicit filter.
 */
export const irishActProvisions = sqliteTable('irish_act_provisions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  sourceId: text('source_id').notNull().references(() => irishKnowledgeSources.id),
  /** Section number, e.g. "3". */
  sectionNumber: text('section_number').notNull(),
  /** Part/Chapter the section sits under, when the source states one. */
  part: text('part'),
  chapter: text('chapter'),
  /** Stable slug from the section heading, e.g. "rate-of-charge-and-personal-tax-credits-s3". */
  slug: text('slug').notNull(),
  /** First heading line of the section, e.g. "Rate of charge and personal tax credits". */
  heading: text('heading').notNull(),
  /**
   * Parent Act being amended, e.g. "Taxes Consolidation Act 1997" or null for
   * provisions that operate on the Act itself. Extracted verbatim from the text.
   */
  principalAct: text('principal_act'),
  /**
   * The provision's text, normalised to plain text with line breaks collapsed.
   * This is the authoritative source content; `humanExplanation` may paraphrase
   * but NEVER the other way around.
   */
  provisionText: text('provision_text'),
  /** Character offset range within the source document; paired for a verifiable slice. */
  sourceStart: integer('source_start'),
  sourceEnd: integer('source_end'),
  humanExplanation: text('human_explanation'),
  category: text('category', { enum: IRISH_PROVISION_CATEGORIES }).notNull().default('other'),
  /** Section number(s) this provision amends, e.g. "472BB(3)" — parsed from text. */
  amendsSection: text('amends_section'),
  /** Effective date clue string as stated in the text, e.g. "year of assessment 2025". */
  effectiveClue: text('effective_clue'),
  /** Other Acts cited verbatim in the provision text. */
  citedActs: text('cited_acts', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * Whether this provision was judged to bear on accounting/tax transaction
   * classification, and why. Set deterministically by category (definitions,
   * procedure and repeal default to not relevant); never left implicit.
   */
  relevant: integer('relevant', { mode: 'boolean' }).notNull().default(true),
  relevanceReason: text('relevance_reason'),
  ...provenance,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  unique('irish_act_provisions_source_section_unique').on(t.sourceId, t.sectionNumber),
  index('irish_act_provisions_category_idx').on(t.category),
  index('irish_act_provisions_principal_idx').on(t.principalAct),
  index('irish_act_provisions_amends_idx').on(t.amendsSection),
  index('irish_act_provisions_relevant_idx').on(t.relevant),
]);

/** Mirrors `rules.conditions` in src/db/schema/operations.ts so both engines
 *  evaluate the same condition shape (src/domain/rules/engine.ts). */
export type IrishRuleCondition = {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with'
    | 'ends_with' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_null';
  value: string | number | Array<string | number> | null;
};

export type IrishRuleException = {
  /** Plain-language statement of when the exception applies, verbatim where possible. */
  condition: string;
  /** What the exception does to the rule's effect. */
  effect: string;
};

export const IRISH_RULE_TYPES = [
  'deductibility', 'rate', 'threshold', 'relief', 'exemption',
  'definition', 'procedure', 'reporting', 'other',
] as const;
export type IrishRuleType = (typeof IRISH_RULE_TYPES)[number];

export const IRISH_RULE_REVIEW_STATUSES = [
  'draft', 'ai_extracted', 'human_review', 'approved', 'active', 'superseded', 'rejected',
] as const;
export type IrishRuleReviewStatus = (typeof IRISH_RULE_REVIEW_STATUSES)[number];

/**
 * A concrete rule derived from one provision.
 *
 * A rule never invents a rate: `extractedFact` is the verbatim token the
 * extractor located in the provision text (e.g. "€27,382"), and `statement`
 * is built only from the provision's own wording. A rule may optionally bind
 * to an existing `taxRates`/`vatTreatments` row, which is the bridge to the
 * existing configuration and coding-rules engine — it never duplicates that
 * configuration.
 *
 * `reviewStatus` is the legal-rule governance lifecycle the task asks for
 * (DRAFT -> AI_EXTRACTED -> HUMAN_REVIEW -> APPROVED -> ACTIVE -> SUPERSEDED);
 * it is deliberately separate from the generic `provenanceStatus` in
 * `provenance` (who attested a *value*), because this is about where a *rule*
 * sits in review, not who set a field. An AI-extracted rule is never
 * `active`-equivalent for lookup purposes until a human approves it — see
 * `deterministicLookup` in `transactionLookup.ts`.
 *
 * Rules are versioned: legislative change never edits a historical rule in
 * place. The old rule's `effectiveTo` is set to the change date and a new
 * row is inserted with `effectiveFrom` at that date and `supersedesRuleId`
 * pointing back, so a transaction always resolves the rule that was in force
 * on its own date (AGENTS.md invariant #6, applied to statute-derived rules).
 */
export const irishTaxRules = sqliteTable('irish_tax_rules', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  provisionId: text('provision_id').notNull().references(() => irishActProvisions.id),
  /**
   * Link to existing configuration this rule binds to, when any. A rule may
   * carry a verbatim figure (e.g. a new threshold) without yet mapping to a
   * configured rate — that is `ai_suggestion` pending user confirmation.
   */
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  vatTreatmentId: text('vat_treatment_id').references(() => vatTreatments.id),

  /** Stable key for deterministic lookup, e.g. "usc.first_band_threshold". */
  ruleKey: text('rule_key').notNull(),
  ruleType: text('rule_type', { enum: IRISH_RULE_TYPES }).notNull().default('other'),
  /** Broad subject the rule speaks to, e.g. "business_expense", "usc". Defaults to the provision's category. */
  topic: text('topic').notNull(),
  /** Human-readable summary, at most a single sentence. */
  name: text('name').notNull(),
  /** The rule's statement, built only from the provision's own wording — never invented. */
  statement: text('statement'),
  /** The verbatim figure token extracted from the provision text, when the rule states one. */
  extractedFact: text('extracted_fact'),
  /** Plain-language gloss; ai_suggestion unless user_confirmed via provenanceStatus. */
  humanExplanation: text('human_explanation'),

  /** Numeric value where the provision states one, in minor units where money. */
  numericValue: integer('numeric_value'),
  unit: text('unit', { enum: ['eur_minor', 'usd_minor', 'basis_points', 'percent', 'count', 'text'] }),
  /** Free-text qualifier as stated in the source, e.g. "year of assessment 2025 and subsequent". */
  qualifier: text('qualifier'),

  /** All conditions must hold (AND) for the rule to be a candidate applicable rule. */
  conditions: text('conditions', { mode: 'json' }).$type<IrishRuleCondition[]>().notNull().default([]),
  exceptions: text('exceptions', { mode: 'json' }).$type<IrishRuleException[]>().notNull().default([]),
  /** Other sections/Acts this rule's provision cross-references (from ParsedProvision.amendsSection/citedActs). */
  crossReferences: text('cross_references', { mode: 'json' }).$type<string[]>().notNull().default([]),

  /** Resulting treatment, in the four dimensions the task asks for. Null where the rule does not speak to that dimension. */
  accountingEffect: text('accounting_effect'),
  taxEffect: text('tax_effect'),
  vatEffect: text('vat_effect'),
  reportingEffect: text('reporting_effect'),

  /** Set when the provision's wording needs guidance (Revenue manual, case law) this KB does not yet hold to be conclusive. */
  requiresGuidance: integer('requires_guidance', { mode: 'boolean' }).notNull().default(false),
  /** Set when a person must confirm the treatment before it is applied — the default, until reviewStatus reaches 'active'. */
  humanReviewRequired: integer('human_review_required', { mode: 'boolean' }).notNull().default(true),
  reviewStatus: text('review_status', { enum: IRISH_RULE_REVIEW_STATUSES }).notNull().default('draft'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: text('reviewed_at'),
  reviewNotes: text('review_notes'),

  /** Versioning: never edit a historical rule in place (see docstring above). */
  ruleVersion: integer('rule_version').notNull().default(1),
  supersedesRuleId: text('supersedes_rule_id'),

  /** Lookup ordering; lower evaluates first, matching the existing rules engine's convention. */
  priority: integer('priority').notNull().default(100),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...effectiveDates,
  ...provenance,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  unique('irish_tax_rules_key_version_unique').on(t.companyId, t.ruleKey, t.ruleVersion),
  index('irish_tax_rules_provision_idx').on(t.provisionId),
  index('irish_tax_rules_lookup_idx').on(t.companyId, t.ruleKey, t.effectiveFrom),
  index('irish_tax_rules_topic_idx').on(t.companyId, t.topic, t.active),
  index('irish_tax_rules_review_idx').on(t.reviewStatus),
]);

export const IRISH_TEST_CASE_TYPES = [
  'positive', 'negative', 'exception', 'boundary', 'effective_date',
] as const;
export type IrishTestCaseType = (typeof IRISH_TEST_CASE_TYPES)[number];

/**
 * A generated or hand-written test case for a rule (task Phase 6).
 *
 * `input` is a transaction context (see `transactionLookup.ts`); `expected`
 * records the applicable-rule outcome the lookup should produce for it.
 * `lastRunPassed`/`lastRunAt` are written by the CLI's `test` subcommand, so
 * `npm run cli:rules -- test` can report pass/fail without re-deriving
 * expectations each time.
 */
export const irishTaxRuleTests = sqliteTable('irish_tax_rule_tests', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull().references(() => irishTaxRules.id),
  testType: text('test_type', { enum: IRISH_TEST_CASE_TYPES }).notNull(),
  description: text('description').notNull(),
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expected: text('expected', { mode: 'json' }).$type<{
    matches: boolean;
    reviewRequired?: boolean;
    notes?: string;
  }>().notNull(),
  lastRunAt: text('last_run_at'),
  lastRunPassed: integer('last_run_passed', { mode: 'boolean' }),
  ...timestamps,
}, (t) => [
  index('irish_tax_rule_tests_rule_idx').on(t.ruleId),
]);

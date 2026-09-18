import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance, ruleSource } from './_shared';
import { companies } from './company';
import { taxRates, vatTreatments } from './config';

/**
 * Statute source documents ingested into the KB.
 *
 * A statute source is the *text* the rules were extracted from — the Finance
 * Act 2024 enacted Markdown in this case. It is stored once (content-addressed
 * by its SHA-256) and referenced by provisions so any derived rule is
 * traceable to the exact bytes it was extracted from. This is the "source
 * documents are never modified" invariant (AGENTS.md #5) applied to the
 * tax-rules knowledge base itself.
 */
export const irishStatuteSources = sqliteTable('irish_statute_sources', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  /** e.g. "Finance Act 2024" */
  title: text('title').notNull(),
  /** e.g. "2024 Act 43" — a short, human-readable identifier. */
  citation: text('citation').notNull(),
  /** URL to the authoritative source, the Irish Statute Book. */
  sourceUrl: text('source_url').notNull(),
  /** Path within the repo of the converted Markdown extract. */
  localPath: text('local_path'),
  /** SHA-256 of the ingest bytes, so a re-ingest detects drift. */
  sha256: text('sha256').notNull(),
  /** Semver-ish ingest version so re-ingestion is auditable. */
  ingestVersion: text('ingest_version').notNull(),
  ingestedAt: text('ingested_at').notNull(),
  ...ruleSource,
}, (t) => [
  unique('irish_statute_sources_citation_unique').on(t.citation),
]);

/**
 * A statutory provision extracted from a source document.
 *
 * "Provision" here covers a section, subsection, or a self-contained clause
 * that carries a rule. The parser records the textual location so a reader
 * can jump to it. `provisionText` is a normalised extract of the provision's
 * text (the *source* of the rule, never an LLM's paraphrase) and
 * `humanExplanation` is an optional plain-language gloss tagged `ai_suggestion`
 * — explicitly distinct from `provisionText` so invented text can never be
 * confused with what the statute says.
 */
export const irishActProvisions = sqliteTable('irish_act_provisions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  statuteSourceId: text('statute_source_id').notNull()
    .references(() => irishStatuteSources.id),
  /** Finance Act 2024 section number, e.g. "3". */
  sectionNumber: text('section_number').notNull(),
  /** Stable slug from the section heading, e.g. "rate-of-charge-and-personal-tax-credits". */
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
  /**
   * Character offset (start) within the statute source Markdown, so the exact
   * source slice is recoverable. Paired with length for a verifiable range.
   */
  sourceStart: integer('source_start'),
  sourceEnd: integer('source_end'),
  /**
   * Optional plain-language gloss. Source is always `ai_suggestion` and is
   * review-flagged until a user confirms it — see provenanceStatus.
   */
  humanExplanation: text('human_explanation'),
  /** Broad category for the provision, for lookup and reporting. */
  category: text('category', {
    enum: [
      'income_tax', 'corporation_tax', 'vat', 'usc', 'capital_allowances',
      'capital_gains_tax', 'relief', 'exemption', 'penalty', 'procedure',
      'definitions', 'repeal', 'other',
    ],
  }).notNull().default('other'),
  /** Section number this provision amends, e.g. "947A" — parsed from text. */
  amendsSection: text('amends_section'),
  /** Effective date string, e.g. "2025-01/01" or "year of assessment 2025". */
  effectiveClue: text('effective_clue'),
  /** JSON array of other Acts cited verbatim in the provision text. */
  citedActs: text('cited_acts'),
  ...provenance,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  unique('irish_act_provisions_source_section_unique')
    .on(t.statuteSourceId, t.sectionNumber),
  index('irish_act_provisions_category_idx').on(t.category),
  index('irish_act_provisions_principal_idx').on(t.principalAct),
  index('irish_act_provisions_amends_idx').on(t.amendsSection),
]);

/**
 * A concrete rule derived from one or more provisions, mapped onto Leabhar's
 * existing configuration items (tax rates / VAT treatments).
 *
 * This is the bridge between the statute and the existing rules engine: each
 * `rule` row already carries `conditions`/`actions`; a derived rule simply
 * records which provision(s) it was extracted from. A derived rule never
 * invents a rate — it points at an existing `taxRates`/`vatTreatments` row or
 * carries a verbatim numeric value from the provision text.
 */
export const irishTaxRules = sqliteTable('irish_tax_rules', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  provisionId: text('provision_id').notNull().references(() => irishActProvisions.id),
  /**
   * Link to the existing configuration this rule binds to, when any. A rule may
   * carry a verbatim figure (e.g. a new threshold) without yet mapping to a
   * configured rate — that is an `ai_suggestion` pending user confirmation.
   */
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  vatTreatmentId: text('vat_treatment_id').references(() => vatTreatments.id),

  /** Stable key for deterministic lookup, e.g. "usc.first_12012_eur_rate". */
  ruleKey: text('rule_key').notNull(),
  /** Human-readable summary, at most a single sentence. */
  name: text('name').notNull(),
  /** The verbatim fact extracted from the provision text — never an LLM claim. */
  extractedFact: text('extracted_fact'),
  /** Plain-language gloss; ai_suggestion unless user_confirmed. */
  humanExplanation: text('human_explanation'),

  /** Numeric value where the provision states one, in minor units where money. */
  numericValue: integer('numeric_value'),
  /** Currency of numericValue when it is money, else null (e.g. a % in bps). */
  unit: text('unit', { enum: ['eur_minor', 'usd_minor', 'basis_points', 'percent', 'count', 'text'] }),
  /** Free-text qualifier, e.g. "year of assessment 2025 and subsequent". */
  qualifier: text('qualifier'),

  /** Lower version of the rule's priority for lookup ordering. */
  priority: integer('priority').notNull().default(100),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...provenance,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  unique('irish_tax_rules_key_unique').on(t.companyId, t.ruleKey),
  index('irish_tax_rules_provision_idx').on(t.provisionId),
  index('irish_tax_rules_lookup_idx').on(t.companyId, t.ruleKey),
]);

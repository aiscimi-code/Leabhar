/**
 * Irish tax-rules knowledge base: ingest, extraction and deterministic lookup.
 *
 * This module bridges the deterministic statute parser to the `irish_*`
 * schema tables (docs/RULES_KB.md). It never invents a rule: every stored
 * fact is either a verbatim provision slice or a value read mechanically from
 * the provision's own text, and a plain-language `humanExplanation` is always
 * `ai_suggestion` provenance so it cannot be mistaken for the source's own
 * words — per AGENTS.md invariant #8 ("provenance is mandatory") and the
 * task's "extraction must not silently invent statutory rules".
 */
import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules,
  type IrishSourceType, type IrishProvisionCategory,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, today, isIsoDate } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseFinanceAct2024, provisionSlug, categoriseProvision, assessRelevance,
  FINANCE_ACT_2024_MD_PATH,
} from './statuteParser';
import { extractFactsFromProvision, SECTION_RULE_KEYS } from './factExtractor';
import { resolveEffectiveDate } from './effectiveClue';
import { upsertReviewItem } from '../extraction/service';
import type { ParsedProvision } from './statuteParser';

export interface KnowledgeSourceRef {
  title: string;
  citation: string;
  sourceType: IrishSourceType;
  sourceUrl: string;
  localPath?: string;
  /** ISO date of enactment/publication, read verbatim from the source's own text. */
  enactedDate: string;
}

/**
 * The Finance Act 2024 (2024 Act 43) metadata. `enactedDate` is taken from the
 * Act's own long title ("... [12th November, 2024]" in
 * docs/statutes/finance-act-2024/2024-act-43-enacted.md), not inferred.
 */
export const FINANCE_ACT_2024: KnowledgeSourceRef = {
  title: 'Finance Act 2024',
  citation: '2024 Act 43',
  sourceType: 'legislation',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/pdf',
  localPath: 'docs/statutes/finance-act-2024/2024-act-43-enacted.md',
  enactedDate: '2024-11-12',
};

export { FINANCE_ACT_2024_MD_PATH };

export interface IngestResult {
  sourceId: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Ingest a source document's Markdown into the KB.
 *
 * Idempotent by content: re-ingesting identical bytes (same SHA-256) under
 * the same citation is a no-op. A changed document (a corrected transcript,
 * or a genuinely new Act sharing no citation) creates a new source row —
 * source documents are never modified in place (AGENTS.md invariant #5).
 *
 * Only the Finance Act 2024 parser is wired up today; `ingestVersion` records
 * which parser produced the provisions, so a future re-parse with an improved
 * parser is distinguishable from the original.
 */
export function ingestEnactedAct(
  db: AppDatabase,
  act: KnowledgeSourceRef,
  /** Why a section is relevant despite its category: a curated rule cites it. */
  curatedReason: (sectionNumber: string) => string | undefined,
  params: {
    companyId?: string | null;
    markdown: string;
    ingestVersion: string;
    localPath?: string;
  },
): IngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db
    .select({ id: irishKnowledgeSources.id })
    .from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, act.citation),
      eq(irishKnowledgeSources.sha256, digest),
    ))
    .get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant })
      .from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id))
      .all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id,
        provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length,
        ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: act.sourceType,
      title: act.title,
      citation: act.citation,
      jurisdiction: 'IE',
      sourceUrl: act.sourceUrl,
      localPath: params.localPath ?? act.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: act.enactedDate,
      retrievedAt: nowIso(),
      effectiveFrom: act.enactedDate,
      sourceNote: `Ingest ${params.ingestVersion} of ${act.citation} enacted Markdown.`,
      sourceDate: nowIso(),
    }).run();

    const parsed = parseFinanceAct2024(params.markdown);
    let relevantCount = 0;
    for (const p of parsed) {
      const category = categoriseProvision(p.heading, p.provisionText);
      let { relevant, reason } = assessRelevance(category);
      // A curated rule key (factExtractor.ts) is itself an explicit human
      // editorial judgement that the section is relevant, made when the key
      // was added — it overrides the mechanical keyword fallback rather than
      // letting an imperfect category guess silently drop a curated rule.
      const curated = curatedReason(p.sectionNumber);
      if (!relevant && curated) {
        relevant = true;
        reason = `${curated}, overriding the ${category} category default.`;
      }
      if (relevant) relevantCount++;

      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: p.sectionNumber,
        slug: provisionSlug(p.sectionNumber, p.heading),
        heading: p.heading,
        principalAct: p.principalActs.length ? p.principalActs.join('; ') : null,
        provisionText: p.provisionText,
        sourceStart: p.sourceStart,
        sourceEnd: p.sourceEnd,
        category,
        amendsSection: p.amendsSection.length ? p.amendsSection.join('; ') : null,
        effectiveClue: p.effectiveClue,
        citedActs: p.citedActs,
        relevant,
        relevanceReason: reason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }

    return { sourceId, provisionCount: parsed.length, relevantCount, ingested: true };
  });
}

export function ingestFinanceAct2024(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): IngestResult {
  return ingestEnactedAct(db, FINANCE_ACT_2024, (n) => (SECTION_RULE_KEYS[n]
    ? `Curated: mapped to rule key "${SECTION_RULE_KEYS[n]!.key}" by human editorial judgement`
    : undefined), params);
}

/**
 * Finance Act 2025 (2025 Act 18). `enactedDate` is the Act's own long title
 * ("[23rd December, 2025]" in docs/statutes/finance-act-2025/2025-act-18-enacted.md).
 * Its VAT rate sections (69-71) are cited by the s.46 rate rules (issue #205).
 */
export const FINANCE_ACT_2025: KnowledgeSourceRef = {
  title: 'Finance Act 2025',
  citation: '2025 Act 18',
  sourceType: 'legislation',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2025/act/18/enacted/en/pdf',
  localPath: 'docs/statutes/finance-act-2025/2025-act-18-enacted.md',
  enactedDate: '2025-12-23',
};

/** Sections of Finance Act 2025 a curated rule cites; kept relevant whatever their category. */
export const FINANCE_ACT_2025_CURATED_SECTIONS = new Set(['69', '70', '71']);

export function ingestFinanceAct2025(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): IngestResult {
  return ingestEnactedAct(db, FINANCE_ACT_2025, (n) => (FINANCE_ACT_2025_CURATED_SECTIONS.has(n)
    ? 'Curated: an s.46 rate rule cites this section (issue #205)'
    : undefined), params);
}

export interface DeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
}

/**
 * Derive `irish_tax_rules` rows from already-ingested provisions.
 *
 * For each provision with a curated rule key (`SECTION_RULE_KEYS`), the
 * mechanical fact extractor reads the verbatim text for the stated figure.
 * Only curated sections become named, lookup-advertised rules: an unmapped
 * section's figures are still recoverable via the provision's own text (audit
 * trail), but this function does not invent a stable key for them.
 *
 * Versioning: if a rule with the same key is already `active` and its
 * extracted figure has changed (the source was re-ingested with a genuine
 * amendment), the old row's `effectiveTo`/`active` are closed off and a new
 * row is inserted with an incremented `ruleVersion` pointing back via
 * `supersedesRuleId` — the historical row is never edited in place
 * (AGENTS.md invariant #6).
 */
export function deriveTaxRules(
  db: AppDatabase,
  params: { companyId: string; sourceId?: string },
): DeriveResult {
  // Scoped to this source's own provisions, never every provision in the
  // company's DB: once a second source (e.g. VATCA 2010) is ingested into
  // the same company, an un-scoped scan would match a section number against
  // whichever source's row happens to come first — silently deriving a rule
  // from the wrong Act's text. A caller may still pass a specific
  // `sourceId` (e.g. to re-derive against one re-ingested version).
  const sourceId = params.sourceId ?? db
    .select({ id: irishKnowledgeSources.id })
    .from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, FINANCE_ACT_2024.citation))
    .get()?.id;

  const provisionsQuery = db
    .select({
      id: irishActProvisions.id,
      sectionNumber: irishActProvisions.sectionNumber,
      heading: irishActProvisions.heading,
      provisionText: irishActProvisions.provisionText,
      effectiveClue: irishActProvisions.effectiveClue,
      category: irishActProvisions.category,
      amendsSection: irishActProvisions.amendsSection,
      citedActs: irishActProvisions.citedActs,
      relevant: irishActProvisions.relevant,
    })
    .from(irishActProvisions);

  const provisions = (sourceId
    ? provisionsQuery.where(eq(irishActProvisions.sourceId, sourceId))
    : provisionsQuery
  ).all();

  let created = 0;
  let superseded = 0;
  let unchanged = 0;

  for (const prov of provisions) {
    const curated = SECTION_RULE_KEYS[prov.sectionNumber];
    if (!curated) continue;
    // A curated section is still only advertised as a lookup rule when the
    // provision itself was judged relevant; a curated key on an irrelevant
    // provision would be a bug in the curation table, not a reason to hide it.
    if (!prov.relevant) continue;

    const parsed: ParsedProvision = {
      sectionNumber: prov.sectionNumber,
      heading: prov.heading ?? '',
      provisionText: prov.provisionText ?? '',
      sourceStart: 0,
      sourceEnd: 0,
      principalActs: [],
      amendsSection: [],
      effectiveClue: prov.effectiveClue,
      citedActs: [],
      category: prov.category,
    };
    const facts = extractFactsFromProvision(parsed);
    const fact = facts.find((f) => f.unit === curated.unit) ?? facts[0];
    if (!fact) continue;

    const effectiveFrom = resolveEffectiveDate(prov.effectiveClue, FINANCE_ACT_2024.enactedDate);
    const crossReferences = [
      ...(prov.amendsSection ? prov.amendsSection.split('; ') : []),
      ...(prov.citedActs ?? []),
    ];

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, curated.key),
        eq(irishTaxRules.active, true),
      ))
      .get();

    if (existing) {
      if (existing.extractedFact === fact.rawValue && existing.numericValue === fact.numericValue) {
        unchanged++;
        continue;
      }
      // The figure changed: close the old version rather than edit it, and
      // insert a new version superseding it.
      db.update(irishTaxRules)
        .set({ effectiveTo: effectiveFrom, active: false })
        .where(eq(irishTaxRules.id, existing.id))
        .run();
      superseded++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: curated.key,
      ruleType: curated.kind === 'threshold' ? 'threshold' : curated.kind === 'rate' ? 'rate' : 'other',
      topic: curated.topic,
      name: curated.name,
      statement: `Finance Act 2024 s.${prov.sectionNumber}: ${fact.evidence}`,
      extractedFact: fact.rawValue,
      humanExplanation: `Section ${prov.sectionNumber} (${prov.heading || 'untitled'}) states: ${fact.evidence}`,
      numericValue: fact.numericValue,
      unit: fact.unit,
      qualifier: fact.qualifier,
      conditions: [],
      exceptions: [],
      crossReferences,
      taxEffect: `${curated.name}: ${fact.rawValue}${fact.qualifier ? ` (${fact.qualifier})` : ''}.`,
      requiresGuidance: false,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: curated.kind === 'rate' ? 50 : 100,
      effectiveFrom,
      source: 'derived',
      confidence: 90,
      provenanceStatus: 'system_rule',
      sourceNote: `Mechanically extracted from Finance Act 2024 s.${prov.sectionNumber}; not yet human-reviewed.`,
      sourceDate: nowIso(),
    }).run();
    created++;

    // Surface the new rule in Leabhar's existing review inbox (src/app/review)
    // rather than only through the rules-KB CLI — one review queue, not two.
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish tax rule extracted: ${curated.name}`,
      detail: `Finance Act 2024 s.${prov.sectionNumber} states: ${fact.evidence} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: curated.key, sectionNumber: prov.sectionNumber, extractedFact: fact.rawValue },
    });
  }

  return { created, superseded, unchanged };
}

export interface LookupResult {
  id: string;
  provisionId: string;
  sectionNumber: string;
  heading: string;
  ruleKey: string;
  ruleType: string;
  topic: string;
  name: string;
  statement: string | null;
  extractedFact: string | null;
  value: number | null;
  unit: string | null;
  qualifier: string | null;
  taxEffect: string | null;
  accountingEffect: string | null;
  vatEffect: string | null;
  reportingEffect: string | null;
  reviewStatus: string;
  humanReviewRequired: boolean;
  requiresGuidance: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceNote: string | null;
  sourceDate: string | null;
  provisionText: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  sourceUrl: string;
  citation: string;
}

const LOOKUP_COLUMNS = {
  id: irishTaxRules.id,
  provisionId: irishTaxRules.provisionId,
  ruleKey: irishTaxRules.ruleKey,
  ruleType: irishTaxRules.ruleType,
  topic: irishTaxRules.topic,
  name: irishTaxRules.name,
  statement: irishTaxRules.statement,
  extractedFact: irishTaxRules.extractedFact,
  value: irishTaxRules.numericValue,
  unit: irishTaxRules.unit,
  qualifier: irishTaxRules.qualifier,
  taxEffect: irishTaxRules.taxEffect,
  accountingEffect: irishTaxRules.accountingEffect,
  vatEffect: irishTaxRules.vatEffect,
  reportingEffect: irishTaxRules.reportingEffect,
  reviewStatus: irishTaxRules.reviewStatus,
  humanReviewRequired: irishTaxRules.humanReviewRequired,
  requiresGuidance: irishTaxRules.requiresGuidance,
  effectiveFrom: irishTaxRules.effectiveFrom,
  effectiveTo: irishTaxRules.effectiveTo,
  sourceNote: irishTaxRules.sourceNote,
  sourceDate: irishTaxRules.sourceDate,
  sectionNumber: irishActProvisions.sectionNumber,
  heading: irishActProvisions.heading,
  provisionText: irishActProvisions.provisionText,
  sourceStart: irishActProvisions.sourceStart,
  sourceEnd: irishActProvisions.sourceEnd,
  sourceUrl: irishKnowledgeSources.sourceUrl,
  citation: irishKnowledgeSources.citation,
} as const;

function toLookupResult(row: Record<string, unknown>): LookupResult {
  return row as unknown as LookupResult;
}

/**
 * Deterministic lookup of the tax rule in force for a stable key on a given
 * date (defaults to today). Rules are looked up by key, never by an LLM query
 * over prose, and the result always carries the verbatim `provisionText` and
 * its source offset so the reader can verify it against the statute.
 */
export function lookupTaxRule(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; asOfDate?: string },
): LookupResult | null {
  const asOf = params.asOfDate ?? today();
  if (!isIsoDate(asOf)) return null; // an invalid as-of date must fail closed, never open every in-force version
  const rows = db
    .select(LOOKUP_COLUMNS)
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      eq(irishTaxRules.ruleKey, params.ruleKey),
      eq(irishTaxRules.enabled, true),
    ))
    .orderBy(desc(irishTaxRules.ruleVersion))
    .all();

  const inForce = rows.find((r) => r.effectiveFrom <= asOf && (!r.effectiveTo || r.effectiveTo > asOf));
  return inForce ? toLookupResult(inForce) : null;
}

/**
 * List rules for a topic, in force on the given date. Pure data lookup — no
 * LLM inference, no ranking beyond priority and rule authority.
 */
export function listTaxRulesByTopic(
  db: AppDatabase,
  params: { companyId: string; topic: string; asOfDate?: string },
): LookupResult[] {
  const asOf = params.asOfDate ?? today();
  if (!isIsoDate(asOf)) return []; // an invalid as-of date must fail closed, never open every in-force rule
  const rows = db
    .select(LOOKUP_COLUMNS)
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      eq(irishTaxRules.enabled, true),
      eq(irishTaxRules.topic, params.topic),
    ))
    .orderBy(desc(irishTaxRules.priority))
    .all()
    .filter((r) => r.effectiveFrom <= asOf && (!r.effectiveTo || r.effectiveTo > asOf));
  return rows.map(toLookupResult);
}

/** List rules by provision category, in force on the given date. */
export function listTaxRulesByCategory(
  db: AppDatabase,
  params: { companyId: string; category: IrishProvisionCategory; asOfDate?: string },
): LookupResult[] {
  const asOf = params.asOfDate ?? today();
  if (!isIsoDate(asOf)) return []; // an invalid as-of date must fail closed, never open every in-force rule
  const rows = db
    .select(LOOKUP_COLUMNS)
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      eq(irishTaxRules.enabled, true),
      eq(irishActProvisions.category, params.category),
    ))
    .orderBy(desc(irishTaxRules.priority))
    .all()
    .filter((r) => r.effectiveFrom <= asOf && (!r.effectiveTo || r.effectiveTo > asOf));
  return rows.map(toLookupResult);
}

/**
 * Distinct source citations (e.g. "2024 Act 43", "VATCA 2010") currently
 * ingested and enabled for a company, so a caller describing what the KB
 * does and does not cover reads the actual state rather than a copy that
 * goes stale the moment a new source is ingested.
 */
export function listIngestedCitations(db: AppDatabase, companyId: string): string[] {
  const rows = db
    .select({ citation: irishKnowledgeSources.citation })
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.enabled, true)))
    .all();
  return [...new Set(rows.map((r) => r.citation))];
}

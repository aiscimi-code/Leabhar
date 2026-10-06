/**
 * Ingestion and rule derivation for Revenue TDM Part 38-01-03b's capacity
 * exclusion guidance, built on `tdm3801_03bParser.ts`. The knowledge base
 * loads the passage from its rules catalogue entry
 * (`ingestTdm3801_03bFromCatalogue`, #556).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { extractCapacityExclusionSection } from './tdm3801_03bParser';
import { TDM_38_01_03B_CAPACITY_EXCLUSION_RULE } from './tdm3801_03bCuration';
import { upsertReviewItem } from '../extraction/service';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';

export const TDM_38_01_03B = {
  citation: 'Revenue TDM Part 38-01-03b',
  title: 'TDM Part 38-01-03b — Guidelines for VAT Registration (capacity exclusion from mandatory e-filing)',
  sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-01-03b.pdf',
  // The TDM's own front matter states "Document last updated May 2026"; no
  // more precise effective date is stated for this specific guidance passage.
  // The exclusion itself is S.I. 156/2012 reg.5's, in force from 2012 (#709).
  effectiveFrom: '2026-05-01',
  sectionNumber: 'capacity-exclusion',
  note: 'Only the "Exclusion from Mandatory Electronic Filing and Payment of Tax" passage is ingested '
    + 'from this 40+ page manual — it repeats byte-identically four times (once per registrant-type '
    + 'scenario), verified by tdm3801_03bParser.ts. This is Revenue guidance, not legislation: it ranks '
    + 'below S.I. 156/2012 itself in the source hierarchy, and closes a gap that Regulation left open here '
    + '(its own exclusion criteria are not restated in this KB — see si156Curation.ts).',
  // Curated by construction: the parser extracts nothing else.
  relevanceReason: 'Curated: mapped to vat.mandatory_electronic_filing_capacity_exclusion in '
    + 'tdm3801_03bCuration.ts.',
};

export const TDM_38_01_03B_CATALOGUE_ENTRY = 'tdm-38-01-03b/38-01-03b.json';

/** Load the passage from its catalogue entry. */
export function ingestTdm3801_03bFromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CatalogueIngestResult {
  return ingestCatalogueFile(db, { ...params, entry: TDM_38_01_03B_CATALOGUE_ENTRY });
}

export interface TdmCapacityExclusionIngestResult {
  sourceId: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest a Markdown copy of the manual (the CLI's `--file`): only the capacity exclusion passage. */
export function ingestTdm3801_03bCapacityExclusion(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): TdmCapacityExclusionIngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, TDM_38_01_03B.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'revenue_guidance',
      title: TDM_38_01_03B.title,
      citation: TDM_38_01_03B.citation,
      jurisdiction: 'IE',
      sourceUrl: TDM_38_01_03B.sourceUrl,
      localPath: params.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: TDM_38_01_03B.effectiveFrom,
      sourceNote: TDM_38_01_03B.note,
      sourceDate: nowIso(),
    }).run();

    const section = extractCapacityExclusionSection(params.markdown);

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: TDM_38_01_03B.sectionNumber,
      slug: 'exclusion-from-mandatory-electronic-filing-and-payment-of-tax',
      heading: section.heading,
      principalAct: null,
      provisionText: section.provisionText,
      sourceStart: section.sourceStart,
      sourceEnd: section.sourceEnd,
      category: 'procedure',
      amendsSection: null,
      effectiveClue: null,
      citedActs: [],
      relevant: true,
      relevanceReason: TDM_38_01_03B.relevanceReason,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, provisionCount: 1, relevantCount: 1, ingested: true };
  });
}

export interface TdmCapacityExclusionDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveTdm3801_03bCapacityExclusionRule(
  db: AppDatabase,
  params: { companyId: string },
): TdmCapacityExclusionDeriveResult {
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, TDM_38_01_03B.citation)).get()?.id;
  const prov = sourceId
    ? db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, TDM_38_01_03B.sectionNumber)))
      .get()
    : undefined;

  const rule = TDM_38_01_03B_CAPACITY_EXCLUSION_RULE;

  if (!prov || !prov.relevant) {
    return { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [rule.ruleKey] };
  }

  const existing = db.select().from(irishTaxRules)
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      eq(irishTaxRules.ruleKey, rule.ruleKey),
      eq(irishTaxRules.active, true),
    )).get();

  if (existing && existing.statement === rule.statementExcerpt) {
    return { created: 0, superseded: 0, unchanged: 1, skippedNoProvision: [] };
  }

  let superseded = 0;
  if (existing) {
    db.update(irishTaxRules)
      .set({ effectiveTo: TDM_38_01_03B.effectiveFrom, active: false })
      .where(eq(irishTaxRules.id, existing.id)).run();
    superseded = 1;
  }

  const newRuleId = ids.taxRule();
  db.insert(irishTaxRules).values({
    id: newRuleId,
    companyId: params.companyId,
    provisionId: prov.id,
    ruleKey: rule.ruleKey,
    ruleType: rule.ruleType,
    topic: rule.topic,
    taxHeads: taxHeadsFor(rule.ruleKey, rule.topic),
    name: rule.name,
    statement: rule.statementExcerpt,
    extractedFact: null,
    humanExplanation: rule.interpretationNote,
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: rule.conditions,
    exceptions: rule.exceptions,
    crossReferences: ['S.I. 156/2012 reg.5'],
    accountingEffect: null,
    taxEffect: null,
    vatEffect: rule.vatEffect,
    reportingEffect: rule.reportingEffect,
    requiresGuidance: false,
    humanReviewRequired: true,
    reviewStatus: 'ai_extracted',
    ruleVersion: existing ? existing.ruleVersion + 1 : 1,
    supersedesRuleId: existing?.id ?? null,
    priority: 90,
    effectiveFrom: TDM_38_01_03B.effectiveFrom,
    source: 'derived',
    confidence: 75,
    provenanceStatus: 'ai_suggestion',
    sourceNote: `Curated from ${TDM_38_01_03B.citation}; not yet human-reviewed. ${rule.interpretationNote}`,
    sourceDate: nowIso(),
  }).run();

  upsertReviewItem(db, {
    companyId: params.companyId,
    kind: 'unresolved_ai_suggestion',
    severity: 'info',
    title: `New Irish VAT rule extracted: ${rule.name}`,
    detail: `${TDM_38_01_03B.citation}. ${rule.interpretationNote} `
      + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
    entityType: 'irish_tax_rule',
    entityId: newRuleId,
    dedupeKey: `irish_tax_rule:${newRuleId}`,
    context: { ruleKey: rule.ruleKey },
  });

  return { created: 1, superseded, unchanged: 0, skippedNoProvision: [] };
}

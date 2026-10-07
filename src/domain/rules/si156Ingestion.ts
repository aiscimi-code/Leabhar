/**
 * Ingestion and rule derivation for S.I. 156/2012 (Tax Returns and Payments
 * (Mandatory Electronic Filing and Payment of Tax) Regulations 2012), built
 * on `si156Parser.ts`. The knowledge base loads the instrument from its rules
 * catalogue entry (`ingestSi156FromCatalogue`, #556).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseSi156, provisionSlug, assessRelevance, type ParsedSi156Regulation } from './si156Parser';
import { SI_156_CAPACITY_EXCLUSION, SI_156_CURATED_RULES } from './si156Curation';
import { upsertReviewItem } from '../extraction/service';
import { crossReferencesFromProvision, sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';
import { preferredSourceId } from './catalogueSupersession';

export const SI_156 = {
  citation: 'S.I. 156/2012',
  title: 'Tax Returns and Payments (Mandatory Electronic Filing and Payment of Tax) Regulations 2012',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html',
  // Regulation 1(2) states its own commencement verbatim: "These Regulations
  // come into operation on 1 June 2012."
  effectiveFrom: '2012-06-01',
  /** Regulations 1 to 9. Schedules are held beside them (#705). */
  regulations: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  note: 'Regulations 1 to 9 and both Schedules are held, from the official page. Regulation 5 is the '
    + 'capacity exclusion, in force from 1 June 2012 (reg.1(2)). The TDM 38-01-03b passage explains it '
    + 'and does not originate it (#709, #705).',
};

/** Whether a regulation bears on the rules: its category's default, or curated into a rule. */
export function si156Relevance(reg: ParsedSi156Regulation): { relevant: boolean; reason: string } {
  const { relevant, reason } = assessRelevance(reg.category);
  const curated = [...SI_156_CURATED_RULES, SI_156_CAPACITY_EXCLUSION];
  if (relevant || !curated.some((r) => r.regulationNumber === reg.regulationNumber)) return { relevant, reason };
  return {
    relevant: true,
    reason: 'Curated: mapped to a rule in si156Curation.ts, overriding the '
      + `${reg.category} category default.`,
  };
}

export const SI_156_CATALOGUE_ENTRY = 'si-156-2012/2012-si-156.json';

/** Load the instrument from its catalogue entry. */
export function ingestSi156FromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CatalogueIngestResult {
  return ingestCatalogueFile(db, { ...params, entry: SI_156_CATALOGUE_ENTRY });
}

export interface Si156IngestResult {
  sourceId: string;
  regulationCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Ingest a Markdown copy of S.I. 156/2012 (the CLI's `--file`). Every
 * regulation under its own `## ` heading becomes a provision; see
 * `si156Parser.ts`'s header.
 */
export function ingestSi156(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si156IngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, SI_156.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id, regulationCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'legislation',
      title: SI_156.title,
      citation: SI_156.citation,
      jurisdiction: 'IE',
      sourceUrl: SI_156.sourceUrl,
      localPath: params.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: SI_156.effectiveFrom,
      sourceNote: SI_156.note,
      sourceDate: nowIso(),
    }).run();

    const parsed = parseSi156(params.markdown);
    let relevantCount = 0;
    for (const reg of parsed) {
      const { relevant, reason } = si156Relevance(reg);
      if (relevant) relevantCount++;

      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: reg.regulationNumber,
        slug: provisionSlug(reg.regulationNumber, reg.heading),
        heading: reg.heading,
        principalAct: null,
        provisionText: reg.provisionText,
        sourceStart: reg.sourceStart,
        sourceEnd: reg.sourceEnd,
        category: reg.category,
        amendsSection: null,
        effectiveClue: null,
        citedActs: [],
        relevant,
        relevanceReason: reason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }

    return { sourceId, regulationCount: parsed.length, relevantCount, ingested: true };
  });
}

export interface Si156DeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveSi156Rules(
  db: AppDatabase,
  params: { companyId: string },
): Si156DeriveResult {
  const sourceId = preferredSourceId(db, SI_156.citation);
  const provisions = sourceId
    ? db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).all()
    : [];

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of SI_156_CURATED_RULES) {
    const prov = provisions.find((p) => p.sectionNumber === rule.regulationNumber);
    if (!prov) { skippedNoProvision.push(rule.ruleKey); continue; }
    if (!prov.relevant) { skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.statement === rule.statementExcerpt
        && sameCrossReferences(existing.crossReferences, crossReferencesFromProvision(prov))) { unchanged++; continue; }
      db.update(irishTaxRules)
        .set({ effectiveTo: SI_156.effectiveFrom, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      superseded++;
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
      crossReferences: crossReferencesFromProvision(prov),
      accountingEffect: null,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: SI_156.effectiveFrom,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${SI_156.citation} reg.${rule.regulationNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${rule.name}`,
      detail: `${SI_156.citation} reg.${rule.regulationNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, regulationNumber: rule.regulationNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

/**
 * Regulation 5 as version 2 of the capacity-exclusion rule (#709).
 *
 * Version 1 is the released TDM version and is not closed: its dates are part
 * of the released-version hash. This row starts on 1 June 2012 (reg.1(2)), so
 * a lookup from that date finds the exclusion. It does not rewrite version 1.
 */
export function deriveSi156CapacityExclusionRule(
  db: AppDatabase,
  params: { companyId: string },
): { created: number; unchanged: number; skippedNoProvision: string[] } {
  const rule = SI_156_CAPACITY_EXCLUSION;
  const sourceId = preferredSourceId(db, SI_156.citation);
  const prov = sourceId
    ? db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).all()
        .find((p) => p.sectionNumber === rule.regulationNumber)
    : undefined;
  if (!prov || !prov.relevant) return { created: 0, unchanged: 0, skippedNoProvision: [rule.ruleKey] };

  const rows = db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, rule.ruleKey))).all();
  if (rows.some((r) => r.statement === rule.statementExcerpt && r.effectiveFrom === SI_156.effectiveFrom)) {
    return { created: 0, unchanged: 1, skippedNoProvision: [] };
  }

  const prior = rows.filter((r) => r.active).sort((a, b) => b.ruleVersion - a.ruleVersion)[0];
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
    crossReferences: crossReferencesFromProvision(prov),
    accountingEffect: null,
    taxEffect: null,
    vatEffect: rule.vatEffect,
    reportingEffect: rule.reportingEffect,
    requiresGuidance: true,
    humanReviewRequired: true,
    reviewStatus: 'ai_extracted',
    ruleVersion: prior ? prior.ruleVersion + 1 : 1,
    supersedesRuleId: prior?.id ?? null,
    priority: 100,
    effectiveFrom: SI_156.effectiveFrom,
    source: 'derived',
    confidence: 70,
    provenanceStatus: 'ai_suggestion',
    sourceNote: `Curated from ${SI_156.citation} reg.${rule.regulationNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
    sourceDate: nowIso(),
  }).run();

  upsertReviewItem(db, {
    companyId: params.companyId,
    kind: 'unresolved_ai_suggestion',
    severity: 'info',
    title: `New Irish VAT rule extracted: ${rule.name}`,
    detail: `${SI_156.citation} reg.${rule.regulationNumber}, in force from ${SI_156.effectiveFrom} (reg.1(2)). ${rule.interpretationNote} `
      + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
    entityType: 'irish_tax_rule',
    entityId: newRuleId,
    dedupeKey: `irish_tax_rule:${newRuleId}`,
    context: { ruleKey: rule.ruleKey, regulationNumber: rule.regulationNumber },
  });
  return { created: 1, unchanged: 0, skippedNoProvision: [] };
}

/**
 * Ingestion and rule derivation for S.I. 156/2012 (Tax Returns and Payments
 * (Mandatory Electronic Filing and Payment of Tax) Regulations 2012), built
 * on `si156Parser.ts`.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseSi156, provisionSlug, assessRelevance, SI_156_2012_MD_PATH } from './si156Parser';
import { SI_156_CURATED_RULES } from './si156Curation';
import { upsertReviewItem } from '../extraction/service';

export { SI_156_2012_MD_PATH };

const SI_156 = {
  citation: 'S.I. 156/2012',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2012/si/156/made/en/html',
  // Regulation 1(2) states its own commencement verbatim: "These Regulations
  // come into operation on 1 June 2012."
  effectiveFrom: '2012-06-01',
};

export interface Si156IngestResult {
  sourceId: string;
  regulationCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Ingest S.I. 156/2012. Only regs 1, 2 and 4 (the ones this local file
 * quotes verbatim) become provisions; see `si156Parser.ts`'s header.
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
      title: 'Tax Returns and Payments (Mandatory Electronic Filing and Payment of Tax) Regulations 2012',
      citation: SI_156.citation,
      jurisdiction: 'IE',
      sourceUrl: SI_156.sourceUrl,
      localPath: params.localPath ?? SI_156_2012_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: SI_156.effectiveFrom,
      sourceNote: 'This local transcript is NOT a complete verbatim rendering of the instrument: only '
        + 'regulations 1, 2 and 4 are quoted verbatim from the official text; regulation 3 has no body in this '
        + 'file and regulations 5-9 are replaced with a single editorial summary line. Only regs 1, 2 and 4 are '
        + 'ingested as provisions here; regs 3 and 5-9 are not fabricated and are not curated into any rule.',
      sourceDate: nowIso(),
    }).run();

    const parsed = parseSi156(params.markdown);
    const curatedRegs = new Set(SI_156_CURATED_RULES.map((r) => r.regulationNumber));
    let relevantCount = 0;
    for (const reg of parsed) {
      let { relevant, reason } = assessRelevance(reg.category);
      if (!relevant && curatedRegs.has(reg.regulationNumber)) {
        relevant = true;
        reason = 'Curated: mapped to a rule in si156Curation.ts, overriding the '
          + `${reg.category} category default.`;
      }
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
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, SI_156.citation)).get()?.id;
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
      if (existing.statement === rule.statementExcerpt) { unchanged++; continue; }
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
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: [],
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

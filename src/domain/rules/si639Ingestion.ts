/**
 * Ingestion and rule derivation for S.I. 639/2010 (Value-Added Tax
 * Regulations 2010), built on `si639Parser.ts`.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseSi639, provisionSlug, assessRelevance, SI_639_2010_MD_PATH } from './si639Parser';
import { SI_639_CURATED_RULES } from './si639Curation';
import { upsertReviewItem } from '../extraction/service';

export { SI_639_2010_MD_PATH };

const SI_639 = {
  citation: 'S.I. 639/2010',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2010/si/639/made/en/print',
  // Regulation 1(2) of this very document states its own commencement
  // verbatim: "These Regulations come into operation on 1 January 2011."
  effectiveFrom: '2011-01-01',
};

export interface Si639IngestResult {
  sourceId: string;
  regulationCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest the whole S.I. 639/2010 as-made document. Idempotent by content. */
export function ingestSi639(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si639IngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, SI_639.citation),
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
      title: 'Value-Added Tax Regulations 2010 (S.I. No. 639 of 2010)',
      citation: SI_639.citation,
      jurisdiction: 'IE',
      sourceUrl: SI_639.sourceUrl,
      localPath: params.localPath ?? SI_639_2010_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: SI_639.effectiveFrom,
      sourceNote: 'As-made 2010 text (the "print" consolidation at time of making) — not an LRC-revised '
        + 'text; later amending instruments (e.g. S.I. 734/2020, inserting reg.14A postponed accounting) are '
        + 'not reflected. The short per-regulation files already in docs/statutes/si-639-2010/ (reg-14.md '
        + 'etc.) are paraphrased summaries, not verbatim, and are not used as sources — this whole-document '
        + 'parse is the only verbatim source for these regulations.',
      sourceDate: nowIso(),
    }).run();

    const parsed = parseSi639(params.markdown);
    const curatedRegs = new Set(SI_639_CURATED_RULES.map((r) => r.regulationNumber));
    let relevantCount = 0;
    for (const reg of parsed) {
      let { relevant, reason } = assessRelevance(reg.category);
      if (!relevant && curatedRegs.has(reg.regulationNumber)) {
        relevant = true;
        reason = 'Curated: mapped to a rule in si639Curation.ts, overriding the '
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

export interface Si639DeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveSi639Rules(
  db: AppDatabase,
  params: { companyId: string },
): Si639DeriveResult {
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, SI_639.citation)).get()?.id;
  const provisions = sourceId
    ? db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).all()
    : [];

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of SI_639_CURATED_RULES) {
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
        .set({ effectiveTo: SI_639.effectiveFrom, active: false })
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
      effectiveFrom: SI_639.effectiveFrom,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${SI_639.citation} reg.${rule.regulationNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${rule.name}`,
      detail: `${SI_639.citation} reg.${rule.regulationNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, regulationNumber: rule.regulationNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

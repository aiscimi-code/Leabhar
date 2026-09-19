/**
 * Ingestion and rule derivation for S.I. 69/2025 Regulation 8 (the current
 * VATCA 2010 s.80(1) cash-accounting eligibility thresholds), built on
 * `si692025Parser.ts`.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseSi692025Regulation, provisionSlug, SI_69_2025_MD_PATH } from './si692025Parser';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';
import { upsertReviewItem } from '../extraction/service';

export { SI_69_2025_MD_PATH };

const SI_69_2025 = {
  citation: 'S.I. 69/2025',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2025/si/69/made/en/print',
  // No separate commencement clause in this instrument; it took effect when
  // made (front matter: "in_force_from: 2025-03-06", matching "GIVEN under
  // my Official Seal, 6 March, 2025.").
  effectiveFrom: '2025-03-06',
  regulationNumber: '8',
};

export interface Si692025IngestResult {
  sourceId: string;
  regulationCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest S.I. 69/2025 Regulation 8 only — see si692025Parser.ts's header. */
export function ingestSi692025Reg8(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si692025IngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, SI_69_2025.citation),
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
      title: 'European Union (Value-Added Tax) Regulations 2025 — Regulation 8 (VATCA s.80(1) amendment)',
      citation: SI_69_2025.citation,
      jurisdiction: 'IE',
      sourceUrl: SI_69_2025.sourceUrl,
      localPath: params.localPath ?? SI_69_2025_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: SI_69_2025.effectiveFrom,
      retrievedAt: nowIso(),
      effectiveFrom: SI_69_2025.effectiveFrom,
      sourceNote: 'Only Regulation 8 (substituting the current text of VATCA 2010 s.80(1)(a)/(b), the '
        + 'moneys-received/cash-basis eligibility thresholds) is ingested from this instrument — see '
        + 'si692025Parser.ts. Regulations 1-7, 9 and 10 (the EU cross-border SME exemption scheme and its '
        + 'consequential amendments) are not ingested in this pass.',
      sourceDate: nowIso(),
    }).run();

    const reg = parseSi692025Regulation(params.markdown, SI_69_2025.regulationNumber);
    const heading = 'Amendment of section 80(1) of the Value-Added Tax Consolidation Act 2010 '
      + '(moneys-received basis of accounting: eligibility thresholds)';
    // Curated override: reg.8 is pure amending-drafting text ("Section 80(1)
    // of the Act of 2010 is amended...") with no "VAT" keyword of its own, so
    // categoriseProvision's mechanical keyword match alone would call it
    // 'other' and mark it not relevant by default.
    const relevant = true;
    const reason = 'Curated: mapped to two rules in si692025Curation.ts (the s.80(1)(a)/(b) cash-accounting '
      + 'eligibility thresholds), overriding the mechanical "other" category default for amending text with no '
      + 'VAT keyword of its own.';

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: reg.regulationNumber,
      slug: provisionSlug(reg.regulationNumber, heading),
      heading,
      principalAct: 'Value-Added Tax Consolidation Act 2010',
      provisionText: reg.provisionText,
      sourceStart: reg.sourceStart,
      sourceEnd: reg.sourceEnd,
      category: 'vat',
      amendsSection: '80',
      effectiveClue: null,
      citedActs: ['Value-Added Tax Consolidation Act 2010'],
      relevant,
      relevanceReason: reason,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, regulationCount: 1, relevantCount: relevant ? 1 : 0, ingested: true };
  });
}

export interface Si692025DeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveSi692025Rules(
  db: AppDatabase,
  params: { companyId: string },
): Si692025DeriveResult {
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, SI_69_2025.citation)).get()?.id;
  const prov = sourceId
    ? db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, SI_69_2025.regulationNumber)))
      .get()
    : undefined;

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of SI_69_2025_CURATED_RULES) {
    if (!prov || !prov.relevant) { skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.statement === rule.statementExcerpt) { unchanged++; continue; }
      db.update(irishTaxRules)
        .set({ effectiveTo: SI_69_2025.effectiveFrom, active: false })
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
      extractedFact: rule.numericValue !== null ? String(rule.numericValue) : null,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: rule.qualifier,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: ['Value-Added Tax Consolidation Act 2010 s.80'],
      accountingEffect: null,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 60,
      effectiveFrom: SI_69_2025.effectiveFrom,
      source: 'derived',
      confidence: 80,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${SI_69_2025.citation} reg.8; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${rule.name}`,
      detail: `${SI_69_2025.citation} reg.8. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, regulationNumber: SI_69_2025.regulationNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

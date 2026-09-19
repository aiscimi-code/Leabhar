/**
 * Ingestion and rule derivation for S.I. 69/2025 (European Union
 * (Value-Added Tax) Regulations 2025), built on `si692025Parser.ts`.
 *
 * Three named regulations are ingested from this single document, each as
 * its own `irish_act_provisions` row under one shared `irish_knowledge_sources`
 * row (same citation, same content hash — it is one physical instrument):
 *
 *  - Regulation 5: substitutes the current "current calendar year or the
 *    previous calendar year" turnover test into VATCA 2010 s.6(1)(c)/(d) —
 *    closes the gap issue #136 bug 2 / issue #137 flagged: the registration-
 *    threshold rules (`financeAct2024VatThresholdsCuration.ts`) stated a
 *    threshold *figure* with no way to test actual turnover against it.
 *  - Regulation 8: substitutes the current text of VATCA 2010 s.80(1)(a)/(b),
 *    the moneys-received/cash-basis eligibility thresholds — closes a gap
 *    `si639Curation.ts` explicitly flagged ("the real threshold lives in
 *    section 80(1) of the Act, not this Regulation").
 *  - Regulation 9: inserts VATCA 2010 s.92B, defining "annual turnover" for
 *    the cross-border SME exemption scheme — and, as of Regulation 5 above,
 *    the same definition the registration-threshold turnover test now relies
 *    on (s.6(1)(c)/(d) as substituted use "annual turnover", not "consideration").
 *
 * Because all three share one source document, the idempotency check below
 * is scoped to (source citation + content hash + this regulation's own
 * section number) — the naive "does this source have *any* provision yet"
 * check the single-regulation predecessor of this file used would silently
 * skip ingesting a second regulation from the same already-ingested file.
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

export const SI_69_2025 = {
  citation: 'S.I. 69/2025',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2025/si/69/made/en/print',
  // No separate commencement clause in this instrument; it took effect when
  // made (front matter: "in_force_from: 2025-03-06", matching "GIVEN under
  // my Official Seal, 6 March, 2025.").
  effectiveFrom: '2025-03-06',
};

interface NamedRegulation {
  regulationNumber: string;
  heading: string;
  amendsSection: string;
  sourceNote: string;
}

const REG_5: NamedRegulation = {
  regulationNumber: '5',
  heading: 'Amendment of section 6(1) of the Value-Added Tax Consolidation Act 2010 '
    + '(registration-threshold turnover test: current or previous calendar year)',
  amendsSection: '6',
  sourceNote: 'Only Regulation 5 (substituting the current "current calendar year or the previous calendar '
    + 'year" turnover test into VATCA 2010 s.6(1)(c) and (d), and the "annual turnover" terminology into '
    + 's.6(1)(a)(ii)/(2)(b)) is ingested from this instrument in this pass — see si692025Parser.ts.',
};

const REG_8: NamedRegulation = {
  regulationNumber: '8',
  heading: 'Amendment of section 80(1) of the Value-Added Tax Consolidation Act 2010 '
    + '(moneys-received basis of accounting: eligibility thresholds)',
  amendsSection: '80',
  sourceNote: 'Only Regulation 8 (substituting the current text of VATCA 2010 s.80(1)(a)/(b), the '
    + 'moneys-received/cash-basis eligibility thresholds) is ingested from this instrument in this pass — see '
    + 'si692025Parser.ts.',
};

const REG_9: NamedRegulation = {
  regulationNumber: '9',
  heading: 'Insertion of Chapter 5 of Part 10 of the Value-Added Tax Consolidation Act 2010 '
    + '(cross-border SME exemption scheme: s.92B "annual turnover" definitions)',
  amendsSection: '92A',
  sourceNote: 'Only Regulation 9 (inserting VATCA 2010 ss.92B-92D; s.92B\'s "annual turnover" and related '
    + 'definitions only) is ingested from this instrument in this pass — see si692025Parser.ts. ss.92C/92D '
    + '(the cross-border scheme\'s registration/notification mechanics) are part of the same inserted text but '
    + 'not separately curated.',
};

export interface Si692025IngestResult {
  sourceId: string;
  regulationCount: number;
  relevantCount: number;
  ingested: boolean;
}

function ingestSi692025NamedRegulation(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
  reg: NamedRegulation,
): Si692025IngestResult {
  const digest = sha256Hex(params.markdown);

  const existingSource = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, SI_69_2025.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existingSource) {
    const existingProvision = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(and(
        eq(irishActProvisions.sourceId, existingSource.id),
        eq(irishActProvisions.sectionNumber, reg.regulationNumber),
      )).get();
    if (existingProvision) {
      return {
        sourceId: existingSource.id, regulationCount: 1,
        relevantCount: existingProvision.relevant ? 1 : 0, ingested: false,
      };
    }

    // The source document (this same file) was already ingested for a
    // different regulation — reuse its knowledge-source row and add just
    // this regulation's own provision, rather than skipping it as if the
    // whole document (and every regulation in it) were already covered.
    const parsed = parseSi692025Regulation(params.markdown, reg.regulationNumber);
    const relevant = true;
    const reason = `Curated: mapped to rule(s) in si692025Curation.ts for regulation ${reg.regulationNumber}, `
      + 'overriding the mechanical "other" category default for amending text with no VAT keyword of its own.';

    db.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId: existingSource.id,
      sectionNumber: reg.regulationNumber,
      slug: provisionSlug(reg.regulationNumber, reg.heading),
      heading: reg.heading,
      principalAct: 'Value-Added Tax Consolidation Act 2010',
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: 'vat',
      amendsSection: reg.amendsSection,
      effectiveClue: null,
      citedActs: ['Value-Added Tax Consolidation Act 2010'],
      relevant,
      relevanceReason: reason,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId: existingSource.id, regulationCount: 1, relevantCount: relevant ? 1 : 0, ingested: true };
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'legislation',
      title: 'European Union (Value-Added Tax) Regulations 2025',
      citation: SI_69_2025.citation,
      jurisdiction: 'IE',
      sourceUrl: SI_69_2025.sourceUrl,
      localPath: params.localPath ?? SI_69_2025_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: SI_69_2025.effectiveFrom,
      retrievedAt: nowIso(),
      effectiveFrom: SI_69_2025.effectiveFrom,
      sourceNote: reg.sourceNote,
      sourceDate: nowIso(),
    }).run();

    const parsed = parseSi692025Regulation(params.markdown, reg.regulationNumber);
    const relevant = true;
    const reason = `Curated: mapped to rule(s) in si692025Curation.ts for regulation ${reg.regulationNumber}, `
      + 'overriding the mechanical "other" category default for amending text with no VAT keyword of its own.';

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: reg.regulationNumber,
      slug: provisionSlug(reg.regulationNumber, reg.heading),
      heading: reg.heading,
      principalAct: 'Value-Added Tax Consolidation Act 2010',
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: 'vat',
      amendsSection: reg.amendsSection,
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

/** Ingest S.I. 69/2025 Regulation 5 (current VATCA s.6(1)(c)/(d) turnover test) only. */
export function ingestSi692025Reg5(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si692025IngestResult {
  return ingestSi692025NamedRegulation(db, params, REG_5);
}

/** Ingest S.I. 69/2025 Regulation 8 (current VATCA s.80(1) cash-accounting thresholds) only. */
export function ingestSi692025Reg8(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si692025IngestResult {
  return ingestSi692025NamedRegulation(db, params, REG_8);
}

/** Ingest S.I. 69/2025 Regulation 9 (VATCA s.92B "annual turnover" definitions) only. */
export function ingestSi692025Reg9(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): Si692025IngestResult {
  return ingestSi692025NamedRegulation(db, params, REG_9);
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

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of SI_69_2025_CURATED_RULES) {
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.regulationNumber)))
        .get()
      : undefined;
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
      crossReferences: [`Value-Added Tax Consolidation Act 2010 s.${rule.amendsSection}`],
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
      sourceNote: `Curated from ${SI_69_2025.citation} reg.${rule.regulationNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${rule.name}`,
      detail: `${SI_69_2025.citation} reg.${rule.regulationNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, regulationNumber: rule.regulationNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

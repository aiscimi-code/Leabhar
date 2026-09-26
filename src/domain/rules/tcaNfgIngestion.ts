/**
 * Ingestion for Revenue's Notes for Guidance on the TCA 1997 (FA 2025
 * edition; issue #211). Each part file is its own knowledge source
 * (`revenue_guidance`: the Notes rank below the Act) and each section issue
 * #211 needs is a provision, cut out by `tcaNfgParser.ts`. Rules derive from
 * `corporationTaxCuration.ts`; like every derived rule they start
 * `ai_extracted` and are never approved here.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { extractNfgSection } from './tcaNfgParser';
import { CORPORATION_TAX_CURATED_RULES, NFG_SECTIONS, nfgCitation } from './corporationTaxCuration';
import { provisionSlug } from './statuteParser';
import { upsertReviewItem } from '../extraction/service';

const NFG_URL = 'https://www.revenue.ie/en/tax-professionals/documents/notes-for-guidance/tca/';

export const nfgPath = (part: string) => `docs/statutes/tca-1997-nfg/${part}.md`;

export interface NfgIngestResult { sourceId: string; provisionCount: number; ingested: boolean }

/** Ingest the listed sections of one part. Idempotent by content. */
export function ingestTcaNfgPart(
  db: AppDatabase,
  params: { companyId?: string | null; part: string; markdown: string; ingestVersion: string; localPath?: string },
): NfgIngestResult {
  const citation = nfgCitation(params.part);
  const digest = sha256Hex(params.markdown);
  const sections = NFG_SECTIONS[params.part] ?? [];
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) {
    const count = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all().length;
    if (count === sections.length) return { sourceId: existing.id, provisionCount: count, ingested: false };
  }

  const parsed = sections.map((n) => extractNfgSection(params.markdown, n));
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'revenue_guidance',
      title: `Notes for Guidance — Taxes Consolidation Act 1997 — Finance Act 2025 edition — ${params.part}`,
      citation,
      jurisdiction: 'IE',
      sourceUrl: `${NFG_URL}${params.part}.pdf`,
      localPath: params.localPath ?? nfgPath(params.part),
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: '2025-12-31',
      sourceNote: 'Revenue guidance summarising the TCA 1997 as amended to Finance Act 2025. There is no LRC revised '
        + 'TCA; the Notes are the current consolidated statement of each section, but rank below the Act itself.',
      sourceDate: nowIso(),
    }).run();
    for (const section of parsed) {
      const curated = CORPORATION_TAX_CURATED_RULES.some((r) => r.part === params.part && r.sectionNumber === section.sectionNumber);
      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: section.sectionNumber,
        slug: provisionSlug(`nfg-${section.sectionNumber}`, section.heading),
        heading: section.heading,
        principalAct: '1997 Act 39',
        provisionText: section.provisionText,
        sourceStart: section.sourceStart,
        sourceEnd: section.sourceEnd,
        category: 'corporation_tax',
        amendsSection: null,
        effectiveClue: null,
        citedActs: [],
        relevant: true,
        relevanceReason: curated
          ? 'Curated: mapped to a rule in corporationTaxCuration.ts.'
          : 'In scope for the corporation tax computation (issue #211); not yet curated.',
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, provisionCount: parsed.length, ingested: true };
  });
}

export interface NfgDeriveResult { created: number; superseded: number; unchanged: number; skippedNoProvision: string[] }

/** Derive the curated corporation tax rules. An unchanged rule is left alone; a changed one supersedes it. */
export function deriveCorporationTaxRules(db: AppDatabase, params: { companyId: string }): NfgDeriveResult {
  const result: NfgDeriveResult = { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [] };
  for (const rule of CORPORATION_TAX_CURATED_RULES) {
    const sourceIds = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, nfgCitation(rule.part))).all().map((s) => s.id);
    const prov = sourceIds.length
      ? db.select().from(irishActProvisions).where(eq(irishActProvisions.sectionNumber, rule.sectionNumber)).all()
        .filter((p) => sourceIds.includes(p.sourceId)).at(-1)
      : undefined;
    if (!prov || !prov.provisionText?.includes(rule.statementExcerpt)) { result.skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, rule.ruleKey), eq(irishTaxRules.active, true)))
      .get();
    if (existing && existing.statement === rule.statementExcerpt && existing.numericValue === rule.numericValue
      && existing.provisionId === prov.id) {
      result.unchanged++;
      continue;
    }
    if (existing) {
      db.update(irishTaxRules).set({ effectiveTo: rule.effectiveFrom, active: false }).where(eq(irishTaxRules.id, existing.id)).run();
      result.superseded++;
    }
    const id = ids.taxRule();
    db.insert(irishTaxRules).values({
      id,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: 'corporation_tax',
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: rule.numericValue !== null ? String(rule.numericValue) : null,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: null,
      conditions: [],
      exceptions: [],
      crossReferences: [],
      accountingEffect: null,
      taxEffect: rule.taxEffect,
      vatEffect: null,
      reportingEffect: null,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: rule.effectiveFrom,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${nfgCitation(rule.part)} s.${rule.sectionNumber} (Revenue guidance); not yet human-reviewed. `
        + rule.interpretationNote,
      sourceDate: nowIso(),
    }).run();
    result.created++;
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New corporation tax rule extracted: ${rule.name}`,
      detail: `${nfgCitation(rule.part)} s.${rule.sectionNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: id,
      dedupeKey: `irish_tax_rule:${id}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber },
    });
  }
  return result;
}

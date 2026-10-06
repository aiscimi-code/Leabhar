/**
 * Ingestion for Revenue's Notes for Guidance on the TCA 1997 (FA 2025
 * edition; issue #211). Each part is its own knowledge source
 * (`revenue_guidance`: the Notes rank below the Act) and each section issue
 * #211 needs is a provision, cut out by `tcaNfgParser.ts`. The knowledge base
 * loads every part from its rules catalogue entry
 * (`catalogue/tca-1997-nfg/<part>.json`, with Revenue's PDF beside it;
 * `ingestTcaNfgFromCatalogue`, #556). Rules derive from
 * `corporationTaxCuration.ts`; like every derived rule they start
 * `ai_extracted` and are never approved here.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { CORPORATION_TAX_CURATED_RULES, NFG_SECTIONS, nfgCitation } from './corporationTaxCuration';
import { upsertReviewItem } from '../extraction/service';
import { crossReferencesFromProvision, sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';

const NFG_URL = 'https://www.revenue.ie/en/tax-professionals/documents/notes-for-guidance/tca/';

/** The parts the knowledge base holds, each a catalogue entry. */
export const NFG_PARTS = Object.keys(NFG_SECTIONS);

export const nfgTitle = (part: string) => `Notes for Guidance — Taxes Consolidation Act 1997 — Finance Act 2025 edition — ${part}`;
export const nfgSourceUrl = (part: string) => `${NFG_URL}${part}.pdf`;

/** The edition's date: the Notes state the Act as amended to Finance Act 2025. */
export const NFG_EFFECTIVE_FROM = '2025-12-31';

/** What every part's source says of itself. */
export const NFG_NOTE = 'Revenue guidance summarising the TCA 1997 as amended to Finance Act 2025. There is no LRC revised '
  + 'TCA; the Notes are the current consolidated statement of each section, but rank below the Act itself.';

/** Why a section's note is held: curated into a rule, or in scope and waiting. */
export function nfgRelevanceReason(part: string, sectionNumber: string): string {
  return CORPORATION_TAX_CURATED_RULES.some((r) => r.part === part && r.sectionNumber === sectionNumber)
    ? 'Curated: mapped to a rule in corporationTaxCuration.ts.'
    : 'In scope for the corporation tax computation (issue #211); not yet curated.';
}

/** A part's catalogue entry. */
export const nfgCatalogueEntry = (part: string) => `tca-1997-nfg/${part}.json`;

export interface NfgCatalogueIngestResult { parts: Array<CatalogueIngestResult & { part: string }> }

/** Load every part from its catalogue entry. */
export function ingestTcaNfgFromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): NfgCatalogueIngestResult {
  return { parts: NFG_PARTS.map((part) => ({ part, ...ingestCatalogueFile(db, { ...params, entry: nfgCatalogueEntry(part) }) })) };
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
      && existing.provisionId === prov.id
      && sameCrossReferences(existing.crossReferences, crossReferencesFromProvision(prov))) {
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
      taxHeads: taxHeadsFor(rule.ruleKey, 'corporation_tax'),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: rule.numericValue !== null ? String(rule.numericValue) : null,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: null,
      conditions: [],
      exceptions: [],
      crossReferences: crossReferencesFromProvision(prov),
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

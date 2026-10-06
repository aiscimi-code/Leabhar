/**
 * Ingestion of Revenue's VAT3 and RTD form guidance as knowledge-base sources,
 * and derivation of the curated reporting rules from them (issue #439).
 *
 * The VAT return screens already implement these documents' box layouts
 * (src/domain/vat/boxDefinitions.ts and rtd.ts quote them); what was missing
 * was the rules knowledge base's own copy: a source row with the URL and
 * hash, provisions carrying the verbatim definitions, and rules a report can
 * cite when it names a box. Nothing here replaces the screens — it is the
 * citation behind them. The knowledge base loads both documents from their
 * rules catalogue entries (`ingestVat3RtdFromCatalogue`, #556).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { upsertReviewItem } from '../extraction/service';
import { parseVat3Boxes, parseRtdManualSections, type ParsedPassage } from './vat3RtdParser';
import { VAT3_BOX_RULES, RTD_MANUAL_RULES, VAT3_GUIDANCE_CITATION, RTD_TDM_CITATION, type CuratedFormRule } from './vat3RtdCuration';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';

/** S.I. 639/2010 came into force on 1 January 2011 (si639Ingestion.ts); the
 * return obligations these boxes report on date from it. */
const FORM_RULES_EFFECTIVE_FROM = '2011-01-01';

/** Every passage's provision: the Act the guidance explains, and why it is held. */
export const FORM_GUIDANCE_PRINCIPAL_ACT = 'Value-Added Tax Consolidation Act 2010';
export const FORM_GUIDANCE_RELEVANCE_REASON = 'Curated: a reporting rule cites this passage (vat3RtdCuration.ts).';

export const VAT3_GUIDANCE = {
  citation: VAT3_GUIDANCE_CITATION,
  title: 'Revenue: How do you complete a VAT 3 return?',
  sourceUrl: 'https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx',
  // The page itself states "Published: 28 July 2026".
  effectiveFrom: '2026-07-28',
  publicationDate: '2026-07-28' as string | null,
  note: 'Revenue\'s own page of VAT3 box definitions, quoted passage by passage. It is guidance, not '
    + 'legislation: it explains the return S.I. 639/2010 reg.24 prescribes, and ranks below that '
    + 'Regulation and VATCA s.76. src/domain/vat/boxDefinitions.ts implements the same mapping.',
};

export const RTD_TDM = {
  citation: RTD_TDM_CITATION,
  title: 'Revenue TDM VAT-RTD-S76 — VAT Return of Trading Details (Part 9, Chapter 3)',
  sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part09-obligations-accountable-persons/return/VAT-RTD-S76.pdf',
  // The manual's own cover: "Document last updated February 2026".
  effectiveFrom: '2026-02-01',
  publicationDate: null as string | null,
  note: 'Revenue\'s Tax and Duty Manual on the annual Return of Trading Details, curated for its obligations and the four '
    + 'reporting sections. The statutory requirement is VATCA s.76 and S.I. 639/2010 reg.24(1); the manual explains how '
    + 'they are filed. src/domain/vat/rtd.ts implements the same grid.',
};

/** The two documents' catalogue entries. */
export const VAT3_GUIDANCE_CATALOGUE_ENTRY = 'vat3-rtd/completing-vat3-return.json';
export const RTD_TDM_CATALOGUE_ENTRY = 'vat3-rtd/VAT-RTD-S76.json';

/** Load both documents from their catalogue entries. */
export function ingestVat3RtdFromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CatalogueIngestResult[] {
  return [VAT3_GUIDANCE_CATALOGUE_ENTRY, RTD_TDM_CATALOGUE_ENTRY].map((entry) => ingestCatalogueFile(db, { ...params, entry }));
}

/** The VAT3 page's box passages, each located by its box. */
export function vat3GuidancePassages(text: string): Array<ParsedPassage & { locator: string }> {
  const passages = parseVat3Boxes(text).map((p) => ({ ...p, locator: `box ${p.sectionNumber}` }));
  if (passages.length === 0) throw new Error('The VAT3 guidance page defines no boxes this parser recognises.');
  return passages;
}

/** The RTD manual's curated passages, each located by its page. */
export function rtdTdmPassages(text: string): Array<ParsedPassage & { locator: string }> {
  // Page numbers are the manual's own table of contents: §1 → 3, §2.2 → 6, §2.3 → 7, §2.4 → 8, §2.5 → 9, §2.6 → 10.
  const pages: Record<string, number> = { '1': 3, '2.2': 6, '2.3': 7, '2.4': 8, '2.5': 9, '2.6': 10 };
  const passages = parseRtdManualSections(text).map((p) => ({ ...p, locator: `page ${pages[p.sectionNumber] ?? '?'}` }));
  if (passages.length === 0) throw new Error('The RTD TDM contains none of the curated sections this parser looks for.');
  return passages;
}

export interface FormGuidanceIngestResult {
  sourceId: string;
  provisionCount: number;
  ingested: boolean;
}

/** Ingest one of the two guidance documents from a Markdown copy: source row plus one provision per passage. */
function ingestGuidanceSource(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
  source: typeof VAT3_GUIDANCE | typeof RTD_TDM,
  passages: ParsedPassage[],
): FormGuidanceIngestResult {
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, source.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) {
    const count = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all().length;
    return { sourceId: existing.id, provisionCount: count, ingested: false };
  }
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'revenue_guidance',
      title: source.title,
      citation: source.citation,
      jurisdiction: 'IE',
      sourceUrl: source.sourceUrl,
      localPath: params.localPath,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: source.publicationDate,
      retrievedAt: nowIso(),
      effectiveFrom: source.effectiveFrom,
      sourceNote: source.note,
      sourceDate: nowIso(),
    }).run();
    for (const passage of passages) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: passage.sectionNumber,
        slug: `vat3-rtd-${passage.sectionNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        heading: passage.heading,
        principalAct: FORM_GUIDANCE_PRINCIPAL_ACT,
        provisionText: passage.provisionText,
        sourceStart: passage.sourceStart,
        sourceEnd: passage.sourceEnd,
        locator: passage.locator,
        category: 'procedure',
        amendsSection: null,
        effectiveClue: null,
        citedActs: [],
        relevant: true,
        relevanceReason: FORM_GUIDANCE_RELEVANCE_REASON,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, provisionCount: passages.length, ingested: true };
  });
}

/** Ingest the VAT3 page from a Markdown copy (the CLI's --file). */
export function ingestVat3ReturnGuidance(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): FormGuidanceIngestResult {
  return ingestGuidanceSource(db, params, VAT3_GUIDANCE, vat3GuidancePassages(params.markdown));
}

/** Ingest the RTD manual from a Markdown copy (the CLI's --file). */
export function ingestRtdTdm(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): FormGuidanceIngestResult {
  return ingestGuidanceSource(db, params, RTD_TDM, rtdTdmPassages(params.markdown));
}

export interface FormRulesDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/** Derive the curated VAT3 box rules and RTD reporting rules from the ingested passages. */
export function deriveVat3RtdRules(db: AppDatabase, params: { companyId: string }): FormRulesDeriveResult {
  const result: FormRulesDeriveResult = { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [] };
  const rules: CuratedFormRule[] = [...VAT3_BOX_RULES, ...RTD_MANUAL_RULES];
  for (const rule of rules) {
    const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).get()?.id;
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber))).get()
      : undefined;
    if (!prov || !prov.provisionText?.includes(rule.statementExcerpt)) {
      result.skippedNoProvision.push(rule.ruleKey);
      continue;
    }
    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();
    if (existing && existing.statement === rule.statementExcerpt && existing.provisionId === prov.id
      && existing.crossReferences.join('; ') === rule.crossReferences.join('; ')) {
      result.unchanged++;
      continue;
    }
    if (existing) {
      db.update(irishTaxRules)
        .set({ effectiveTo: FORM_RULES_EFFECTIVE_FROM, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      result.superseded++;
    }
    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: rule.ruleKey.startsWith('vat3.') ? 'vat_return_form' : 'rtd',
      taxHeads: taxHeadsFor(rule.ruleKey, rule.ruleKey.startsWith('vat3.') ? 'vat_return_form' : 'rtd'),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: [],
      exceptions: [],
      crossReferences: rule.crossReferences,
      accountingEffect: null,
      taxEffect: null,
      vatEffect: null,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: false,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: FORM_RULES_EFFECTIVE_FROM,
      source: 'derived',
      confidence: 75,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} (${rule.sectionNumber}); not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    result.created++;
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish form rule extracted: ${rule.name}`,
      detail: `${rule.citation} (${rule.sectionNumber}). ${rule.interpretationNote} Review against the source text `
        + 'and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey },
    });
  }
  return result;
}

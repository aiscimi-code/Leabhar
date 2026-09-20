/**
 * Ingestion and rule derivation for capital allowances, built on the
 * generic `tca1997Ingestion.ts` pipeline and `capitalAllowancesCuration.ts`.
 *
 * Finance Act 2003 s.23 (issue #132) is a different Act from TCA 1997
 * itself, so it can't use `ingestTca1997Section` as-is (that function
 * hardcodes the "1997 Act 39" citation and irishstatutebook.ie TCA-1997 URL
 * pattern) — but its source file has the exact same one-section-per-file,
 * bare-`"N."`-opener shape `parseTca1997Section` already parses (verified
 * against s23.md directly), so the parser itself is reused; only the
 * knowledge-source metadata (citation, URL) is Finance-Act-2003-specific.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { ingestTca1997Section, type Tca1997IngestResult } from './tca1997Ingestion';
import { parseTca1997Section, provisionSlug } from './tca1997SectionParser';
import { CAPITAL_ALLOWANCES_CURATED_RULES } from './capitalAllowancesCuration';
import { upsertReviewItem } from '../extraction/service';

export const TCA_1997_S284_MD_PATH = new URL(
  '../../../docs/statutes/tca-1997/s284.md',
  import.meta.url,
).pathname;

export const FINANCE_ACT_2003_S23_MD_PATH = new URL(
  '../../../docs/statutes/finance-act-2003/s23.md',
  import.meta.url,
).pathname;

const FINANCE_ACT_2003 = {
  citation: '2003 Act 3 s.23',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2003/act/3/section/23/enacted/en/html',
  // s.23(2): "This section applies as on and from 4 December 2002."
  effectiveFrom: '2002-12-04',
};

const CURATED_SECTION_NUMBERS = new Set(CAPITAL_ALLOWANCES_CURATED_RULES.map((r) => r.sectionNumber));

export function ingestTca1997S284(
  db: AppDatabase,
  params: { companyId?: string | null; markdown?: string; ingestVersion: string; localPath?: string },
): Tca1997IngestResult {
  const markdown = params.markdown ?? readFileSync(TCA_1997_S284_MD_PATH, 'utf8');
  return ingestTca1997Section(db, {
    companyId: params.companyId,
    markdown,
    ingestVersion: params.ingestVersion,
    localPath: params.localPath ?? TCA_1997_S284_MD_PATH,
    curatedSectionNumbers: CURATED_SECTION_NUMBERS,
  });
}

/** Ingest Finance Act 2003 s.23 (issue #132: current 12.5% wear-and-tear rate). Idempotent by content. */
export function ingestFinanceAct2003S23(
  db: AppDatabase,
  params: { companyId?: string | null; markdown?: string; ingestVersion: string; localPath?: string },
): Tca1997IngestResult {
  const markdown = params.markdown ?? readFileSync(FINANCE_ACT_2003_S23_MD_PATH, 'utf8');
  const digest = sha256Hex(markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, FINANCE_ACT_2003.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id, sectionNumber: '23', provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    const parsed = parseTca1997Section(markdown);
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'legislation',
      title: `Finance Act 2003 s.${parsed.sectionNumber}`,
      citation: FINANCE_ACT_2003.citation,
      jurisdiction: 'IE',
      sourceUrl: FINANCE_ACT_2003.sourceUrl,
      localPath: params.localPath ?? FINANCE_ACT_2003_S23_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: FINANCE_ACT_2003.effectiveFrom,
      sourceNote: 'As-enacted 2003 text — the amending Act that inserted TCA 1997 s.284(2)(ad), the current '
        + '12.5% wear-and-tear rate, for capital expenditure incurred on or after 4 December 2002. Finance Act '
        + '2001 s.53 inserted an earlier 20% rate from 1 January 2001, itself superseded by this section for '
        + 'expenditure from 4 December 2002 onward; not independently ingested as no rule needs the superseded '
        + 'figure (docs/statutes/finance-act-2001/s53.md exists verbatim on disk for the trail).',
      sourceDate: nowIso(),
    }).run();

    const relevant = true; // curated: mapped to income_tax.wear_and_tear_rate_current below
    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      chapter: parsed.chapter,
      slug: provisionSlug(parsed.sectionNumber, parsed.heading),
      heading: parsed.heading,
      principalAct: 'Taxes Consolidation Act 1997',
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: parsed.category,
      amendsSection: '284',
      effectiveClue: null,
      citedActs: ['Taxes Consolidation Act 1997'],
      relevant,
      relevanceReason: 'Curated: mapped to income_tax.wear_and_tear_rate_current in capitalAllowancesCuration.ts.',
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, sectionNumber: parsed.sectionNumber, provisionCount: 1, relevantCount: 1, ingested: true };
  });
}

export interface CapitalAllowancesDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveCapitalAllowancesRules(
  db: AppDatabase,
  params: { companyId: string },
): CapitalAllowancesDeriveResult {
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of CAPITAL_ALLOWANCES_CURATED_RULES) {
    const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).get()?.id;
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
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
        .set({ effectiveTo: rule.effectiveFrom, active: false })
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
      crossReferences: [],
      accountingEffect: rule.accountingEffect,
      taxEffect: rule.taxEffect,
      vatEffect: null,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: rule.effectiveFrom,
      source: 'derived',
      confidence: 65,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish capital allowances rule extracted: ${rule.name}`,
      detail: `${rule.citation} s.${rule.sectionNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

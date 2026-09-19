/**
 * Ingestion and rule derivation for capital allowances, built on the
 * generic `tca1997Ingestion.ts` pipeline and `capitalAllowancesCuration.ts`.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { ingestTca1997Section, type Tca1997IngestResult } from './tca1997Ingestion';
import { CAPITAL_ALLOWANCES_CURATED_RULES } from './capitalAllowancesCuration';
import { upsertReviewItem } from '../extraction/service';

export const TCA_1997_S284_MD_PATH = new URL(
  '../../../docs/statutes/tca-1997/s284.md',
  import.meta.url,
).pathname;

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
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
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

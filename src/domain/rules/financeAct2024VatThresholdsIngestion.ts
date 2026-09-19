/**
 * Derives the two current VAT registration threshold rules from Finance Act
 * 2024 s.78, which is already ingested as part of the whole Act
 * (`ingestFinanceAct2024`) — see `financeAct2024VatThresholdsCuration.ts`'s
 * header for why this is a separate, small derive step rather than an
 * extension of `SECTION_RULE_KEYS`.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { FINANCE_ACT_2024 } from './irishRules';
import {
  FINANCE_ACT_2024_VAT_THRESHOLD_RULES, FINANCE_ACT_2024_S78_SECTION_NUMBER,
  FINANCE_ACT_2024_S78_EFFECTIVE_FROM,
} from './financeAct2024VatThresholdsCuration';
import { upsertReviewItem } from '../extraction/service';

export interface FinanceAct2024VatThresholdsDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

export function deriveFinanceAct2024VatThresholds(
  db: AppDatabase,
  params: { companyId: string },
): FinanceAct2024VatThresholdsDeriveResult {
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, FINANCE_ACT_2024.citation)).get()?.id;
  const prov = sourceId
    ? db.select().from(irishActProvisions)
      .where(and(
        eq(irishActProvisions.sourceId, sourceId),
        eq(irishActProvisions.sectionNumber, FINANCE_ACT_2024_S78_SECTION_NUMBER),
      ))
      .get()
    : undefined;

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  if (!prov) {
    for (const rule of FINANCE_ACT_2024_VAT_THRESHOLD_RULES) skippedNoProvision.push(rule.ruleKey);
    return { created, superseded, unchanged, skippedNoProvision };
  }

  // s.78's mechanical category is 'definitions' (its text says "in the
  // definition of ... threshold"), so it was ingested as not relevant by
  // the default categoriser. This curated review corrects that judgement —
  // the same override SECTION_RULE_KEYS makes for other sections at ingest
  // time, applied here after the fact.
  if (!prov.relevant) {
    db.update(irishActProvisions)
      .set({
        relevant: true,
        relevanceReason: 'Curated: mapped to vat.registration_threshold_goods/services in '
          + 'financeAct2024VatThresholdsCuration.ts, overriding the mechanical "definitions" category default '
          + '("in the definition of ... threshold" matched the definitions keyword rule before any VAT-specific one).',
      })
      .where(eq(irishActProvisions.id, prov.id))
      .run();
  }

  for (const rule of FINANCE_ACT_2024_VAT_THRESHOLD_RULES) {
    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.statement === rule.statementExcerpt) { unchanged++; continue; }
      db.update(irishTaxRules)
        .set({ effectiveTo: FINANCE_ACT_2024_S78_EFFECTIVE_FROM, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      superseded++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: 'threshold',
      topic: rule.topic,
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: `€${(rule.numericValueMinor / 100).toLocaleString('en-IE')}`,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValueMinor,
      unit: 'eur_minor',
      qualifier: null,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: ['Value-Added Tax Consolidation Act 2010 s.2'],
      accountingEffect: null,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: null,
      requiresGuidance: false,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 80,
      effectiveFrom: FINANCE_ACT_2024_S78_EFFECTIVE_FROM,
      source: 'derived',
      confidence: 85,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${FINANCE_ACT_2024.citation} s.${FINANCE_ACT_2024_S78_SECTION_NUMBER}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${rule.name}`,
      detail: `${FINANCE_ACT_2024.citation} s.${FINANCE_ACT_2024_S78_SECTION_NUMBER}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: FINANCE_ACT_2024_S78_SECTION_NUMBER },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

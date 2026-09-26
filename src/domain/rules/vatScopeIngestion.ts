/**
 * Derive the exempt and outside-the-scope rules in `vatScopeCuration.ts`
 * (issue #200 step 5).
 *
 * The sources themselves are ingested by the existing generic ingesters —
 * Schedule 1 by `ingestVatcaSchedule` (scheduleNumber '1') and revised s.2/s.3
 * by `ingestVatcaRevisedSection` — so this module only derives. It differs
 * from the older derive functions in one deliberate way, the guard issue #199
 * recommended: a curated rule whose `statementExcerpt` is not a verbatim
 * substring of its provision's text is refused and reported, never inserted.
 * A rule that quotes words its cited provision does not contain is not
 * traceable, however plausible it looks.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { VAT_PLACE_OF_SUPPLY_CURATED_RULES } from './vatPlaceOfSupplyCuration';
import { lrcHtmlForSource } from './vatcaScheduleIngestion';
import { COMPOSITE_SUPPLY_RULES } from './compositeSupplyCuration';
import { CROSS_BORDER_CURATED_RULES } from './crossBorderCuration';
import { DOMESTIC_RC_CURATED_RULES } from './domesticReverseChargeCuration';
import { CASH_BASIS_CURATED_RULES } from './cashBasisCuration';
import { PROPERTY_CURATED_RULES } from './propertyCuration';
import { SCHEMES_CURATED_RULES } from './schemesCuration';
import { INPUT_RECOVERY_CURATED_RULES, RETIRED_INPUT_RECOVERY_RULE_KEYS } from './inputRecoveryCuration';
import { quotedTextWindow } from './lrcAnnotations';

/** Every rule this module derives: scope/exemption and place of supply of services. */
export const VAT_SCOPE_DERIVED_RULES = [
  ...VAT_SCOPE_CURATED_RULES, ...VAT_PLACE_OF_SUPPLY_CURATED_RULES, ...COMPOSITE_SUPPLY_RULES, ...CROSS_BORDER_CURATED_RULES, ...DOMESTIC_RC_CURATED_RULES, ...CASH_BASIS_CURATED_RULES, ...PROPERTY_CURATED_RULES, ...SCHEMES_CURATED_RULES, ...INPUT_RECOVERY_CURATED_RULES,
];
import { upsertReviewItem } from '../extraction/service';

export interface VatScopeDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
  /** Rules refused because their quoted excerpt is not in the provision text. */
  skippedExcerptNotInProvision: string[];
}

export function deriveVatScopeRules(
  db: AppDatabase,
  params: { companyId: string },
): VatScopeDeriveResult {
  const result: VatScopeDeriveResult = {
    created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [], skippedExcerptNotInProvision: [],
  };

  for (const rule of VAT_SCOPE_DERIVED_RULES) {
    // The most recently ingested source for this citation: a re-fetched file
    // with new bytes is a new source row, and the rule should cite the latest.
    const source = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation))
      .orderBy(desc(irishKnowledgeSources.retrievedAt)).get();
    const prov = source
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, source.id), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
    if (!prov) { result.skippedNoProvision.push(rule.ruleKey); continue; }
    if (!(prov.provisionText ?? '').includes(rule.statementExcerpt)) {
      result.skippedExcerptNotInProvision.push(rule.ruleKey);
      continue;
    }

    // A rule is good only from the last change to the words it relies on
    // (issue #206), read from the LRC HTML beside the source when it is there.
    const html = source ? lrcHtmlForSource(db, source.id) : null;
    const window = html ? quotedTextWindow(html, [rule.statementExcerpt, ...(rule.windowQuotes ?? [])]) : null;
    const effectiveFrom = window?.effectiveFrom ?? rule.effectiveFrom;
    const windowNote = window
      ? (window.footnotes.length
        ? `Effective from ${effectiveFrom}, the latest LRC amendment to the quoted words: `
          + `${window.footnotes.map((f) => `${f.ref} ${f.text}`).join(' ')} `
        : `Effective from ${effectiveFrom}: the LRC records no amendment to the quoted words since the Act commenced. `)
      : '';

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.provisionId === prov.id && existing.statement === rule.statementExcerpt
          && JSON.stringify(existing.conditions) === JSON.stringify(rule.conditions)
          && existing.effectiveFrom === effectiveFrom) {
        result.unchanged++;
        continue;
      }
      // The replacement describes the same law better (a corrected window or
      // proxy), so the old row is retired outright, its window emptied, rather
      // than left in force until today.
      db.update(irishTaxRules)
        .set({ effectiveTo: existing.effectiveFrom, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      result.superseded++;
    }

    const ruleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: ruleId,
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
      qualifier: rule.treatment ? `Treatment: ${rule.treatment}` : 'Treatment decided from context (see vatSuggestion.ts)',
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: rule.crossReferences,
      accountingEffect: rule.accountingEffect,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom,
      effectiveTo: null,
      source: 'derived',
      confidence: 60,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} ${rule.citation.includes('Sch.') ? 'para' : 's.'}${rule.sectionNumber} `
        + `(LRC revised). Not yet human-reviewed. ${windowNote}${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    result.created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT scope rule extracted: ${rule.name}`,
      detail: `${rule.citation} ${rule.sectionNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: ruleId,
      dedupeKey: `irish_tax_rule:${ruleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber },
    });
  }

  // Rules replaced by better-sourced ones (the as-enacted s.59/s.60, issue #209):
  // their stored rows are retired with an empty window, never deleted.
  for (const row of db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, params.companyId)).all()) {
    if (RETIRED_INPUT_RECOVERY_RULE_KEYS.includes(row.ruleKey) && row.effectiveTo !== row.effectiveFrom) {
      db.update(irishTaxRules).set({ effectiveTo: row.effectiveFrom, active: false }).where(eq(irishTaxRules.id, row.id)).run();
      result.superseded++;
    }
  }

  return result;
}

/**
 * Ingestion for individual VATCA 2010 sections in their LRC-revised form
 * (docs/statutes/vatca-2010-revised/s*.md) — a third, distinct family of
 * VATCA sources alongside the as-enacted whole-Act text (`vatcaIngestion.ts`)
 * and the revised Schedules (`vatcaScheduleIngestion.ts`). Each revised
 * section is its own independently-fetched, independently-hashed document
 * (its own `source_html_sha256`), so — matching the Schedule precedent —
 * each becomes its own `irish_knowledge_sources` row rather than being
 * merged into the whole-Act source, which would conflate a 2010 snapshot
 * with continuously-updated current text.
 *
 * Built generically (`ingestVatcaRevisedSection` takes any section's
 * Markdown) rather than hard-coded to one section, so a future pass can
 * ingest more of the ~50 available files without a new ingestion function
 * each time — this pass curates only s.46 (rates), the single section this
 * whole family exists to fix (see `vatcaRevisedCuration.ts`'s header for
 * why the as-enacted text could never safely state a current rate).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseVatcaRevisedSection, provisionSlug, assessRelevance, VATCA_REVISED_S046_MD_PATH,
} from './vatcaRevisedSectionParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { upsertReviewItem } from '../extraction/service';

export { VATCA_REVISED_S046_MD_PATH };

const SOURCE_TYPE: IrishSourceType = 'legislation';

export interface VatcaRevisedIngestResult {
  sourceId: string;
  sectionNumber: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest one VATCA revised section's Markdown. Idempotent by content. */
export function ingestVatcaRevisedSection(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): VatcaRevisedIngestResult {
  const fm = parseScheduleFrontMatter(params.markdown);
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, fm.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      const parsed = parseVatcaRevisedSection(params.markdown);
      return {
        sourceId: existing.id, sectionNumber: parsed.sectionNumber, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  const parsed = parseVatcaRevisedSection(params.markdown);

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: SOURCE_TYPE,
      title: fm.title,
      citation: fm.citation,
      jurisdiction: 'IE',
      sourceUrl: fm.sourceUrl,
      localPath: params.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      // Unlike vatca-2010 (frozen 2010 as-enacted text) and the Schedules
      // (which at least mark an lrc_updated_to date), this simpler
      // extraction records no "consolidated to" date of its own — the LRC
      // page reflects whatever was in force when fetched, which can move.
      // effectiveFrom here means "confirmed accurate as of ingest", not a
      // historical commencement date; see individual rules' own sourceNote
      // for anything more precise a provision's own text supports.
      effectiveFrom: nowIso().slice(0, 10),
      sourceNote: `Ingest ${params.ingestVersion} of ${fm.citation}, LRC-revised text as retrieved — `
        + 'a live, continuously-updated page, not a dated historical snapshot. Distinct source row from '
        + 'both "2010 Act 31" (the frozen as-enacted whole-Act text) and any Schedule source; never merged '
        + 'with either.',
      sourceDate: nowIso(),
    }).run();

    let { relevant, reason } = assessRelevance(parsed.category);
    const curated = VATCA_REVISED_CURATED_RULES.some((r) => r.sectionNumber === parsed.sectionNumber)
      || VAT_SCOPE_CURATED_RULES.some((r) => r.citation === fm.citation);
    if (!relevant && curated) {
      relevant = true;
      reason = `Curated: mapped to a rule in vatcaRevisedCuration.ts, overriding the ${parsed.category} category default.`;
    }

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      slug: provisionSlug(`revised-${parsed.sectionNumber}`, parsed.heading),
      heading: parsed.heading,
      principalAct: null,
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: parsed.category,
      amendsSection: null,
      effectiveClue: null,
      citedActs: [],
      relevant,
      relevanceReason: reason,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, sectionNumber: parsed.sectionNumber, provisionCount: 1, relevantCount: relevant ? 1 : 0, ingested: true };
  });
}

export interface VatcaRevisedDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/** Derive `irish_tax_rules` rows from `VATCA_REVISED_CURATED_RULES`. */
export function deriveVatcaRevisedRules(
  db: AppDatabase,
  params: { companyId: string },
): VatcaRevisedDeriveResult {
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of VATCA_REVISED_CURATED_RULES) {
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
      if (existing.statement === rule.statementExcerpt && existing.numericValue === rule.numericValue) {
        unchanged++; continue;
      }
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
      extractedFact: rule.extractedFact,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: rule.qualifier,
      conditions: rule.conditions,
      exceptions: [],
      crossReferences: [],
      accountingEffect: null,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: null,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} (LRC revised, as retrieved); not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rate rule extracted: ${rule.name}`,
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

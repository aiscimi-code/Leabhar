/**
 * Ingestion and rule derivation for VATCA 2010 Schedules 2 and 3.
 *
 * Mirrors `vatcaIngestion.ts` (ingest -> provisions -> derive curated rules
 * -> generic lookup), but as its own module for a reason that matters: the
 * Schedule text here is the LRC's *revised* consolidation
 * (revisedacts.lawreform.ie), not the *as-enacted* text `vatcaIngestion.ts`
 * reads for the principal Act's own sections. Different consolidation,
 * different point-in-time wording, different citation ("2010 Act 31 Sch.2"/
 * "Sch.3", not "2010 Act 31") — so this ingests as its own
 * `irish_knowledge_sources` row per Schedule, never merged into or confused
 * with the principal Act's source (AGENTS.md invariant #6: configuration —
 * and here, which exact wording a rule was extracted from — is superseded,
 * never overwritten or silently conflated).
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
  parseVatcaSchedule, parseScheduleFrontMatter, provisionSlug, assessRelevance,
  VATCA_SCHEDULE_1_MD_PATH, VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH,
} from './vatcaScheduleParser';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { upsertReviewItem } from '../extraction/service';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '@/lib/paths';
import { scheduleParagraphWindows, type ParagraphWindow } from './lrcAnnotations';

/** Schedule 1 (exempt activities) is ingested for the exempt rules in vatScopeCuration.ts (issue #200). */
export type VatcaScheduleNumber = '1' | '2' | '3';

const SCHEDULE_PATHS: Record<VatcaScheduleNumber, string> = {
  '1': VATCA_SCHEDULE_1_MD_PATH, '2': VATCA_SCHEDULE_2_MD_PATH, '3': VATCA_SCHEDULE_3_MD_PATH,
};

/** The Act's own commencement date — see the module docstring on why a
 *  per-paragraph commencement date is not modelled here. */
const VATCA_2010_ENACTED_DATE = '2010-11-01';

const SCHEDULE_SOURCE_TYPE: IrishSourceType = 'legislation';

export { VATCA_SCHEDULE_1_MD_PATH, VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH };

export interface VatcaScheduleIngestResult {
  sourceId: string;
  scheduleNumber: VatcaScheduleNumber;
  paragraphCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest one Schedule's converted Markdown. Idempotent by content, same as `ingestVatca2010`. */
export function ingestVatcaSchedule(
  db: AppDatabase,
  params: {
    companyId?: string | null;
    scheduleNumber: VatcaScheduleNumber;
    markdown: string;
    ingestVersion: string;
    localPath?: string;
  },
): VatcaScheduleIngestResult {
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
      return {
        sourceId: existing.id, scheduleNumber: params.scheduleNumber, paragraphCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: SCHEDULE_SOURCE_TYPE,
      title: fm.title,
      citation: fm.citation,
      jurisdiction: 'IE',
      sourceUrl: fm.sourceUrl,
      localPath: params.localPath ?? SCHEDULE_PATHS[params.scheduleNumber],
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: VATCA_2010_ENACTED_DATE,
      sourceNote: `Ingest ${params.ingestVersion} of ${fm.citation}: the LRC's revised (amendments-to-date) `
        + 'consolidated text, not the as-enacted text `vatcaIngestion.ts` reads for the principal Act\'s own '
        + 'sections — different citation, different source row, never conflated. Per-paragraph/subparagraph '
        + "commencement dates (the source HTML's own \"Amendments:\"/\"Editorial Notes:\" annotations, stripped "
        + 'during extraction as non-statutory editorial commentary) are not modelled; effectiveFrom is the '
        + "Act's own commencement date, not a claim every paragraph's current wording was in force from then.",
      sourceDate: nowIso(),
    }).run();

    const parsed = parseVatcaSchedule(params.markdown);
    const curatedParagraphs = new Set([
      ...VATCA_SCHEDULE_CURATED_RULES
        .filter((r) => r.scheduleNumber === params.scheduleNumber)
        .map((r) => r.sectionNumber),
      ...VAT_SCOPE_CURATED_RULES
        .filter((r) => r.citation === fm.citation)
        .map((r) => r.sectionNumber),
    ]);
    let relevantCount = 0;
    for (const p of parsed) {
      let { relevant, reason } = assessRelevance(p.category);
      if (!relevant && curatedParagraphs.has(p.paragraphNumber)) {
        relevant = true;
        reason = `Curated: mapped to a rule in vatcaScheduleCuration.ts or vatScopeCuration.ts, overriding the ${p.category} category default.`;
      }
      if (relevant) relevantCount++;

      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: p.paragraphNumber,
        part: p.part,
        slug: provisionSlug(`${params.scheduleNumber}-${p.paragraphNumber}`, p.heading),
        heading: p.heading || `Schedule ${params.scheduleNumber} paragraph ${p.paragraphNumber}`,
        principalAct: null,
        provisionText: p.provisionText,
        sourceStart: p.sourceStart,
        sourceEnd: p.sourceEnd,
        category: p.category,
        amendsSection: null,
        effectiveClue: null,
        citedActs: [],
        relevant,
        relevanceReason: reason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }

    return {
      sourceId, scheduleNumber: params.scheduleNumber,
      paragraphCount: parsed.length, relevantCount, ingested: true,
    };
  });
}

export interface VatcaScheduleDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/**
 * Derive `irish_tax_rules` rows from `VATCA_SCHEDULE_CURATED_RULES` for one
 * Schedule. Scoped to that Schedule's own source id — never a bare
 * `sectionNumber` match across sources, for the same reason
 * `deriveVatcaRules` scopes to VATCA_2010's own source id (a paragraph "9"
 * exists independently in Schedule 2 and Schedule 3).
 */
export function deriveVatcaScheduleRules(
  db: AppDatabase,
  params: { companyId: string; scheduleNumber: VatcaScheduleNumber; sourceId?: string },
): VatcaScheduleDeriveResult {
  const citation = `2010 Act 31 Sch.${params.scheduleNumber}`;
  const sourceId = params.sourceId ?? db
    .select({ id: irishKnowledgeSources.id })
    .from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, citation))
    .get()?.id;

  const provisionsQuery = db.select().from(irishActProvisions);
  const provisions = (sourceId
    ? provisionsQuery.where(eq(irishActProvisions.sourceId, sourceId))
    : provisionsQuery
  ).all();

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  // Each paragraph's current text took effect on its latest LRC amendment
  // (issue #205); a rule quoting it is only good from then.
  const windows = sourceId ? paragraphWindowsForSource(db, sourceId, params.scheduleNumber, provisions) : null;

  const curated = VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === params.scheduleNumber);

  for (const rule of curated) {
    const prov = provisions.find((p) => p.sectionNumber === rule.sectionNumber);
    if (!prov) { skippedNoProvision.push(rule.ruleKey); continue; }
    if (!prov.relevant) { skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    const window = windows?.get(rule.sectionNumber);
    const effectiveFrom = window?.effectiveFrom ?? VATCA_2010_ENACTED_DATE;
    const windowNote = window
      ? (window.footnotes.length
        ? `Effective from ${effectiveFrom}, the latest LRC amendment to this paragraph: `
          + `${window.footnotes.map((f) => `${f.ref} ${f.text}`).join(' ')}`
        : `Effective from ${effectiveFrom}: the LRC records no amendment to this paragraph since the Act commenced.`)
      : `Effective from ${effectiveFrom} (the Act's commencement): the LRC HTML with this paragraph's amendment `
        + 'history is not beside the source, so its window could not be read.';

    if (existing) {
      if (existing.statement === rule.statementExcerpt && existing.effectiveFrom === effectiveFrom) { unchanged++; continue; }
      // The earlier row quoted the same text with the wrong window, or different
      // text: it is retired, not re-dated (it never correctly described any period).
      db.update(irishTaxRules)
        .set({ effectiveTo: existing.effectiveFrom, active: false })
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
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: rule.requiresGuidance,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom,
      source: 'derived',
      confidence: 65,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${citation} para.${rule.sectionNumber}; not yet human-reviewed. ${windowNote} `
        + rule.interpretationNote,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rate rule extracted: ${rule.name}`,
      detail: `${citation} para.${rule.sectionNumber}. ${rule.interpretationNote} `
        + 'Review the condition mapping against the source text and approve, or reject, before it '
        + 'is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, scheduleNumber: params.scheduleNumber, paragraphNumber: rule.sectionNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

/**
 * Paragraph windows for an ingested schedule source, read from the LRC HTML
 * kept beside its Markdown (`schedule-3.md` -> `schedule-3.html`). Null when
 * the HTML is not there, or is not the file the Markdown was converted from.
 */
function paragraphWindowsForSource(
  db: AppDatabase, sourceId: string, scheduleNumber: string,
  provisions: Array<typeof irishActProvisions.$inferSelect>,
): Map<string, ParagraphWindow> | null {
  const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get();
  if (!source?.localPath?.endsWith('.md')) return null;
  const mdPath = join(appRoot(), source.localPath);
  const htmlPath = mdPath.replace(/\.md$/, '.html');
  if (!existsSync(htmlPath) || !existsSync(mdPath)) return null;
  const html = readFileSync(htmlPath);
  const recorded = /source_html_sha256:\s*"([0-9a-f]{64})"/.exec(readFileSync(mdPath, 'utf8'))?.[1];
  if (!recorded || sha256Hex(html) !== recorded) return null;
  const paragraphs = provisions
    .filter((p) => p.sourceId === sourceId)
    .sort((a, b) => (a.sourceStart ?? 0) - (b.sourceStart ?? 0))
    .map((p) => p.sectionNumber);
  return scheduleParagraphWindows(html.toString('utf8'), scheduleNumber, paragraphs);
}

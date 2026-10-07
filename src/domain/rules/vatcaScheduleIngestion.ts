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
  parseVatcaSchedule, parseScheduleFrontMatter, provisionSlug, assessRelevance, type ParsedScheduleParagraph,
} from './vatcaScheduleParser';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { upsertReviewItem } from '../extraction/service';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '@/lib/paths';
import { lrcAnnotationLayer, scheduleParagraphWindows, type LrcAnnotationLayer, type ParagraphWindow } from './lrcAnnotations';
import { catalogueEntryForSource, catalogueOfficialFilePath, ingestCatalogueFile } from './catalogue';
import { crossReferencesFromProvision, sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';
import { preferredSourceId } from './catalogueSupersession';

/** Schedule 1 (exempt activities) is ingested for the exempt rules in vatScopeCuration.ts (issue #200). */
export type VatcaScheduleNumber = '1' | '2' | '3';

/** The Act's own commencement date — see the module docstring on why a
 *  per-paragraph commencement date is not modelled here. */
const VATCA_2010_ENACTED_DATE = '2010-11-01';

const SCHEDULE_SOURCE_TYPE: IrishSourceType = 'legislation';

export interface VatcaScheduleIngestResult {
  sourceId: string;
  scheduleNumber: VatcaScheduleNumber;
  paragraphCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Whether a Schedule paragraph bears on the rules, and why: its category's
 * default, unless a curated rule is mapped to it. Shared with the catalogue
 * extraction (scripts/catalogue/extract.ts), so both judge a paragraph alike.
 */
export function vatcaScheduleRelevance(
  scheduleNumber: string, citation: string, p: Pick<ParsedScheduleParagraph, 'paragraphNumber' | 'category'>,
): { relevant: boolean; reason: string } {
  const assessed = assessRelevance(p.category);
  const curated = VATCA_SCHEDULE_CURATED_RULES.some((r) => r.scheduleNumber === scheduleNumber && r.sectionNumber === p.paragraphNumber)
    || VAT_SCOPE_CURATED_RULES.some((r) => r.citation === citation && r.sectionNumber === p.paragraphNumber);
  return !assessed.relevant && curated
    ? { relevant: true, reason: `Curated: mapped to a rule in vatcaScheduleCuration.ts or vatScopeCuration.ts, overriding the ${p.category} category default.` }
    : assessed;
}

/** A Schedule's rules catalogue entry (#556). */
export const vatcaScheduleCatalogueEntry = (scheduleNumber: VatcaScheduleNumber) => `vatca-2010-revised/schedule-${scheduleNumber}.json`;

/** Load a Schedule from the rules catalogue. Idempotent, as `ingestCatalogueEntry` is. */
export function ingestVatcaScheduleFromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; scheduleNumber: VatcaScheduleNumber; ingestVersion?: string; root?: string },
): { sourceId: string; provisionCount: number; ingested: boolean } {
  return ingestCatalogueFile(db, {
    companyId: params.companyId, entry: vatcaScheduleCatalogueEntry(params.scheduleNumber),
    ingestVersion: params.ingestVersion, root: params.root,
  });
}

/** Ingest one Schedule's converted Markdown (a copy given to the CLI). Idempotent by content, same as `ingestVatca2010`. */
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

  const parsed = parseVatcaSchedule(params.markdown);
  const relevance = (p: (typeof parsed)[number]) => vatcaScheduleRelevance(params.scheduleNumber, fm.citation, p);
  const provisionRow = (sourceId: string, p: (typeof parsed)[number]) => {
    const { relevant, reason } = relevance(p);
    return {
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
      source: 'import' as const,
      provenanceStatus: 'imported' as const,
    };
  };

  if (existing) {
    const rows = db.select({ id: irishActProvisions.id, sectionNumber: irishActProvisions.sectionNumber, relevant: irishActProvisions.relevant })
      .from(irishActProvisions).where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      // Same source bytes, but the parser or the curated set may have moved
      // on since it was ingested (issue #205: the unnumbered Sch.3 para 21,
      // and paragraphs newly curated into rules). Add the paragraphs the
      // parser now finds, and mark newly curated ones relevant; stored text
      // is never rewritten.
      db.transaction((tx) => {
        const bySection = new Map(rows.map((r) => [r.sectionNumber, r]));
        for (const p of parsed) {
          const row = bySection.get(p.paragraphNumber);
          if (!row) {
            tx.insert(irishActProvisions).values(provisionRow(existing.id, p)).run();
            continue;
          }
          const { relevant, reason } = relevance(p);
          if (relevant && !row.relevant) {
            tx.update(irishActProvisions).set({ relevant: true, relevanceReason: reason })
              .where(eq(irishActProvisions.id, row.id)).run();
          }
        }
      });
      const now = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
        .where(eq(irishActProvisions.sourceId, existing.id)).all();
      return {
        sourceId: existing.id, scheduleNumber: params.scheduleNumber, paragraphCount: now.length,
        relevantCount: now.filter((r) => r.relevant).length, ingested: false,
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
      localPath: params.localPath ?? null,
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

    let relevantCount = 0;
    for (const p of parsed) {
      const row = provisionRow(sourceId, p);
      if (row.relevant) relevantCount++;
      tx.insert(irishActProvisions).values(row).run();
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
  const sourceId = params.sourceId ?? preferredSourceId(db, citation);

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
      if (existing.statement === rule.statementExcerpt && existing.effectiveFrom === effectiveFrom
        && sameCrossReferences(existing.crossReferences, crossReferencesFromProvision(prov))) { unchanged++; continue; }
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
      taxHeads: taxHeadsFor(rule.ruleKey, rule.topic),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: crossReferencesFromProvision(prov),
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
 * Paragraph windows for an ingested schedule source, read from its LRC page:
 * the one kept beside its rules catalogue entry, or beside its Markdown copy
 * (`lrcHtmlForSource`). Null when neither is there.
 */
function paragraphWindowsForSource(
  db: AppDatabase, sourceId: string, scheduleNumber: string,
  provisions: Array<typeof irishActProvisions.$inferSelect>,
): Map<string, ParagraphWindow> | null {
  const html = lrcHtmlForSource(db, sourceId);
  if (html === null) return null;
  const own = provisions.filter((p) => p.sourceId === sourceId);
  // In the page's order: by offset in a Markdown copy, else as the entry lists them.
  const order = own.every((p) => p.sourceStart !== null) ? null
    : catalogueEntryForSource(db, sourceId)?.entry.provisions.map((p) => p.sectionNumber) ?? null;
  if (order === null && own.some((p) => p.sourceStart === null)) return null;
  const paragraphs = order ?? own.sort((a, b) => a.sourceStart! - b.sourceStart!).map((p) => p.sectionNumber);
  return scheduleParagraphWindows(html, scheduleNumber, paragraphs);
}

/**
 * The LRC revised page an ingested source was read from, when it is still
 * the file recorded for it; else null. For a source in the rules catalogue
 * (or held from a statute copy since ported, #698), the page kept beside its
 * entry; otherwise the HTML kept beside its Markdown copy (`schedule-1.md` ->
 * `schedule-1.html`), with the SHA-256 its front matter records.
 */
export function lrcHtmlForSource(db: AppDatabase, sourceId: string): string | null {
  const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get();
  if (!source?.localPath) return null;
  const copy = copyHtml(source.localPath);
  if (copy !== undefined) return copy;
  const ported = catalogueEntryForSource(db, sourceId);
  if (!ported) return null;
  const path = catalogueOfficialFilePath(ported.name);
  if (!existsSync(path)) return null;
  const html = readFileSync(path);
  return sha256Hex(html) === ported.entry.source.sha256 ? html.toString('utf8') : null;
}

/**
 * The HTML beside a Markdown statute copy, if it is the file the copy was
 * converted from; null if it is not; undefined when the copy is gone.
 */
function copyHtml(localPath: string): string | null | undefined {
  if (!localPath.endsWith('.md')) return undefined;
  const at = localPath.indexOf('docs/statutes/');
  const mdPath = join(appRoot(), at >= 0 ? localPath.slice(at) : localPath);
  if (!existsSync(mdPath)) return undefined;
  const htmlPath = mdPath.replace(/\.md$/, '.html');
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath);
  const recorded = /source_html_sha256:\s*"([0-9a-f]{64})"/.exec(readFileSync(mdPath, 'utf8'))?.[1];
  return recorded && sha256Hex(html) === recorded ? html.toString('utf8') : null;
}

/**
 * The LRC amendment footnotes for an ingested source: from its Markdown
 * copy's HTML while the copy is there, else from its rules catalogue entry
 * (#698: a book that read the copy before the port keeps that source). Null
 * when neither holds them.
 */
export function lrcAnnotationsForSource(db: AppDatabase, sourceId: string): LrcAnnotationLayer | null {
  const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get();
  if (!source?.localPath) return null;
  const copy = copyHtml(source.localPath);
  if (copy !== undefined) return copy === null ? null : lrcAnnotationLayer(copy);
  return catalogueEntryForSource(db, sourceId)?.entry.source.lrcAnnotations ?? null;
}

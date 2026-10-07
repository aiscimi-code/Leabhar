/**
 * Ingestion for sources whose provisions are exact slices of a committed
 * file (payroll, reportable benefits, car emissions): each provision a rule
 * quotes runs from a start marker (its opening words) to an end marker (the
 * next provision's heading, or the end of the file). The offsets are the
 * slice's own, so the provision viewer re-checks it against the file
 * (AGENTS.md #5), and nothing is normalised or paraphrased.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { provisionSlug } from './statuteParser';

export interface ProvisionSlice {
  sectionNumber: string;
  heading: string;
  /** The provision's first words, where the slice begins. */
  start: string;
  /** Where the slice ends (exclusive): the next provision's heading, or null for the end of the file. */
  end: string | null;
  category: 'income_tax' | 'corporation_tax' | 'capital_allowances' | 'usc' | 'procedure';
}

export interface SlicedSource {
  path: string;
  /** Legislation unless stated: a Revenue manual is guidance, ranked below the law it explains. */
  sourceType?: 'legislation' | 'revenue_guidance';
  /** Legislation dated from when it applies; LRC revised text is current law on the day it was retrieved. */
  effectiveFrom: string;
  sourceNote: string;
  provisions: ProvisionSlice[];
}

/**
 * A sliced source ported to the rules catalogue (#556, #717): the entry is the
 * official file's text, sliced where the statute copy was sliced, so its
 * excerpts say the copy's words in the page's layout.
 * `scripts/catalogue/extract.ts` builds the entry from it.
 */
export interface CatalogueSlicedSource {
  /** The entry's name, e.g. `si-345-2018/2018-si-345`. */
  entry: string;
  /** The official file: an irishstatutebook.ie page, or a Revenue manual's PDF. */
  ext: 'html' | 'pdf';
  title: string;
  citation: string;
  sourceUrl: string;
  sourceType: 'legislation' | 'revenue_guidance';
  publicationDate: string | null;
  effectiveFrom: string;
  note: string;
  provisions: Array<ProvisionSlice & { locator: string; relevanceReason: string }>;
}

/** The exact slice of a source file a provision occupies. Throws if a marker is missing: never a guess. */
export function sliceProvision(markdown: string, p: ProvisionSlice): { text: string; start: number; end: number } {
  const start = markdown.indexOf(p.start);
  if (start < 0) throw new Error(`Source: the opening "${p.start}" of provision ${p.sectionNumber} is not in the file.`);
  let end = markdown.length;
  if (p.end !== null) {
    end = markdown.indexOf(p.end, start + p.start.length);
    if (end < 0) throw new Error(`Source: the end marker "${p.end}" of provision ${p.sectionNumber} is not in the file.`);
  }
  const raw = markdown.slice(start, end);
  const trimmed = raw.trimEnd();
  return { text: trimmed, start, end: start + trimmed.length };
}

/** Ingest one sliced source file. Idempotent by content. */
export function ingestSlicedSource(
  db: AppDatabase,
  sources: SlicedSource[],
  relevanceReason: string,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): { sourceId: string; ingested: boolean } {
  const source = sources.find((s) => s.path === params.localPath);
  if (!source) throw new Error(`${params.localPath} is not among these sources.`);
  const fm = parseScheduleFrontMatter(params.markdown);
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, fm.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) return { sourceId: existing.id, ingested: false };
  const slices = source.provisions.map((p) => ({ p, ...sliceProvision(params.markdown, p) }));
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId, companyId: params.companyId ?? null, sourceType: source.sourceType ?? 'legislation', title: fm.title, citation: fm.citation,
      jurisdiction: 'IE', sourceUrl: fm.sourceUrl, localPath: params.localPath, sha256: digest,
      ingestVersion: params.ingestVersion, publicationDate: null, retrievedAt: nowIso(),
      effectiveFrom: source.effectiveFrom, sourceNote: source.sourceNote, sourceDate: nowIso(),
    }).run();
    for (const { p, text, start, end } of slices) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(), companyId: params.companyId ?? null, sourceId, sectionNumber: p.sectionNumber,
        slug: provisionSlug(`${fm.citation}-${p.sectionNumber}`, p.heading), heading: p.heading, principalAct: null,
        provisionText: text, sourceStart: start, sourceEnd: end,
        category: p.category, amendsSection: null, effectiveClue: null, citedActs: [], relevant: true,
        relevanceReason,
        source: 'import', provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, ingested: true };
  });
}


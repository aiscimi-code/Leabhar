/**
 * Generic ingestion for individual TCA 1997 sections (one file per section
 * under docs/statutes/tca-1997/, parsed by `tca1997SectionParser.ts` — see
 * that file's header for why TCA 1997 needs this one-section-per-file shape
 * instead of the whole-Act parsers VATCA/Finance Act 2024 use).
 *
 * `rctIngestion.ts`'s `ingestTca1997S530` predates this and is left as its
 * own hard-coded function (RCT's ingestion has RCT-specific commentary
 * about the pre-2012 compliance mechanics s.530 also defines that doesn't
 * belong in a generic module); this file is for every TCA 1997 section
 * ingested after it, taking any curated-rules list keyed by
 * `{citation, sectionNumber}` rather than one hard-coded section.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, type IrishSourceType } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseTca1997Section, provisionSlug, assessRelevance } from './tca1997SectionParser';

const SOURCE_TYPE: IrishSourceType = 'legislation';

export interface Tca1997IngestResult {
  sourceId: string;
  sectionNumber: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Ingest one TCA 1997 section's Markdown. `curatedSectionNumbers` is the
 * set of section numbers (matching this citation) that some curation file
 * maps to a rule, so a procedural/other-category provision judged not
 * relevant by default is still marked relevant when it is in fact curated
 * — the same override every other ingestion module in this KB applies.
 */
export function ingestTca1997Section(
  db: AppDatabase,
  params: {
    companyId?: string | null;
    markdown: string;
    ingestVersion: string;
    localPath?: string;
    curatedSectionNumbers?: Set<string>;
  },
): Tca1997IngestResult {
  const parsedForCitation = parseTca1997Section(params.markdown);
  const citation = `1997 Act 39 s.${parsedForCitation.sectionNumber}`;
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id, sectionNumber: parsedForCitation.sectionNumber, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    const parsed = parseTca1997Section(params.markdown);
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: SOURCE_TYPE,
      title: `TCA 1997 s.${parsed.sectionNumber}`,
      citation,
      jurisdiction: 'IE',
      sourceUrl: `https://www.irishstatutebook.ie/eli/1997/act/39/section/${parsed.sectionNumber}/enacted/en/html`,
      localPath: params.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: '1997-01-01',
      sourceNote: 'As-enacted 1997 text — no LRC revised TCA exists (docs/statutes/tca-1997/README.md). Any '
        + 'numeric figure (rate, threshold) this section states may have been superseded by a later Finance '
        + 'Act not yet ingested; see the curating rule\'s own interpretationNote for what was, and was not, '
        + 'safe to curate from this text.',
      sourceDate: nowIso(),
    }).run();

    let { relevant, reason } = assessRelevance(parsed.category);
    if (!relevant && params.curatedSectionNumbers?.has(parsed.sectionNumber)) {
      relevant = true;
      reason = `Curated: mapped to a rule, overriding the ${parsed.category} category default.`;
    }

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      chapter: parsed.chapter,
      slug: provisionSlug(parsed.sectionNumber, parsed.heading),
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

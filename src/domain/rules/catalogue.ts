/**
 * The rules catalogue (issue #293, #443, #556; ADR-0020 §6, issue #686 step 10).
 *
 * The rules ship as committed data, one JSON file per source under
 * `catalogue/`, instead of being derived at run time from a copy of the
 * statute in `docs/statutes/`. An entry carries:
 *
 *   - the source: its URL and the SHA-256 of the official file as fetched,
 *     never a local copy of it;
 *   - each provision: its locator (how the source itself points a reader to
 *     it) and the verbatim excerpt the rules quote;
 *   - each rule derived from it: every version with its dates and quote, the
 *     links it states (ruleLinks.ts, supersessions.ts), and its expert review
 *     (who approved it, when, and against which source hash).
 *
 * The extraction script (`npm run catalogue:extract`) writes an entry from the
 * official file: fetch to a temporary directory, convert, parse, then fill in
 * the rules from the curation. Parsing and curation stay developer steps; the
 * app only reads the entry (`ingestCatalogueEntry`). `catalogue.test.ts` fails
 * when an entry no longer matches what the curation derives, so the two
 * cannot drift apart.
 *
 * An approval is the only part written by hand. It holds for one version
 * against one source hash: regenerating an entry keeps an approval only for an
 * unchanged version of an unchanged source.
 *
 * A computation's `consumed_by` links are not here: they describe the code
 * that reads a rule, not the law, and load from the manifests (consumers.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishActProvisions, irishKnowledgeSources, irishTaxRules,
  IRISH_PROVISION_CATEGORIES, IRISH_RULE_LINK_KINDS, IRISH_SOURCE_TYPES,
  type IrishProvisionCategory, type IrishRuleLinkKind, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { appRoot } from '@/lib/paths';
import { declaredLinksFrom } from './ruleLinks';
import type { LrcAnnotationLayer } from './lrcAnnotations';

export const CATALOGUE_DIR = 'catalogue';
export const CATALOGUE_FORMAT = 1;

export interface CatalogueSource {
  citation: string;
  title: string;
  sourceType: IrishSourceType;
  jurisdiction: string;
  sourceUrl: string;
  /** SHA-256 of the official file's bytes as fetched. `verify-sources` compares the file online with it. */
  sha256: string;
  /** How the official file became the excerpts, e.g. `lrc-html-plaintext`. */
  conversion: string;
  /** The day the official file was fetched. Never a provision's or rule's effective date (#216). */
  retrievedOn: string;
  /**
   * An LRC page's amendment footnotes and where they fall in its text, kept
   * so a rule's window can still be read from the footnotes on the words it
   * quotes (`quotedTextWindow`) without the page. Absent for other sources.
   */
  lrcAnnotations?: LrcAnnotationLayer;
}

export interface CatalogueProvision {
  sectionNumber: string;
  heading: string;
  /** How the source points a reader here: `s.46`, `page 12`, `box T1`. */
  locator: string;
  category: IrishProvisionCategory;
  relevant: boolean;
  relevanceReason: string | null;
  /** The provision's own words, as parsed from the official file. */
  excerpt: string;
}

export const CATALOGUE_REVIEW_STATUSES = ['ai_extracted', 'approved', 'rejected'] as const;
export type CatalogueReviewStatus = (typeof CATALOGUE_REVIEW_STATUSES)[number];

export interface CatalogueReview {
  status: CatalogueReviewStatus;
  /** Who approved or rejected the version. Null while `ai_extracted`. */
  by: string | null;
  /** When, as an ISO date. Null while `ai_extracted`. */
  at: string | null;
  /** The source hash the reviewer read. An approval holds only while the source still has it. */
  sourceSha256: string | null;
  note: string | null;
}

export interface CatalogueRuleVersion {
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The rule's verbatim quote from the excerpt. */
  quote: string | null;
  value: number | null;
  unit: string | null;
  review: CatalogueReview;
}

export interface CatalogueLink {
  kind: IrishRuleLinkKind;
  toKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

export interface CatalogueRule {
  key: string;
  sectionNumber: string;
  versions: CatalogueRuleVersion[];
  links: CatalogueLink[];
}

export interface CatalogueEntry {
  format: typeof CATALOGUE_FORMAT;
  source: CatalogueSource;
  provisions: CatalogueProvision[];
  rules: CatalogueRule[];
}

export const UNREVIEWED: CatalogueReview = { status: 'ai_extracted', by: null, at: null, sourceSha256: null, note: null };

/** Every entry the app loads, as a path relative to `catalogue/`. */
export const CATALOGUE_ENTRIES = [
  'vatca-2010-revised/s046.json',
  // The Acts that inserted s.46(1)(cb) for 2020-2023 and moved its end date:
  // the revised s.46 no longer holds that wording (#688).
  'finance-act-2020/s39.json',
  'finance-covid-2021/s6.json',
  'finance-covid-2022/s7.json',
  'finance-act-2023/s5.json',
  'vatca-2010-revised/s047.json',
  'vatca-2010-revised/s009.json',
  'vatca-2010-revised/s010.json',
  'vatca-2010-revised/s030.json',
  'vatca-2010-revised/s035.json',
  'vatca-2010-revised/s080.json',
  'vatca-2010-revised/s097.json',
  'vatca-2010-revised/s043.json',
  'vatca-2010-revised/s060.json',
  'vatca-2010-revised/s061.json',
  'vatca-2010-revised/s062.json',
  'vatca-2010-revised/s066.json',
  'vatca-2010-revised/s067.json',
  'vatca-2010-revised/s069.json',
  'vatca-2010-revised/s070.json',
  'vatca-2010-revised/s086.json',
  'vatca-2010-revised/s087.json',
  'vatca-2010-revised/s088.json',
  'vatca-2010-revised/s089.json',
  'vatca-2010-revised/s002.json',
  'vatca-2010-revised/s003.json',
  'vatca-2010-revised/s037.json',
  'vatca-2010-revised/s045.json',
  'vatca-2010-revised/s076.json',
  'vatca-2010-revised/s92A.json',
  'vatca-2010-revised/s034.json',
  'vatca-2010-revised/s099.json',
  'vatca-2010-revised/s074.json',
  'vatca-2010-revised/s075.json',
  'vatca-2010-revised/s021.json',
  'vatca-2010-revised/s027.json',
  'vatca-2010-revised/s042.json',
  'vatca-2010-revised/s044.json',
  'vatca-2010-revised/s039.json',
  // NTMA (Miscellaneous Provisions) Act 2026 removed the NAMA provisions from
  // these four on 1 August 2026; no rule's dates move (#689).
  'vatca-2010-revised/s016.json',
  'vatca-2010-revised/s059.json',
  'vatca-2010-revised/s064.json',
  'vatca-2010-revised/s094.json',
] as const;

export function catalogueEntryPath(entry: string, root: string = appRoot()): string {
  return join(root, CATALOGUE_DIR, entry);
}

const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Check an entry's shape, so a hand edit that breaks it fails loudly rather than loading half. */
export function validateCatalogueEntry(entry: unknown, label = 'catalogue entry'): CatalogueEntry {
  const fail = (why: string): never => { throw new Error(`${label}: ${why}`); };
  const e = entry as CatalogueEntry;
  if (!e || e.format !== CATALOGUE_FORMAT) fail(`format must be ${CATALOGUE_FORMAT}`);
  const s = e.source;
  if (!s || !s.citation || !s.title || !s.sourceUrl?.startsWith('https://')) fail('source needs a citation, a title and an https URL');
  if (!IRISH_SOURCE_TYPES.includes(s.sourceType)) fail(`unknown source type ${s.sourceType}`);
  if (!/^[0-9a-f]{64}$/.test(s.sha256)) fail('source sha256 must be 64 hex characters');
  if (!isDate(s.retrievedOn)) fail('source retrievedOn must be an ISO date');
  if (s.lrcAnnotations !== undefined
      && (typeof s.lrcAnnotations.text !== 'string' || !Array.isArray(s.lrcAnnotations.footnotes)
        || s.lrcAnnotations.footnotes.some((f) => !/^F\d+$/.test(f.ref) || typeof f.text !== 'string'))) {
    fail('source lrcAnnotations needs a text and a list of footnotes');
  }
  if (!Array.isArray(e.provisions) || e.provisions.length === 0) fail('an entry needs at least one provision');
  const sections = new Set<string>();
  for (const p of e.provisions) {
    if (!p.sectionNumber || !p.locator || !p.excerpt) fail(`provision ${p.sectionNumber} needs a section, a locator and an excerpt`);
    if (!IRISH_PROVISION_CATEGORIES.includes(p.category)) fail(`provision ${p.sectionNumber}: unknown category ${p.category}`);
    if (sections.has(p.sectionNumber)) fail(`provision ${p.sectionNumber} is listed twice`);
    sections.add(p.sectionNumber);
  }
  for (const r of e.rules ?? fail('rules must be a list')) {
    if (!sections.has(r.sectionNumber)) fail(`${r.key} names section ${r.sectionNumber}, which the entry does not hold`);
    for (const v of r.versions) {
      if (!isDate(v.effectiveFrom) || (v.effectiveTo !== null && !isDate(v.effectiveTo))) fail(`${r.key}@${v.version}: bad dates`);
      if (!CATALOGUE_REVIEW_STATUSES.includes(v.review?.status)) fail(`${r.key}@${v.version}: unknown review status`);
      if (v.review.status !== 'ai_extracted' && (!v.review.by || !isDate(v.review.at) || !v.review.sourceSha256)) {
        fail(`${r.key}@${v.version}: a review must say who, when, and against which source hash`);
      }
    }
    for (const l of r.links) if (!IRISH_RULE_LINK_KINDS.includes(l.kind)) fail(`${r.key}: unknown link kind ${l.kind}`);
  }
  return e;
}

export function readCatalogueEntry(entry: string, root?: string): CatalogueEntry {
  return validateCatalogueEntry(JSON.parse(readFileSync(catalogueEntryPath(entry, root), 'utf8')), entry);
}

const normaliseSpace = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface CatalogueIngestResult {
  sourceId: string;
  provisionCount: number;
  ingested: boolean;
}

/**
 * Load one entry's source and provisions into the book's tables, keeping
 * their shapes. Idempotent: a source already held with the same hash, or one
 * already held under the same citation whose provisions say the same words
 * (a book that read the statute copy before the port), is left as it is, so
 * its rules keep pointing at the provision they were derived from.
 */
export function ingestCatalogueEntry(
  db: AppDatabase,
  params: { companyId?: string | null; entry: CatalogueEntry; localPath: string; ingestVersion: string },
): CatalogueIngestResult {
  const { source, provisions } = params.entry;
  const held = db.select({ id: irishKnowledgeSources.id, sha256: irishKnowledgeSources.sha256 })
    .from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, source.citation)).all();
  for (const h of held) {
    const rows = db.select({ sectionNumber: irishActProvisions.sectionNumber, text: irishActProvisions.provisionText })
      .from(irishActProvisions).where(eq(irishActProvisions.sourceId, h.id)).all();
    const same = h.sha256 === source.sha256 || (rows.length === provisions.length && provisions.every((p) =>
      rows.some((r) => r.sectionNumber === p.sectionNumber && normaliseSpace(r.text ?? '') === normaliseSpace(p.excerpt))));
    if (same && rows.length > 0) return { sourceId: h.id, provisionCount: rows.length, ingested: false };
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: source.sourceType,
      title: source.title,
      citation: source.citation,
      jurisdiction: source.jurisdiction,
      sourceUrl: source.sourceUrl,
      localPath: params.localPath,
      sha256: source.sha256,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: `${source.retrievedOn}T00:00:00.000Z`,
      effectiveFrom: source.retrievedOn,
      sourceNote: `Ingest ${params.ingestVersion} of ${source.citation} from the rules catalogue (${params.localPath}); `
        + `${source.conversion} of the official file at ${source.sourceUrl}, SHA-256 ${source.sha256}, `
        + `fetched ${source.retrievedOn}.`,
      sourceDate: `${source.retrievedOn}T00:00:00.000Z`,
    }).run();
    for (const p of provisions) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: p.sectionNumber,
        slug: slug(`${source.citation} ${p.sectionNumber} ${p.heading}`),
        heading: p.heading,
        principalAct: null,
        provisionText: p.excerpt,
        // No local file to slice: the locator says where the words are in the source.
        sourceStart: null,
        sourceEnd: null,
        locator: p.locator,
        category: p.category,
        amendsSection: null,
        effectiveClue: null,
        citedActs: [],
        relevant: p.relevant,
        relevanceReason: p.relevanceReason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, provisionCount: provisions.length, ingested: true };
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

/** Read an entry from `catalogue/` and load it. */
export function ingestCatalogueFile(
  db: AppDatabase,
  params: { companyId?: string | null; entry: string; ingestVersion?: string; root?: string },
): CatalogueIngestResult {
  return ingestCatalogueEntry(db, {
    companyId: params.companyId,
    entry: readCatalogueEntry(params.entry, params.root),
    localPath: `${CATALOGUE_DIR}/${params.entry}`,
    ingestVersion: params.ingestVersion ?? 'v1',
  });
}

/**
 * The rules a book derived from an entry's provisions, in the catalogue's
 * shape: every version in force for some dates, its links, and the review
 * carried over from `previous` for a version that has not changed. The
 * extraction script writes this; the test compares the committed entry with it.
 */
export function catalogueRulesFor(
  db: AppDatabase,
  params: { companyId: string; entry: CatalogueEntry; previous?: CatalogueEntry | null },
): CatalogueRule[] {
  const sources = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, params.entry.source.citation)).all();
  if (sources.length === 0) return [];
  const provisions = db.select({ id: irishActProvisions.id, sectionNumber: irishActProvisions.sectionNumber })
    .from(irishActProvisions).where(inArray(irishActProvisions.sourceId, sources.map((s) => s.id))).all();
  const sectionOf = new Map(provisions.map((p) => [p.id, p.sectionNumber]));
  const rows = provisions.length === 0 ? [] : db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), inArray(irishTaxRules.provisionId, provisions.map((p) => p.id))))
    .all()
    .filter((r) => r.effectiveTo === null || r.effectiveTo > r.effectiveFrom);

  const previous = new Map<string, CatalogueRuleVersion>();
  const previousSha = params.previous?.source.sha256;
  for (const r of params.previous?.rules ?? []) for (const v of r.versions) previous.set(`${r.key}@${v.version}`, v);
  const reviewFor = (key: string, v: Omit<CatalogueRuleVersion, 'review'>): CatalogueReview => {
    const before = previous.get(`${key}@${v.version}`);
    const unchanged = before && previousSha === params.entry.source.sha256
      && before.effectiveFrom === v.effectiveFrom && before.effectiveTo === v.effectiveTo
      && before.quote === v.quote && before.value === v.value && before.unit === v.unit;
    return unchanged ? before.review : UNREVIEWED;
  };

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) byKey.set(r.ruleKey, [...(byKey.get(r.ruleKey) ?? []), r]);
  return [...byKey.keys()].sort().map((key) => {
    const versions = byKey.get(key)!.sort((a, b) => a.ruleVersion - b.ruleVersion);
    return {
      key,
      sectionNumber: sectionOf.get(versions[0]!.provisionId)!,
      versions: versions.map((r) => {
        const v = {
          version: r.ruleVersion, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
          quote: r.statement, value: r.numericValue, unit: r.unit,
        };
        return { ...v, review: reviewFor(key, v) };
      }),
      links: declaredLinksFrom(key)
        .filter((l) => l.kind !== 'consumed_by' && l.toKey !== null)
        .map((l) => ({ kind: l.kind, toKey: l.toKey!, effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo, note: l.note ?? null }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.toKey.localeCompare(b.toKey) || a.effectiveFrom.localeCompare(b.effectiveFrom)),
    };
  });
}

/** An entry as committed: stable key order and a trailing newline, so a regeneration diffs cleanly. */
export function serialiseCatalogueEntry(entry: CatalogueEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

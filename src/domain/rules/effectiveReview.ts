/**
 * The review a book follows for each rule version (ADR-0020 §6, issue #718).
 *
 * The expert review of a rule version ships in the rules catalogue
 * (`catalogue/`), read-only and the same for every book. A book keeps only its
 * own decisions (`irish_rule_decisions`). Every reader of a rule's review
 * status goes through `ruleReviewResolver`: the book's latest decision on the
 * version, when it has one, else the catalogue's review of that version, else
 * the status the row was derived with.
 *
 * A store row is numbered as the catalogue numbers it (ADR-0021 §3), so its
 * catalogue review is found by number. A decision the book took before it
 * moved onto the store recorded the book's own number, and is read through
 * the version map the move wrote (`irish_rule_version_map`), never matched
 * by content. A catalogue approval or rejection holds only while the source
 * the row was read from is the one the reviewer read (the same SHA-256).
 */
import { statSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishRuleDecisions, irishRuleVersionMap } from '@/db/schema';
import { CATALOGUE_ENTRIES, catalogueEntryPath, readCatalogueEntry, type CatalogueReview } from './catalogue';

/** One rule version as the catalogue ships it. */
export interface CatalogueVersionRecord {
  entry: string;
  citation: string;
  sourceSha256: string;
  review: CatalogueReview;
}

/** A catalogued version: its number, dates and quote, and its review. */
export interface CatalogueVersionContent extends CatalogueVersionRecord {
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  quote: string | null;
}

/** The install-level, read-only store: every catalogued rule version, by `key@version`, and the keys each entry holds. */
export interface CatalogueRuleStore {
  versions: ReadonlyMap<string, CatalogueVersionRecord>;
  keys: ReadonlySet<string>;
  contents: ReadonlyMap<string, ReadonlyArray<CatalogueVersionContent>>;
}

const stores = new Map<string, { signature: string; store: CatalogueRuleStore }>();

/**
 * The read-only store, read from the committed catalogue entries. Kept in
 * memory while every entry file is unchanged (size and modification time), so
 * a rewritten entry is never read stale and a lookup per transaction does not
 * re-parse the catalogue.
 */
export function catalogueRuleStore(root?: string): CatalogueRuleStore {
  const signature = CATALOGUE_ENTRIES.map((name) => {
    const s = statSync(catalogueEntryPath(name, root));
    return `${name}:${s.size}:${s.mtimeMs}`;
  }).join('|');
  const cacheKey = root ?? '';
  const cached = stores.get(cacheKey);
  if (cached?.signature === signature) return cached.store;

  const versions = new Map<string, CatalogueVersionRecord>();
  const keys = new Set<string>();
  const contents = new Map<string, CatalogueVersionContent[]>();
  for (const name of CATALOGUE_ENTRIES) {
    const entry = readCatalogueEntry(name, root);
    for (const rule of entry.rules) {
      keys.add(rule.key);
      for (const v of rule.versions) {
        const record = { entry: name, citation: entry.source.citation, sourceSha256: entry.source.sha256, review: v.review };
        contents.set(rule.key, [...(contents.get(rule.key) ?? []),
          { ...record, version: v.version, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo, quote: v.quote }]);
        versions.set(`${rule.key}@${v.version}`, record);
      }
    }
  }
  const store = { versions, keys, contents };
  stores.set(cacheKey, { signature, store });
  return store;
}

/** Where a visible rule row comes from (`visibleTaxRules.origin`): the store, or the book's frozen versions. */
export type RuleOrigin = 'store' | 'retained';

/** What the resolver needs of a visible rule row. */
export interface ReviewedRuleRow {
  ruleKey: string;
  /** The catalogue's number for a store row; the book's own for a retained one. */
  ruleVersion: number;
  origin: RuleOrigin;
  reviewStatus: string;
  /** The SHA-256 of the source the row was read from. */
  sourceSha256: string;
}

export interface RuleReview {
  /** `book`: the book's own latest decision; `catalogue`: the review the catalogue version ships with; `derived`: neither, so the status the row was derived with. */
  from: 'book' | 'catalogue' | 'derived';
  status: string;
  by: string | null;
  at: string | null;
  reason: string | null;
  /** The catalogue version the row is, shown beside a book decision that overrides it. Null for a retained version. */
  catalogue: CatalogueVersionContent | null;
}

/** A visible version, as decisions are grouped by it: `store:key@n` (catalogue number) or `retained:key@n` (book number). */
export function visibleVersionKey(origin: RuleOrigin, ruleKey: string, ruleVersion: number): string {
  return `${origin}:${ruleKey}@${ruleVersion}`;
}

/**
 * The visible version a decision was taken on (ADR-0021 §6). A decision in
 * the catalogue's numbering names a store version. One in the book's
 * numbering was taken before the book moved onto the store, or on a frozen
 * version: it names the store version the book's version was mapped to
 * (`irish_rule_version_map`), else the book's frozen version. Never matched
 * by content: the migration matched once, and the map is what it found.
 */
export function bookVersionMap(db: AppDatabase, companyId: string): ReadonlyMap<string, number> {
  return new Map(db.select().from(irishRuleVersionMap).where(eq(irishRuleVersionMap.companyId, companyId)).all()
    .map((m) => [`${m.ruleKey}@${m.bookVersion}`, m.catalogueVersion]));
}

export function decisionVersionKey(
  decision: Pick<typeof irishRuleDecisions.$inferSelect, 'ruleKey' | 'ruleVersion' | 'numbering'>,
  map: ReadonlyMap<string, number>,
): string {
  if (decision.numbering === 'catalogue') return visibleVersionKey('store', decision.ruleKey, decision.ruleVersion);
  const mapped = map.get(`${decision.ruleKey}@${decision.ruleVersion}`);
  return mapped !== undefined
    ? visibleVersionKey('store', decision.ruleKey, mapped)
    : visibleVersionKey('retained', decision.ruleKey, decision.ruleVersion);
}

/** The catalogue's record of a store version, by its number. */
export function catalogueVersion(store: CatalogueRuleStore, ruleKey: string, ruleVersion: number): CatalogueVersionContent | null {
  return (store.contents.get(ruleKey) ?? []).find((c) => c.version === ruleVersion) ?? null;
}

/**
 * The review each visible rule row follows. Reads the book's decisions, the
 * version map and the catalogue once, so a reader resolving many rows pays
 * for them once.
 */
export function ruleReviewResolver(
  db: AppDatabase,
  params: { companyId: string; root?: string },
): (row: ReviewedRuleRow) => RuleReview {
  const store = catalogueRuleStore(params.root);
  const map = bookVersionMap(db, params.companyId);
  const latest = new Map<string, typeof irishRuleDecisions.$inferSelect>();
  for (const d of db.select().from(irishRuleDecisions).where(eq(irishRuleDecisions.companyId, params.companyId)).all()) {
    const id = decisionVersionKey(d, map);
    const held = latest.get(id);
    if (!held || d.decidedAt > held.decidedAt || (d.decidedAt === held.decidedAt && d.createdAt > held.createdAt)) latest.set(id, d);
  }
  return (row) => {
    // A frozen version is the book's own: the catalogue holds nothing saying the same.
    const catalogue = row.origin === 'store' ? catalogueVersion(store, row.ruleKey, row.ruleVersion) : null;
    const decision = latest.get(visibleVersionKey(row.origin, row.ruleKey, row.ruleVersion));
    if (decision) {
      return { from: 'book', status: decision.status, by: decision.decidedBy, at: decision.decidedAt, reason: decision.reason, catalogue };
    }
    // A catalogue review counts only for the source the reviewer read; an
    // unreviewed catalogue version adds nothing to what the row was derived with.
    const r = catalogue?.review;
    if (catalogue && r && r.status !== 'ai_extracted' && r.sourceSha256 === catalogue.sourceSha256 && row.sourceSha256 === catalogue.sourceSha256) {
      return { from: 'catalogue', status: r.status, by: r.by, at: r.at, reason: r.note, catalogue };
    }
    return { from: 'derived', status: row.reviewStatus, by: null, at: null, reason: null, catalogue };
  };
}

/** A status the book must not take a figure or treatment from: rejected, or retired (superseded) on the review screen. */
export function withdrawn(status: string): boolean {
  return status === 'rejected' || status === 'superseded';
}

/**
 * The review a book follows for each rule version (ADR-0020 §6, issue #718).
 *
 * The expert review of a rule version ships in the rules catalogue
 * (`catalogue/`), read-only and the same for every book. A book keeps only its
 * own decisions (`irish_rule_decisions`). Every reader of a rule's review
 * status goes through `ruleReviewResolver`: the book's latest decision on the
 * version, when it has one, else the catalogue's review of the version that
 * says the same thing, else the status the book's row was derived with.
 *
 * A book numbers its versions as it derives them, so a version is matched to
 * the catalogue's by what it says (dates and quote), never by its number. A
 * catalogue approval or rejection holds only while the source the book read
 * is the one the reviewer read (the same SHA-256).
 */
import { statSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishRuleDecisions } from '@/db/schema';
import { CATALOGUE_ENTRIES, catalogueEntryPath, readCatalogueEntry, type CatalogueReview } from './catalogue';

/** One rule version as the catalogue ships it. */
export interface CatalogueVersionRecord {
  entry: string;
  citation: string;
  sourceSha256: string;
  review: CatalogueReview;
}

/** What a catalogued version says, to recognise a book's copy whatever it numbered it. */
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

/** What the resolver needs of a book's rule row. */
export interface ReviewedRuleRow {
  ruleKey: string;
  ruleVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  statement: string | null;
  reviewStatus: string;
  /** The SHA-256 of the source the row was read from. */
  sourceSha256: string;
}

export interface RuleReview {
  /** `book`: the book's own latest decision; `catalogue`: the review the matching catalogue version ships with; `derived`: neither, so the status the row was derived with. */
  from: 'book' | 'catalogue' | 'derived';
  status: string;
  by: string | null;
  at: string | null;
  reason: string | null;
  /** The catalogue version that says what the row says, shown beside a book decision that overrides it. */
  catalogue: CatalogueVersionContent | null;
}

/** The catalogue version of a key that says what the book's row says (dates and quote), whatever its number. */
export function catalogueVersionFor(store: CatalogueRuleStore, row: Omit<ReviewedRuleRow, 'reviewStatus' | 'sourceSha256'>): CatalogueVersionContent | null {
  return (store.contents.get(row.ruleKey) ?? []).find((c) =>
    c.effectiveFrom === row.effectiveFrom && c.effectiveTo === row.effectiveTo && c.quote === row.statement) ?? null;
}

/**
 * The review each of a book's rule rows follows. Reads the book's decisions
 * and the catalogue once, so a reader resolving many rows pays for both once.
 */
export function ruleReviewResolver(
  db: AppDatabase,
  params: { companyId: string; root?: string },
): (row: ReviewedRuleRow) => RuleReview {
  const store = catalogueRuleStore(params.root);
  const latest = new Map<string, typeof irishRuleDecisions.$inferSelect>();
  for (const d of db.select().from(irishRuleDecisions).where(eq(irishRuleDecisions.companyId, params.companyId)).all()) {
    const id = `${d.ruleKey}@${d.ruleVersion}`;
    const held = latest.get(id);
    if (!held || d.decidedAt > held.decidedAt || (d.decidedAt === held.decidedAt && d.createdAt > held.createdAt)) latest.set(id, d);
  }
  return (row) => {
    const catalogue = catalogueVersionFor(store, row);
    const decision = latest.get(`${row.ruleKey}@${row.ruleVersion}`);
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

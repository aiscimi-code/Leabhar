/**
 * A book's decisions about rule versions, read against the review the rules
 * catalogue ships (ADR-0020 §6, issue #686 step 11).
 *
 * The expert review of a rule version (who approved it, when, against which
 * source hash) is install-level data: it lives in the catalogue entries under
 * `catalogue/`, read-only, and is the same for every book. A book keeps only
 * its own decisions (`irish_rule_decisions`, append-only) and the version IDs
 * it applied. The book's latest decision, when it has one, is what it
 * follows; otherwise the catalogue's review stands.
 *
 * A book that references a version the catalogue lacks is told so as a
 * review item; it never resolves a different version silently (AGENTS.md #7).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoiceLines, irishRuleDecisions, visibleActProvisions, visibleKnowledgeSources, visibleTaxRules, type IrishRuleReviewStatus } from '@/db/schema';
import { newId } from '@/lib/ids';
import { upsertReviewItem } from '../extraction/service';
import type { CatalogueReview } from './catalogue';
import {
  bookVersionMap, catalogueRuleStore, decisionVersionKey, ruleReviewResolver, visibleVersionKey,
  type CatalogueVersionRecord, type RuleOrigin,
} from './effectiveReview';
import { ruleVersionId } from './irishRules';

export { catalogueRuleStore, type CatalogueRuleStore, type CatalogueVersionRecord } from './effectiveReview';

export type RuleDecision = typeof irishRuleDecisions.$inferSelect;

/** Record a book's decision about one rule version. Never edits an earlier one. */
export function recordRuleDecision(
  db: Pick<AppDatabase, 'insert'>,
  params: {
    companyId: string; ruleKey: string; ruleVersion: number; ruleId?: string | null;
    /** Whose number `ruleVersion` is: the catalogue's for a store version, the book's for a frozen one. */
    numbering: 'book' | 'catalogue';
    status: IrishRuleReviewStatus; decidedBy: string; decidedAt: string; reason?: string | null;
  },
): string {
  const id = newId('rd');
  db.insert(irishRuleDecisions).values({
    id, companyId: params.companyId, ruleKey: params.ruleKey, ruleVersion: params.ruleVersion,
    ruleId: params.ruleId ?? null, numbering: params.numbering, status: params.status, decidedBy: params.decidedBy,
    decidedAt: params.decidedAt, reason: params.reason ?? null,
  }).run();
  return id;
}

/**
 * Every decision the book has taken on a visible rule version, latest first:
 * a store version (`origin: 'store'`, the catalogue's number) or one of the
 * book's frozen versions (`'retained'`, the book's own number). A decision
 * taken before the book moved onto the store is read through the version map.
 */
export function ruleDecisionHistory(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; ruleVersion: number; origin?: RuleOrigin },
): RuleDecision[] {
  const map = bookVersionMap(db, params.companyId);
  const wanted = visibleVersionKey(params.origin ?? 'store', params.ruleKey, params.ruleVersion);
  return db.select().from(irishRuleDecisions)
    .where(and(eq(irishRuleDecisions.companyId, params.companyId), eq(irishRuleDecisions.ruleKey, params.ruleKey)))
    // Two decisions can share a millisecond; the table is append-only, so the
    // later insert is the later decision.
    .orderBy(desc(irishRuleDecisions.decidedAt), desc(irishRuleDecisions.createdAt), desc(sql`rowid`))
    .all()
    .filter((d) => decisionVersionKey(d, map) === wanted);
}

export interface EffectiveRuleReview {
  versionId: string;
  /** `book`: the book's own latest decision; `catalogue`: the review the version ships with; `none`: neither holds one. */
  from: 'book' | 'catalogue' | 'none';
  status: IrishRuleReviewStatus | CatalogueReview['status'] | null;
  by: string | null;
  at: string | null;
  reason: string | null;
  /** The catalogue's review, shown beside a book decision that overrides it. */
  catalogue: CatalogueVersionRecord | null;
}

/**
 * The review a book follows for one visible rule version: its own latest
 * decision, else the catalogue's (`ruleReviewResolver`). A store version is
 * named by the catalogue's number, a frozen one (`origin: 'retained'`) by the
 * book's.
 */
export function effectiveRuleReview(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; ruleVersion: number; origin?: RuleOrigin; root?: string },
): EffectiveRuleReview {
  const origin = params.origin ?? 'store';
  const versionId = ruleVersionId(params.ruleKey, params.ruleVersion);
  const row = db.select({
    ruleKey: visibleTaxRules.ruleKey, ruleVersion: visibleTaxRules.ruleVersion, origin: visibleTaxRules.origin,
    reviewStatus: visibleTaxRules.reviewStatus, sourceSha256: visibleKnowledgeSources.sha256,
  }).from(visibleTaxRules)
    .innerJoin(visibleActProvisions, eq(visibleActProvisions.id, visibleTaxRules.provisionId))
    .innerJoin(visibleKnowledgeSources, eq(visibleKnowledgeSources.id, visibleActProvisions.sourceId))
    .where(and(eq(visibleTaxRules.companyId, params.companyId), eq(visibleTaxRules.origin, origin),
      eq(visibleTaxRules.ruleKey, params.ruleKey), eq(visibleTaxRules.ruleVersion, params.ruleVersion)))
    .get();
  const catalogueByNumber = origin === 'store' ? catalogueRuleStore(params.root).versions.get(versionId) ?? null : null;
  if (row) {
    const review = ruleReviewResolver(db, params)(row);
    const catalogue: CatalogueVersionRecord | null = review.catalogue
      ? { entry: review.catalogue.entry, citation: review.catalogue.citation, sourceSha256: review.catalogue.sourceSha256, review: review.catalogue.review }
      : null;
    if (review.from !== 'derived') return { versionId, from: review.from, status: review.status as EffectiveRuleReview['status'], by: review.by, at: review.at, reason: review.reason, catalogue };
    if (catalogue) {
      const r = catalogue.review;
      return { versionId, from: 'catalogue', status: r.status, by: r.by, at: r.at, reason: r.note, catalogue };
    }
    return { versionId, from: 'none', status: null, by: null, at: null, reason: null, catalogue: null };
  }
  const [latest] = ruleDecisionHistory(db, { ...params, origin });
  if (latest) {
    return { versionId, from: 'book', status: latest.status, by: latest.decidedBy, at: latest.decidedAt, reason: latest.reason, catalogue: catalogueByNumber };
  }
  if (catalogueByNumber) {
    const r = catalogueByNumber.review;
    return { versionId, from: 'catalogue', status: r.status, by: r.by, at: r.at, reason: r.note, catalogue: catalogueByNumber };
  }
  return { versionId, from: 'none', status: null, by: null, at: null, reason: null, catalogue: null };
}

export interface MissingCatalogueVersion {
  versionId: string;
  /** Whose number the reference records: the catalogue's, or the book's from before it moved onto the store. */
  numbering: 'book' | 'catalogue';
  /** Where the book references it: a decision it took on it, or an invoice line that applied it. */
  referencedBy: Array<'decision' | 'invoice_line'>;
}

/**
 * The rule versions a book references that the rules store attached to it
 * does not hold (ADR-0021 §5). A reference in the catalogue's numbering names
 * a store version. One in the book's numbering (from before the book moved
 * onto the store) is read through the version map, and is accounted for when
 * the book keeps the version frozen. Each one left is raised as a review
 * item: the book cannot explain the figures it took from a version the store
 * lacks, and it must not quietly read another version instead. A newer store
 * never drops a version (ADR-0021 §3), so this finds a book opened by an
 * older install than the one that last wrote it.
 */
export function checkCatalogueVersions(
  db: AppDatabase,
  params: { companyId: string },
): MissingCatalogueVersion[] {
  const visible = db.select({ ruleKey: visibleTaxRules.ruleKey, ruleVersion: visibleTaxRules.ruleVersion, origin: visibleTaxRules.origin })
    .from(visibleTaxRules).where(eq(visibleTaxRules.companyId, params.companyId)).all();
  const held = new Set(visible.map((r) => visibleVersionKey(r.origin, r.ruleKey, r.ruleVersion)));
  const map = bookVersionMap(db, params.companyId);
  const referenced = new Map<string, { versionId: string; numbering: 'book' | 'catalogue'; by: Set<'decision' | 'invoice_line'> }>();
  const note = (ref: { ruleKey: string; ruleVersion: number; numbering: 'book' | 'catalogue' }, by: 'decision' | 'invoice_line') => {
    if (held.has(decisionVersionKey(ref, map))) return;
    const versionId = ruleVersionId(ref.ruleKey, ref.ruleVersion);
    const at = `${ref.numbering}:${versionId}`;
    const entry = referenced.get(at) ?? { versionId, numbering: ref.numbering, by: new Set() };
    referenced.set(at, { ...entry, by: entry.by.add(by) });
  };
  for (const d of db.select().from(irishRuleDecisions).where(eq(irishRuleDecisions.companyId, params.companyId)).all()) note(d, 'decision');
  const lines = db.select({ versions: invoiceLines.vatRuleVersions, numbering: invoiceLines.vatRuleNumbering }).from(invoiceLines)
    .where(eq(invoiceLines.companyId, params.companyId)).all();
  for (const l of lines) {
    for (const v of l.versions) {
      const at = v.lastIndexOf('@');
      note({ ruleKey: v.slice(0, at), ruleVersion: Number(v.slice(at + 1)), numbering: l.numbering }, 'invoice_line');
    }
  }

  const missing = [...referenced.values()].sort((a, b) => a.versionId.localeCompare(b.versionId) || a.numbering.localeCompare(b.numbering))
    .map((m) => ({ versionId: m.versionId, numbering: m.numbering, referencedBy: [...m.by].sort() }));
  for (const m of missing) {
    const ruleKey = m.versionId.replace(/@\d+$/, '');
    const named = m.numbering === 'book' ? `${m.versionId}, as this book numbered it before it moved onto the rules store,` : m.versionId;
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'other',
      severity: 'warning',
      title: `Rule version ${m.versionId} is not in the rules store`,
      detail: `This book references ${named} (${m.referencedBy.map((b) => (b === 'decision' ? 'a review decision taken on it' : 'an invoice line that applied it')).join(' and ')}), `
        + 'but the rules store installed with this version of Leabhar does not hold it. The book keeps the reference '
        + 'and the figures it recorded; nothing has been switched to another version. Check which version of Leabhar the book was '
        + 'last used with before relying on an explanation of those figures.',
      entityType: 'irish_rule_key',
      entityId: ruleKey,
      dedupeKey: `rule_version_missing:${m.numbering}:${m.versionId}`,
      context: { versionId: m.versionId, numbering: m.numbering, referencedBy: m.referencedBy },
    });
  }
  return missing;
}

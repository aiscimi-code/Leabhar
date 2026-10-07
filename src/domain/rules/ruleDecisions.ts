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
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoiceLines, irishActProvisions, irishKnowledgeSources, irishRuleDecisions, irishTaxRules, type IrishRuleReviewStatus } from '@/db/schema';
import { newId } from '@/lib/ids';
import { upsertReviewItem } from '../extraction/service';
import { CATALOGUE_DIR, type CatalogueReview } from './catalogue';
import { catalogueRuleStore, ruleReviewResolver, type CatalogueVersionRecord } from './effectiveReview';
import { ruleVersionId } from './irishRules';

export { catalogueRuleStore, type CatalogueRuleStore, type CatalogueVersionRecord } from './effectiveReview';

export type RuleDecision = typeof irishRuleDecisions.$inferSelect;

/** Record a book's decision about one rule version. Never edits an earlier one. */
export function recordRuleDecision(
  db: Pick<AppDatabase, 'insert'>,
  params: {
    companyId: string; ruleKey: string; ruleVersion: number; ruleId?: string | null;
    status: IrishRuleReviewStatus; decidedBy: string; decidedAt: string; reason?: string | null;
  },
): string {
  const id = newId('rd');
  db.insert(irishRuleDecisions).values({
    id, companyId: params.companyId, ruleKey: params.ruleKey, ruleVersion: params.ruleVersion,
    ruleId: params.ruleId ?? null, status: params.status, decidedBy: params.decidedBy,
    decidedAt: params.decidedAt, reason: params.reason ?? null,
  }).run();
  return id;
}

/** Every decision the book has taken on a rule version, latest first. */
export function ruleDecisionHistory(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; ruleVersion: number },
): RuleDecision[] {
  return db.select().from(irishRuleDecisions)
    .where(and(
      eq(irishRuleDecisions.companyId, params.companyId),
      eq(irishRuleDecisions.ruleKey, params.ruleKey),
      eq(irishRuleDecisions.ruleVersion, params.ruleVersion),
    ))
    .orderBy(desc(irishRuleDecisions.decidedAt), desc(irishRuleDecisions.createdAt))
    .all();
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
 * The review a book follows for one rule version: its own latest decision,
 * else the catalogue's. A version the book holds is matched to the catalogue's
 * by what it says (`ruleReviewResolver`), since the book may number it
 * differently; one it does not hold is looked up by its number.
 */
export function effectiveRuleReview(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; ruleVersion: number; root?: string },
): EffectiveRuleReview {
  const versionId = ruleVersionId(params.ruleKey, params.ruleVersion);
  const row = db.select({
    ruleKey: irishTaxRules.ruleKey, ruleVersion: irishTaxRules.ruleVersion,
    effectiveFrom: irishTaxRules.effectiveFrom, effectiveTo: irishTaxRules.effectiveTo,
    statement: irishTaxRules.statement, reviewStatus: irishTaxRules.reviewStatus, sourceSha256: irishKnowledgeSources.sha256,
  }).from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishActProvisions.id, irishTaxRules.provisionId))
    .innerJoin(irishKnowledgeSources, eq(irishKnowledgeSources.id, irishActProvisions.sourceId))
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, params.ruleKey), eq(irishTaxRules.ruleVersion, params.ruleVersion)))
    .get();
  const catalogueByNumber = catalogueRuleStore(params.root).versions.get(versionId) ?? null;
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
  const [latest] = ruleDecisionHistory(db, params);
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
  /** Where the book references it: its own rule rows, or an invoice line that applied it. */
  referencedBy: Array<'rule' | 'invoice_line'>;
}

/**
 * The rule versions a book references, for a key the catalogue holds, that
 * the catalogue does not ship. Each is raised as a review item: an entry
 * that dropped a version leaves the book unable to explain the figures it
 * took from it, and the book must not quietly read another version instead.
 */
export function checkCatalogueVersions(
  db: AppDatabase,
  params: { companyId: string; root?: string },
): MissingCatalogueVersion[] {
  const store = catalogueRuleStore(params.root);
  // A key can take versions from more than one source (a later Act amends a
  // rate s.46 set), and only the sources ported to the catalogue ship theirs.
  // So a version is the catalogue's to ship when the book's row for it was
  // read from a catalogue entry, or when the book holds no row for it at all
  // (then only its key and number can be checked).
  const rows = db.select({
    ruleKey: irishTaxRules.ruleKey, ruleVersion: irishTaxRules.ruleVersion,
    effectiveFrom: irishTaxRules.effectiveFrom, effectiveTo: irishTaxRules.effectiveTo,
    statement: irishTaxRules.statement, localPath: irishKnowledgeSources.localPath,
  }).from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishActProvisions.id, irishTaxRules.provisionId))
    .innerJoin(irishKnowledgeSources, eq(irishKnowledgeSources.id, irishActProvisions.sourceId))
    .where(eq(irishTaxRules.companyId, params.companyId)).all();
  const rowFor = new Map(rows.map((r) => [ruleVersionId(r.ruleKey, r.ruleVersion), r]));
  // A book numbers its versions as it derives them: a book that held a
  // version before it was corrected keeps the old one (closed) and numbers
  // the correction 2, where a new book has it as 1. So a book's version is
  // the catalogue's when the catalogue holds a version of that key saying the
  // same thing (dates and quote), whatever its number.
  const shipped = (r: (typeof rows)[number]) => (store.contents.get(r.ruleKey) ?? []).some((c) =>
    c.effectiveFrom === r.effectiveFrom && c.effectiveTo === r.effectiveTo && c.quote === r.statement);
  const referenced = new Map<string, Set<'rule' | 'invoice_line'>>();
  const note = (versionId: string, by: 'rule' | 'invoice_line') => {
    const row = rowFor.get(versionId);
    if (row) {
      if (!row.localPath?.startsWith(`${CATALOGUE_DIR}/`) || shipped(row)) return;
    } else if (store.versions.has(versionId) || !store.keys.has(versionId.replace(/@\d+$/, ''))) {
      return;
    }
    referenced.set(versionId, (referenced.get(versionId) ?? new Set()).add(by));
  };
  for (const r of rows) {
    // A version closed on the day it opened was never in force; the catalogue does not carry it.
    if (r.effectiveTo !== null && r.effectiveTo <= r.effectiveFrom) continue;
    note(ruleVersionId(r.ruleKey, r.ruleVersion), 'rule');
  }
  const lines = db.select({ versions: invoiceLines.vatRuleVersions }).from(invoiceLines)
    .where(eq(invoiceLines.companyId, params.companyId)).all();
  for (const l of lines) for (const v of l.versions) note(v, 'invoice_line');

  const missing = [...referenced].sort(([a], [b]) => a.localeCompare(b))
    .map(([versionId, by]) => ({ versionId, referencedBy: [...by].sort() }));
  for (const m of missing) {
    const ruleKey = m.versionId.replace(/@\d+$/, '');
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'other',
      severity: 'warning',
      title: `Rule version ${m.versionId} is not in the rules catalogue`,
      detail: `This book references ${m.versionId} (${m.referencedBy.map((b) => (b === 'rule' ? 'its own rules' : 'an invoice line that applied it')).join(' and ')}), `
        + 'but the rules catalogue installed with this version of Leabhar does not ship it. The book keeps the version '
        + 'and the figures it recorded; nothing has been switched to another version. Check which catalogue the book was '
        + 'last used with before relying on an explanation of those figures.',
      entityType: 'irish_rule_key',
      entityId: ruleKey,
      dedupeKey: `rule_version_missing:${m.versionId}`,
      context: { versionId: m.versionId, referencedBy: m.referencedBy },
    });
  }
  return missing;
}

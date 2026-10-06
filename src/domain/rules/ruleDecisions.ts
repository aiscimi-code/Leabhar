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
import { CATALOGUE_DIR, CATALOGUE_ENTRIES, readCatalogueEntry, type CatalogueReview } from './catalogue';
import { ruleVersionId } from './irishRules';

/** One rule version as the catalogue ships it. */
export interface CatalogueVersionRecord {
  entry: string;
  citation: string;
  sourceSha256: string;
  review: CatalogueReview;
}

/** The install-level, read-only store: every catalogued rule version, by `key@version`, and the keys each entry holds. */
export interface CatalogueRuleStore {
  versions: ReadonlyMap<string, CatalogueVersionRecord>;
  keys: ReadonlySet<string>;
}

/** The read-only store, read from the committed catalogue entries (a few small files; not cached, so a rewritten entry is never read stale). */
export function catalogueRuleStore(root?: string): CatalogueRuleStore {
  const versions = new Map<string, CatalogueVersionRecord>();
  const keys = new Set<string>();
  for (const name of CATALOGUE_ENTRIES) {
    const entry = readCatalogueEntry(name, root);
    for (const rule of entry.rules) {
      keys.add(rule.key);
      for (const v of rule.versions) {
        versions.set(ruleVersionId(rule.key, v.version), {
          entry: name, citation: entry.source.citation, sourceSha256: entry.source.sha256, review: v.review,
        });
      }
    }
  }
  return { versions, keys };
}

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

/** The review a book follows for one rule version: its own latest decision, else the catalogue's. */
export function effectiveRuleReview(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; ruleVersion: number; root?: string },
): EffectiveRuleReview {
  const versionId = ruleVersionId(params.ruleKey, params.ruleVersion);
  const catalogue = catalogueRuleStore(params.root).versions.get(versionId) ?? null;
  const [latest] = ruleDecisionHistory(db, params);
  if (latest) {
    return { versionId, from: 'book', status: latest.status, by: latest.decidedBy, at: latest.decidedAt, reason: latest.reason, catalogue };
  }
  if (catalogue) {
    const r = catalogue.review;
    return { versionId, from: 'catalogue', status: r.status, by: r.by, at: r.at, reason: r.note, catalogue };
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
  // read from a catalogue entry, or when the book holds no row for it at all.
  const rows = db.select({
    ruleKey: irishTaxRules.ruleKey, ruleVersion: irishTaxRules.ruleVersion,
    effectiveFrom: irishTaxRules.effectiveFrom, effectiveTo: irishTaxRules.effectiveTo,
    localPath: irishKnowledgeSources.localPath,
  }).from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishActProvisions.id, irishTaxRules.provisionId))
    .innerJoin(irishKnowledgeSources, eq(irishKnowledgeSources.id, irishActProvisions.sourceId))
    .where(eq(irishTaxRules.companyId, params.companyId)).all();
  const fromCatalogue = new Map(rows.map((r) => [
    ruleVersionId(r.ruleKey, r.ruleVersion), r.localPath?.startsWith(`${CATALOGUE_DIR}/`) ?? false,
  ]));
  const referenced = new Map<string, Set<'rule' | 'invoice_line'>>();
  const note = (versionId: string, by: 'rule' | 'invoice_line') => {
    if (store.versions.has(versionId)) return;
    if (!(fromCatalogue.get(versionId) ?? store.keys.has(versionId.replace(/@\d+$/, '')))) return;
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

/**
 * Figure resolution for the tax computations (issue #282 / #437).
 *
 * The computations used to read their figures straight from the shipped
 * curation constants, so the stored `irish_tax_rules` rows — the ones with
 * the review lifecycle a person actually works — changed nothing: rejecting
 * `ct.rate_standard` or `usc.band_2pct` left the figure identical.
 *
 * Every figure now goes through here:
 *
 *   stored, in force, approved or active → the stored rule's value, no finding;
 *   stored, in force, unreviewed          → the stored rule's value, identified in the output;
 *   rejected by a person                  → no value: the part that needs it is not computed
 *                                           (issue #451). Income tax and the cash-basis test skip
 *                                           that part; corporation tax, whose figures all feed one
 *                                           computation, stops with a RejectedRuleError;
 *   no stored rule at all                 → no value from the knowledge base; the shipped curation
 *                                           constant is exposed for the caller to fall back on,
 *                                           flagged as unreviewed in this book.
 *
 * The findings this module builds are factual only — what the rule's review
 * state is — and never claim what the caller did about it.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { visibleActProvisions, visibleKnowledgeSources, visibleTaxRules } from '@/db/schema';
import { isIsoDate } from '../dates';
import { lookupTaxRule, ruleVersionId } from './irishRules';
import { ruleReviewResolver } from './effectiveReview';
import type { ManifestRuleKey } from './consumers';

/** A shipped curation constant any figure falls back to. */
export interface CuratedRuleFigure {
  ruleKey: string;
  numericValue: number | null;
  /** Band rules carry their own rate alongside the width (`INCOME_TAX_CURATED_RULES`). */
  rateBasisPoints?: number;
  name?: string;
  /**
   * The constant's own effective window (issue #492): a curation constant is a
   * rule like any other, dated from the Act that set the figure. A fallback
   * that ignores its own window charges a rate that did not apply — 12.5% on
   * a 2002 period, say, because `ct.rate_standard` is curated from 2003-01-01.
   */
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export type RuleFigureStatus = 'approved' | 'unreviewed' | 'rejected' | 'retired' | 'curation_only';

export interface ResolvedRuleFigure {
  ruleKey: string;
  /** The stored rule version the figure came from (`key@version`); null when no stored rule was read. */
  versionId: string | null;
  /**
   * The figure to use from the knowledge base. Null when the rule was
   * rejected (or the as-of date is not a date): the caller then either skips
   * the part or takes `curatedValue`, and says which.
   */
  numericValue: number | null;
  /** The shipped curation constant, always exposed so a caller can fall back on it explicitly. */
  curatedValue: number | null;
  /** A band rule's rate as stored on the rule row's qualifier (`rate_bp:N`), else the curated one. */
  rateBasisPoints: number | null;
  curatedRateBasisPoints: number | null;
  status: RuleFigureStatus;
  reviewStatus: string | null;
  /** False when the shipped curation constant's window does not cover the as-of date (issue #492). */
  curatedInForce: boolean;
  name: string;
  /** One finding per figure, or null when the figure rests on an approved rule. */
  finding: string | null;
}

/**
 * A figure a computation needs was rejected by a person on the rule review
 * screen (issue #451). The computation stops rather than use a figure someone
 * said is wrong: it names the rule so the person can re-derive or restore it.
 */
export class RejectedRuleError extends Error {
  constructor(readonly figure: ResolvedRuleFigure) {
    super(`${figure.finding ?? `Rule ${figure.ruleKey} was rejected.`} The computation that needs it is not produced `
      + 'until the rule is re-derived or restored on the rule review screen.');
    this.name = 'RejectedRuleError';
  }
}

const REJECTED_FINDING_PREFIX = 'was rejected on the rule review screen';

/**
 * The latest store version of a key the book itself withdrew on the review
 * screen: retired (superseded) or rejected (issue #484), told apart so the
 * finding can say which happened. The decision is the book's
 * (`irish_rule_decisions`), read through the review resolver.
 */
function bookWithdrawnRule(db: AppDatabase, companyId: string, ruleKey: string, status: 'superseded' | 'rejected') {
  const rows = storeVersions(db, companyId, ruleKey);
  if (rows.length === 0) return null;
  const review = ruleReviewResolver(db, { companyId });
  for (const row of rows) {
    const r = review(row);
    if (r.from === 'book' && r.status === status) return { row, review: r };
  }
  return null;
}

function storeVersions(db: AppDatabase, companyId: string, ruleKey: string) {
  return db.select({
    name: visibleTaxRules.name, ruleKey: visibleTaxRules.ruleKey, ruleVersion: visibleTaxRules.ruleVersion,
    effectiveFrom: visibleTaxRules.effectiveFrom, effectiveTo: visibleTaxRules.effectiveTo,
    statement: visibleTaxRules.statement, reviewStatus: visibleTaxRules.reviewStatus, origin: visibleTaxRules.origin, sourceSha256: visibleKnowledgeSources.sha256,
  }).from(visibleTaxRules)
    .innerJoin(visibleActProvisions, eq(visibleTaxRules.provisionId, visibleActProvisions.id))
    .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
    .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.origin, 'store'), eq(visibleTaxRules.ruleKey, ruleKey), eq(visibleTaxRules.enabled, true)))
    .orderBy(desc(visibleTaxRules.ruleVersion)).all();
}

/**
 * A rule the rules catalogue rejected, for a version the book holds and has
 * taken no decision on (issue #718): the lookup leaves it out, so the figure
 * is reported rejected, naming who rejected it in the catalogue.
 */
function catalogueRejectedRule(db: AppDatabase, companyId: string, ruleKey: string, asOf: string) {
  const rows = storeVersions(db, companyId, ruleKey);
  if (rows.length === 0) return null;
  const review = ruleReviewResolver(db, { companyId });
  for (const row of rows) {
    // Only the version in force on the date. An older rejected version must not
    // withdraw a later date the catalogue did not reject.
    if (row.effectiveFrom > asOf || (row.effectiveTo !== null && row.effectiveTo <= asOf)) continue;
    const r = review(row);
    if (r.from === 'catalogue' && r.status === 'rejected') return { row, review: r };
  }
  return null;
}

function statusOf(reviewStatus: string): RuleFigureStatus {
  if (reviewStatus === 'approved' || reviewStatus === 'active') return 'approved';
  // Defensive: `superseded` rows are filtered out of the lookup, but if one
  // is ever reached it is retired, never unreviewed (issue #484).
  if (reviewStatus === 'superseded') return 'retired';
  return 'unreviewed';
}

/**
 * Resolve one rule's figure as of a date. `curated` is the shipped curation
 * constant for the same rule key — the fallback this module never applies
 * silently, only exposes.
 */
export function resolveRuleFigure(
  db: AppDatabase,
  params: { companyId: string; ruleKey: ManifestRuleKey; asOfDate: string; curated: CuratedRuleFigure },
): ResolvedRuleFigure {
  const curatedRateBasisPoints = params.curated.rateBasisPoints ?? null;
  const base = {
    ruleKey: params.ruleKey,
    versionId: null as string | null,
    curatedValue: params.curated.numericValue,
    rateBasisPoints: curatedRateBasisPoints,
    curatedRateBasisPoints,
    name: params.curated.name ?? params.ruleKey,
  };
  // The shipped constant's own window (issue #492), the same test a stored
  // rule's effective dates get.
  const curatedInForce = params.curated.effectiveFrom === undefined
    || (params.curated.effectiveFrom <= params.asOfDate
      && (params.curated.effectiveTo == null || params.asOfDate < params.curated.effectiveTo));

  if (!isIsoDate(params.asOfDate)) {
    // Fail closed: an invalid date must not open every in-force version.
    return {
      ...base, numericValue: null, status: 'curation_only', reviewStatus: null, curatedInForce: false,
      finding: `"${base.name}" (${params.ruleKey}) was not read from the knowledge base: "${params.asOfDate}" is not a date.`,
    };
  }

  const stored = lookupTaxRule(db, { companyId: params.companyId, ruleKey: params.ruleKey, asOfDate: params.asOfDate });
  if (stored) {
    const status = statusOf(stored.reviewStatus);
    const rateBasisPoints = /^rate_bp:(\d+)$/.exec(stored.qualifier ?? '')?.[1]
      ? Number(/^rate_bp:(\d+)$/.exec(stored.qualifier!)![1])
      : curatedRateBasisPoints;
    return {
      ...base,
      versionId: ruleVersionId(stored.ruleKey, stored.ruleVersion),
      numericValue: stored.value,
      rateBasisPoints,
      status,
      reviewStatus: stored.reviewStatus,
      curatedInForce,
      name: stored.name || base.name,
      finding: status === 'approved' ? null
        : `The figure for "${stored.name || base.name}" (${params.ruleKey}) rests on a rule no person has reviewed yet `
          + `(status ${stored.reviewStatus}).`,
    };
  }

  // A rule a person retired on the review screen (superseded) supplies no
  // figure either (issue #484): retiring it is the opposite of letting it
  // still stand behind a computation. Distinct from a rejection, so the
  // finding can say which happened.
  const retired = bookWithdrawnRule(db, params.companyId, params.ruleKey, 'superseded');
  if (retired) {
    const { row, review } = retired;
    return {
      ...base, numericValue: null, status: 'retired', reviewStatus: review.status,
      curatedInForce, name: row.name || base.name,
      finding: `Rule "${row.name || base.name}" (${params.ruleKey}) was retired on the rule review screen`
        + `${review.by ? ` by ${review.by}` : ''}${review.reason ? ` (${review.reason})` : ''}: it supplies no figure. `
        + 'Restore it on the review screen, or wait for the corrected rule to be derived.',
    };
  }

  const rejected = bookWithdrawnRule(db, params.companyId, params.ruleKey, 'rejected');
  if (rejected) {
    const { row, review } = rejected;
    return {
      ...base, numericValue: null, status: 'rejected', reviewStatus: review.status,
      curatedInForce, name: row.name || base.name,
      finding: `Rule "${row.name || base.name}" (${params.ruleKey}) ${REJECTED_FINDING_PREFIX}`
        + `${review.by ? ` by ${review.by}` : ''}${review.reason ? ` (${review.reason})` : ''}.`,
    };
  }

  const catalogueRejected = catalogueRejectedRule(db, params.companyId, params.ruleKey, params.asOfDate);
  if (catalogueRejected) {
    const { row, review } = catalogueRejected;
    return {
      ...base, numericValue: null, status: 'rejected', reviewStatus: review.status,
      curatedInForce, name: row.name || base.name,
      finding: `Rule "${row.name || base.name}" (${params.ruleKey}) was rejected in the rules catalogue`
        + `${review.by ? ` by ${review.by}` : ''}${review.reason ? ` (${review.reason})` : ''}.`,
    };
  }

  if (!curatedInForce) {
    // Fail closed outside the constant's own window (issue #492): the
    // curation itself says the figure did not apply on this date.
    const window = `${params.curated.effectiveFrom} to ${params.curated.effectiveTo ?? 'in force'}`;
    return {
      ...base, numericValue: null, status: 'curation_only', reviewStatus: null, curatedInForce: false,
      finding: `No rule "${params.ruleKey}" is stored in this book's statutory knowledge base, and the shipped `
        + `curation constant's own effective window (${window}) does not cover ${params.asOfDate}: `
        + 'there is no figure for that date.',
    };
  }

  return {
    ...base,
    numericValue: params.curated.numericValue,
    status: 'curation_only',
    reviewStatus: null,
    curatedInForce,
    finding: `No rule "${params.ruleKey}" is stored in this book's statutory knowledge base: the figure comes from the `
      + 'shipped curation constant, which no person has reviewed here.',
  };
}

/**
 * Resolve a computation's figures in one call, memoised per rule key, with
 * the findings consolidated so a computation that reads a dozen figures does
 * not emit a dozen near-identical lines.
 *
 * `figure(key)` resolves one figure (memoised); `findings()` returns the
 * consolidated findings for every figure resolved so far — one per rejected
 * rule, one listing the keys that rest on unreviewed rules, one listing the
 * keys the knowledge base does not hold at all. A computation must call
 * `findings()` only after its last `figure()` call.
 */
export function auditRuleFigures(
  db: AppDatabase,
  params: { companyId: string; asOfDate: string; curated: CuratedRuleFigure[] },
): {
  figure: (ruleKey: ManifestRuleKey) => ResolvedRuleFigure;
  findings: () => string[];
  /** The version IDs of every stored rule a figure came from so far, sorted. */
  versions: () => string[];
} {
  const byKey = new Map<string, ResolvedRuleFigure>();
  const figure = (ruleKey: ManifestRuleKey) => {
    const memo = byKey.get(ruleKey);
    if (memo) return memo;
    const curated = params.curated.find((r) => r.ruleKey === ruleKey);
    if (!curated) throw new Error(`No shipped curation constant for rule "${ruleKey}".`);
    const resolved = resolveRuleFigure(db, {
      companyId: params.companyId, ruleKey, asOfDate: params.asOfDate, curated,
    });
    byKey.set(ruleKey, resolved);
    return resolved;
  };
  const findings = () => {
    const out: string[] = [];
    const all = [...byKey.values()];
    for (const f of all.filter((x) => x.status === 'rejected' || x.status === 'retired')) out.push(f.finding!);
    const unreviewed = all.filter((x) => x.status === 'unreviewed');
    if (unreviewed.length) {
      const statuses = [...new Set(unreviewed.map((x) => x.reviewStatus))].join(', ');
      out.push(`These figures rest on rules no person has reviewed yet (status ${statuses}): `
        + `${[...new Set(unreviewed.map((x) => x.ruleKey))].join(', ')}.`);
    }
    const curationOnly = all.filter((x) => x.status === 'curation_only');
    if (curationOnly.length) {
      out.push(`The statutory rules knowledge base holds no rule for: ${curationOnly.map((x) => x.ruleKey).join(', ')}. `
        + 'Those figures come from the shipped curation constants, which no person has reviewed in this book.');
    }
    return out;
  };
  const versions = () => [...new Set([...byKey.values()].flatMap((f) => (f.versionId ? [f.versionId] : [])))].sort();
  return { figure, findings, versions };
}

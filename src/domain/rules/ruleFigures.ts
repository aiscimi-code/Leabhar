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
 *   rejected by a person                  → no value from the knowledge base (the caller decides
 *                                           whether the part is not computed, as the income tax and
 *                                           cash-basis computations do, or whether the shipped
 *                                           curation constant is used as an explicitly flagged
 *                                           fallback, as the corporation tax computation does);
 *   no stored rule at all                 → no value from the knowledge base; the shipped curation
 *                                           constant is exposed for the caller to fall back on,
 *                                           flagged as unreviewed in this book.
 *
 * The findings this module builds are factual only — what the rule's review
 * state is — and never claim what the caller did about it.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules } from '@/db/schema';
import { isIsoDate } from '../dates';
import { lookupTaxRule } from './irishRules';

/** A shipped curation constant any figure falls back to. */
export interface CuratedRuleFigure {
  ruleKey: string;
  numericValue: number | null;
  /** Band rules carry their own rate alongside the width (`INCOME_TAX_CURATED_RULES`). */
  rateBasisPoints?: number;
  name?: string;
}

export type RuleFigureStatus = 'approved' | 'unreviewed' | 'rejected' | 'curation_only';

export interface ResolvedRuleFigure {
  ruleKey: string;
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
  name: string;
  /** One finding per figure, or null when the figure rests on an approved rule. */
  finding: string | null;
}

const REJECTED_FINDING_PREFIX = 'was rejected on the rule review screen';

/** A rejected rule's latest row, so a missing lookup can be told apart from a rejection. */
function rejectedRule(db: AppDatabase, companyId: string, ruleKey: string) {
  return db.select().from(irishTaxRules)
    .where(and(
      eq(irishTaxRules.companyId, companyId),
      eq(irishTaxRules.ruleKey, ruleKey),
      // setRuleReviewStatus('rejected') disables the row; keep both conditions
      // so a rejected row can never be missed by a later change to either column.
      eq(irishTaxRules.reviewStatus, 'rejected'),
    )).orderBy(desc(irishTaxRules.ruleVersion)).get();
}

function statusOf(reviewStatus: string): RuleFigureStatus {
  return reviewStatus === 'approved' || reviewStatus === 'active' ? 'approved' : 'unreviewed';
}

/**
 * Resolve one rule's figure as of a date. `curated` is the shipped curation
 * constant for the same rule key — the fallback this module never applies
 * silently, only exposes.
 */
export function resolveRuleFigure(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string; asOfDate: string; curated: CuratedRuleFigure },
): ResolvedRuleFigure {
  const curatedRateBasisPoints = params.curated.rateBasisPoints ?? null;
  const base = {
    ruleKey: params.ruleKey,
    curatedValue: params.curated.numericValue,
    rateBasisPoints: curatedRateBasisPoints,
    curatedRateBasisPoints,
    name: params.curated.name ?? params.ruleKey,
  };

  if (!isIsoDate(params.asOfDate)) {
    // Fail closed: an invalid date must not open every in-force version.
    return {
      ...base, numericValue: null, status: 'curation_only', reviewStatus: null,
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
      numericValue: stored.value,
      rateBasisPoints,
      status,
      reviewStatus: stored.reviewStatus,
      name: stored.name || base.name,
      finding: status === 'approved' ? null
        : `The figure for "${stored.name || base.name}" (${params.ruleKey}) rests on a rule no person has reviewed yet `
          + `(status ${stored.reviewStatus}).`,
    };
  }

  const rejected = rejectedRule(db, params.companyId, params.ruleKey);
  if (rejected) {
    const who = rejected.reviewedBy ? ` by ${rejected.reviewedBy}` : '';
    return {
      ...base, numericValue: null, status: 'rejected', reviewStatus: rejected.reviewStatus,
      name: rejected.name || base.name,
      finding: `Rule "${rejected.name || base.name}" (${params.ruleKey}) ${REJECTED_FINDING_PREFIX}${who}`
        + `${rejected.reviewNotes ? ` (${rejected.reviewNotes})` : ''}.`,
    };
  }

  return {
    ...base,
    numericValue: params.curated.numericValue,
    status: 'curation_only',
    reviewStatus: null,
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
  figure: (ruleKey: string) => ResolvedRuleFigure;
  findings: () => string[];
} {
  const byKey = new Map<string, ResolvedRuleFigure>();
  const figure = (ruleKey: string) => {
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
    for (const f of all.filter((x) => x.status === 'rejected')) out.push(f.finding!);
    const unreviewed = all.filter((x) => x.status === 'unreviewed');
    if (unreviewed.length) {
      out.push(`These figures rest on rules no person has reviewed yet (status ${unreviewed[0]!.reviewStatus}): `
        + `${[...new Set(unreviewed.map((x) => x.ruleKey))].join(', ')}.`);
    }
    const curationOnly = all.filter((x) => x.status === 'curation_only');
    if (curationOnly.length) {
      out.push(`The statutory rules knowledge base holds no rule for: ${curationOnly.map((x) => x.ruleKey).join(', ')}. `
        + 'Those figures come from the shipped curation constants, which no person has reviewed in this book.');
    }
    return out;
  };
  return { figure, findings };
}

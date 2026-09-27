import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules } from '@/db/schema';

/**
 * Version comparison for the statutory rules (issue #450).
 *
 * Legislative change never edits a historical rule in place: the old row's
 * `effectiveTo` is closed and a new row is inserted with `ruleVersion + 1` and
 * `supersedesRuleId` pointing back (see the `irish_tax_rules` docstring).
 * Until this existed, the chain was stored but unreadable — there was no way
 * to see *what* changed between a superseded rule and its successor.
 *
 * This walks the chain for one `ruleKey`, oldest version first, and diffs each
 * version against its predecessor field by field. Both rows stay in the
 * comparison unchanged: it describes the difference, it never merges or
 * smooths over one (AGENTS.md #6: configuration is effective-dated, never
 * overwritten).
 */

/** The fields diffed between consecutive versions, with how each is shown. */
const DIFF_FIELDS: Array<{ field: string; pick: (r: VersionRow) => unknown }> = [
  { field: 'name', pick: (r) => r.name },
  { field: 'statement', pick: (r) => r.statement },
  { field: 'extractedFact', pick: (r) => r.extractedFact },
  { field: 'numericValue', pick: (r) => (r.numericValue === null ? null : `${r.numericValue} ${r.unit ?? ''}`.trim()) },
  { field: 'qualifier', pick: (r) => r.qualifier },
  { field: 'conditions', pick: (r) => r.conditions },
  { field: 'exceptions', pick: (r) => r.exceptions },
  { field: 'accountingEffect', pick: (r) => r.accountingEffect },
  { field: 'taxEffect', pick: (r) => r.taxEffect },
  { field: 'vatEffect', pick: (r) => r.vatEffect },
  { field: 'reportingEffect', pick: (r) => r.reportingEffect },
  { field: 'effectiveFrom', pick: (r) => r.effectiveFrom },
  { field: 'effectiveTo', pick: (r) => r.effectiveTo },
  { field: 'reviewStatus', pick: (r) => r.reviewStatus },
  { field: 'humanReviewRequired', pick: (r) => r.humanReviewRequired },
  { field: 'requiresGuidance', pick: (r) => r.requiresGuidance },
];

type VersionRow = typeof irishTaxRules.$inferSelect;

export interface RuleVersionChange {
  /** The field that differs between this version and its predecessor. */
  field: string;
  /** The predecessor's value, rendered; null renders as "not stated". */
  from: string;
  /** This version's value, rendered the same way. */
  to: string;
}

export interface RuleVersionEntry {
  ruleId: string;
  ruleVersion: number;
  supersedesRuleId: string | null;
  supersededByRuleId: string | null;
  reviewStatus: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  /** What changed relative to the previous version; empty for the first. */
  changes: RuleVersionChange[];
}

export interface RuleVersionComparison {
  ruleKey: string;
  /** Oldest first, so the chain reads chronologically. */
  versions: RuleVersionEntry[];
}

/** A value as it appears in a diff: JSON for structured fields, "not stated" for null. */
function render(value: unknown): string {
  if (value === null || value === undefined) return 'not stated';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Compare every version of one rule. Returns null when the company has no
 * rule with that key. Versions are found by `ruleKey` (the whole chain shares
 * it) and ordered by `ruleVersion`; `supersedesRuleId` is used to point each
 * entry at its successor for navigation, not to walk, so a chain with a
 * missing link still lists every version the company actually has.
 */
export function compareRuleVersions(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string },
): RuleVersionComparison | null {
  const rows = db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, params.ruleKey)))
    .orderBy(asc(irishTaxRules.ruleVersion))
    .all();

  if (rows.length === 0) return null;

  const versions: RuleVersionEntry[] = rows.map((row, index) => {
    const previous = index > 0 ? rows[index - 1] : null;
    const changes: RuleVersionChange[] = previous
      ? DIFF_FIELDS
        .map(({ field, pick }) => ({ field, from: pick(previous), to: pick(row) }))
        .filter(({ from, to }) => render(from) !== render(to))
        .map(({ field, from, to }) => ({ field, from: render(from), to: render(to) }))
      : [];
    return {
      ruleId: row.id,
      ruleVersion: row.ruleVersion,
      supersedesRuleId: row.supersedesRuleId,
      supersededByRuleId: rows.find((r) => r.supersedesRuleId === row.id)?.id ?? null,
      reviewStatus: row.reviewStatus,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      active: row.active,
      changes,
    };
  });

  return { ruleKey: params.ruleKey, versions };
}

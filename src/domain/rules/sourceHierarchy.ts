import type { IrishSourceType } from '@/db/schema/irishRules';

/**
 * Legal-authority ranking for source types (docs/RULES_KB.md "Source hierarchy").
 *
 * Lower ranks outrank higher ones. Legislation and EU law are primary sources
 * and always rank above guidance that merely explains them; a Revenue eBrief
 * can update how a Tax and Duty Manual applies but never rank above, or
 * silently supersede, legislation. A Leabhar implementation rule (this
 * practice's own coding convention) ranks last: it may fill a gap the other
 * sources leave, but it is never treated as authority for what the law says.
 *
 * This function is the *only* place this ordering is decided — the ranking
 * is never duplicated as a stored column, so there is one place to correct it.
 */
const AUTHORITY_RANK: Record<IrishSourceType, number> = {
  legislation: 1,
  eu_source: 1,
  revenue_guidance: 2,
  revenue_ebrief: 2,
  cro_guidance: 2,
  accounting_standard: 3,
  leabhar_implementation_rule: 4,
};

export function sourceAuthorityRank(sourceType: IrishSourceType): number {
  return AUTHORITY_RANK[sourceType];
}

/** Sort candidates by authority (primary law first), stable on ties. */
export function sortByAuthority<T extends { sourceType: IrishSourceType }>(items: T[]): T[] {
  return [...items].sort((a, b) => sourceAuthorityRank(a.sourceType) - sourceAuthorityRank(b.sourceType));
}

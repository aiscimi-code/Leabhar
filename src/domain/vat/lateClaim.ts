/**
 * The time limit on a late input VAT claim (issue #646).
 *
 * VATCA s.99(4): "A claim for a refund under this Act may be made only within
 * 4 years after the end of the taxable period to which it relates." Input VAT
 * declared in a later period than its own (the late-declaration path, issue
 * #226) is such a claim, and it relates to the period covering its tax point.
 * The claim is made in the return for the period it is declared in, and that
 * return cannot be made before that period ends, so a claim is out of time
 * when the period it is declared in ends after the limit.
 *
 * s.113 is not this limit: it is the window for Revenue's own estimates and
 * assessments under ss.110-111.
 *
 * The taxable period is read as the company's VAT period covering the tax
 * point: the periods the company files for.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { vatPeriods } from '@/db/schema';
import { addYears, asIsoDate, type IsoDate } from '../dates';

// Read here rather than imported from the engine, which calls this module.
const periodCovering = (db: AppDatabase, companyId: string, date: IsoDate) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), lte(vatPeriods.startDate, date), gte(vatPeriods.endDate, date))).get();

export const REFUND_CLAIM_LIMIT_PROVISION = 'VATCA 2010 s.99(4)';
/** Verbatim from `catalogue/vatca-2010-revised/s099.json`. */
export const REFUND_CLAIM_LIMIT_TEXT = 'A claim for a refund under this Act may be made only within 4 years after the end of the '
  + 'taxable period to which it relates.';
export const REFUND_CLAIM_LIMIT_YEARS = 4;

export interface LateClaimLimit {
  /** The VAT period covering the tax point: the period the claim relates to. */
  ownPeriod: { name: string; endDate: string };
  /** The period the claim is declared in. */
  declaredPeriod: { name: string; endDate: string; filingDeadline: string | null };
  /** The last day a claim relating to the own period may be made. */
  limitDate: IsoDate;
  /** True when the declared period ends after the limit: its return cannot make the claim in time. */
  outOfTime: boolean;
  /**
   * Set when the declared period ends in time but its return is due after the
   * limit: the claim stands only if that return is made by the limit.
   */
  fileBy: IsoDate | null;
}

/**
 * The s.99(4) limit for input VAT with tax point `taxPointDate` declared in
 * the period covering `declarationDate`. Null when the claim is not late (the
 * same period) or either period is missing, which the caller's own period
 * checks already refuse.
 */
export function lateClaimLimit(
  db: AppDatabase, companyId: string, taxPointDate: IsoDate, declarationDate: IsoDate,
): LateClaimLimit | null {
  const own = periodCovering(db, companyId, taxPointDate);
  const declared = periodCovering(db, companyId, declarationDate);
  if (!own || !declared || own.id === declared.id) return null;
  const limitDate = addYears(asIsoDate(own.endDate), REFUND_CLAIM_LIMIT_YEARS);
  const outOfTime = declared.endDate > limitDate;
  const fileBy = !outOfTime && declared.filingDeadline !== null && declared.filingDeadline > limitDate ? limitDate : null;
  return {
    ownPeriod: { name: own.name, endDate: own.endDate },
    declaredPeriod: { name: declared.name, endDate: declared.endDate, filingDeadline: declared.filingDeadline },
    limitDate,
    outOfTime,
    fileBy,
  };
}

/** Why a claim is out of time. */
export function lateClaimOutOfTime(limit: LateClaimLimit): string {
  return `This input VAT relates to ${limit.ownPeriod.name} (ended ${limit.ownPeriod.endDate}). A claim for it may be made `
    + `only within ${REFUND_CLAIM_LIMIT_YEARS} years after the end of that period, by ${limit.limitDate} `
    + `(${REFUND_CLAIM_LIMIT_PROVISION}), and the return for ${limit.declaredPeriod.name} cannot be made before `
    + `${limit.declaredPeriod.endDate}.`;
}

/** The warning when the claim is in time only if the declared period's return is made early. */
export function lateClaimFileByReason(limit: LateClaimLimit): string {
  return `This input VAT relates to ${limit.ownPeriod.name}; ${REFUND_CLAIM_LIMIT_PROVISION} allows the claim only until `
    + `${limit.fileBy}. The return for ${limit.declaredPeriod.name} is due ${limit.declaredPeriod.filingDeadline}: `
    + `make it by ${limit.fileBy} or the claim is out of time.`;
}

import { multiplyRational } from '../money';

/**
 * The statutory deduction arithmetic (issue #526), as pure functions of
 * integer minor units. Every rate is in basis points. Nothing here reads the
 * database: the payslip computation resolves the figures and passes them in,
 * so each formula can be tested with exact integers.
 */

const bp = (amount: number, basisPoints: number) => multiplyRational(amount, basisPoints, 10_000);

/**
 * Tax on pay to a cut-off point at the standard rate and the rest at the
 * higher rate, less credits (S.I. 345/2018 reg.11(2)): (A × standard) +
 * (B × higher) − F. Never below zero: credits reduce tax, they are not paid
 * out, and a repayment is limited to tax already deducted (reg.11(4)).
 */
export function taxToCutOff(params: {
  payMinor: number; cutOffMinor: number; creditsMinor: number; standardBp: number; higherBp: number;
}): { atStandardMinor: number; atHigherMinor: number; grossTaxMinor: number; taxMinor: number } {
  const pay = Math.max(0, params.payMinor);
  const atStandard = Math.min(pay, Math.max(0, params.cutOffMinor));
  const atHigher = pay - atStandard;
  const grossTax = bp(atStandard, params.standardBp) + bp(atHigher, params.higherBp);
  return {
    atStandardMinor: atStandard, atHigherMinor: atHigher, grossTaxMinor: grossTax,
    taxMinor: Math.max(0, grossTax - params.creditsMinor),
  };
}

/** A yearly figure's share for the periods to date: yearly × C ÷ D (reg.11(2)(b), (d); S.I. 510/2018 reg.14(2)(b)). */
export function cumulativeShare(yearlyMinor: number, periodsToDate: number, periodsInYear: number): number {
  return multiplyRational(yearlyMinor, periodsToDate, periodsInYear);
}

export interface UscBandShare { rateBasisPoints: number; bandMinor: number | null }

/**
 * USC on pay across bands charged in order (S.I. 510/2018 reg.14(2)(a)):
 * each band takes the pay up to its width, the last (null width) the rest.
 */
export function uscOnBands(payMinor: number, bands: UscBandShare[]): { lines: Array<{ rateBasisPoints: number; payMinor: number; uscMinor: number }>; uscMinor: number } {
  let left = Math.max(0, payMinor);
  const lines: Array<{ rateBasisPoints: number; payMinor: number; uscMinor: number }> = [];
  for (const band of bands) {
    if (left <= 0) break;
    const part = band.bandMinor === null ? left : Math.min(left, band.bandMinor);
    lines.push({ rateBasisPoints: band.rateBasisPoints, payMinor: part, uscMinor: bp(part, band.rateBasisPoints) });
    left -= part;
  }
  return { lines, uscMinor: lines.reduce((s, l) => s + l.uscMinor, 0) };
}

export interface ClassAFigures {
  /** €352: no employee contribution at or below it, per insurable week (s.13(2)(a)). */
  employeeThresholdMinor: number;
  /** €424: the top of the PRSI credit band, per week (s.13(2)(b)). */
  creditUpperMinor: number;
  /** €12: the most the credit can be, per week (s.13(2)(b)(ii)). */
  creditMaxMinor: number;
  employeeRateBp: number;
  /** €552 (2026): the employer's lower rate applies at or below it, per week (s.13(2)(d)). */
  employerThresholdMinor: number;
  employerLowerRateBp: number;
  employerHigherRateBp: number;
  ntfLevyRateBp: number;
}

/**
 * PRSI Class A for one pay period (SWCA 2005 s.13(2); NTF Act 2000 s.4).
 *
 * The statute states each threshold per contribution week, and "the
 * equivalent thereof" for anyone paid otherwise. This engine takes that
 * equivalent as the weekly figure × the insurable weeks in the period
 * (issue #529, awaiting confirmation): 1 for weekly, 2 for fortnightly, and
 * 4 or 5 for monthly, as the person records it.
 *
 * - Employee: nil at or below €352 a week; between €352.01 and €424 the
 *   full-rate contribution less the credit of €12 − (pay − €352.01) ÷ 6;
 *   above €424 the full rate on all of the week's pay.
 * - Employer: the lower rate on all pay at or below €552 a week, the higher
 *   rate on all pay above it; plus the NTF levy on all pay.
 */
export function classAPrsi(reckonableMinor: number, insurableWeeks: number, f: ClassAFigures): {
  employeeMinor: number; creditMinor: number; employerMinor: number; ntfLevyMinor: number; band: 'nil' | 'credit' | 'full';
} {
  const w = insurableWeeks;
  const pay = Math.max(0, reckonableMinor);
  const employer = bp(pay, pay <= f.employerThresholdMinor * w ? f.employerLowerRateBp : f.employerHigherRateBp);
  const ntf = bp(pay, f.ntfLevyRateBp);
  if (pay <= f.employeeThresholdMinor * w) {
    return { employeeMinor: 0, creditMinor: 0, employerMinor: employer, ntfLevyMinor: ntf, band: 'nil' };
  }
  const full = bp(pay, f.employeeRateBp);
  if (pay <= f.creditUpperMinor * w) {
    // €12 − (pay − €352.01) ÷ 6, per week: the credit shrinks by a sixth of each cent over €352.01.
    const floorMinor = (f.employeeThresholdMinor + 1) * w;
    const credit = Math.max(0, multiplyRational(f.creditMaxMinor * w * 6 - (pay - floorMinor), 1, 6));
    return { employeeMinor: Math.max(0, full - credit), creditMinor: credit, employerMinor: employer, ntfLevyMinor: ntf, band: 'credit' };
  }
  return { employeeMinor: full, creditMinor: 0, employerMinor: employer, ntfLevyMinor: ntf, band: 'full' };
}

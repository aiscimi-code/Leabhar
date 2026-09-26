import { multiplyRational } from '../money';
import { addDays, addYears, asIsoDate, makeDate, type IsoDate } from '../dates';

/**
 * The capital goods scheme's arithmetic (VATCA ss.63-64, issue #208). Pure:
 * the same figures back the CLI, the screen and the tests.
 *
 * Proportions are basis points (10000 = 100%). Amounts are integer minor
 * units; every division is done once, on the exact product, and rounded half
 * away from zero. A positive adjustment is payable (as tax due, T1); a
 * negative one increases the tax deductible (T2).
 */

export const FULL_BP = 10_000;

export interface IntervalDates { number: number; start: string; end: string }

/**
 * The adjustment period's intervals (s.63(1)): the initial interval is the 12
 * months from completion (or from the supply to the owner); the second runs to
 * the end of the accounting year in which it begins; each subsequent interval
 * is an accounting year.
 */
export function intervalSchedule(params: {
  initialIntervalStart: string; intervalCount: number; yearEndDay: number; yearEndMonth: number;
}): IntervalDates[] {
  const start = asIsoDate(params.initialIntervalStart);
  const initialEnd = addDays(addYears(start, 1), -1);
  const out: IntervalDates[] = [{ number: 1, start, end: initialEnd }];
  let from: IsoDate = addDays(initialEnd, 1);
  for (let n = 2; n <= params.intervalCount; n += 1) {
    const end = yearEndOnOrAfter(from, params.yearEndDay, params.yearEndMonth);
    out.push({ number: n, start: from, end });
    from = addDays(end, 1);
  }
  return out;
}

function yearEndOnOrAfter(date: IsoDate, day: number, month: number): IsoDate {
  const year = Number(date.slice(0, 4));
  const clamp = (y: number) => makeDate(y, month, Math.min(day, new Date(Date.UTC(y, month, 0)).getUTCDate()));
  const sameYear = clamp(year);
  return sameYear >= date ? sameYear : clamp(year + 1);
}

/** The first day of the taxable period after an interval ends, where its adjustment goes (s.64(2)(b), (3)(b)). */
export const adjustmentDate = (intervalEnd: string): string => addDays(asIsoDate(intervalEnd), 1);

export interface Adjustment { adjustmentMinor: number; provision: 's.64(2)' | 's.64(3)' | 's.64(4)'; working: string; newBaselineBp: number }

const pct = (bp: number) => `${bp / 100}%`;
const eur = (minor: number) => `€${(minor / 100).toFixed(2)}`;

/**
 * End of the initial interval (s.64(2)): A - B, where A is the tax deducted
 * and B the total reviewed deductible amount (total tax x initial proportion).
 */
export function initialIntervalAdjustment(params: {
  totalTaxIncurredMinor: number; deductedMinor: number; initialProportionBp: number;
}): Adjustment {
  const b = multiplyRational(params.totalTaxIncurredMinor, params.initialProportionBp, FULL_BP);
  const adjustment = params.deductedMinor - b;
  return {
    adjustmentMinor: adjustment,
    provision: 's.64(2)',
    newBaselineBp: params.initialProportionBp,
    working: `A (deducted) ${eur(params.deductedMinor)} - B (total reviewed deductible amount: ${eur(params.totalTaxIncurredMinor)} x `
      + `${pct(params.initialProportionBp)}) ${eur(b)} = ${eur(adjustment)}`,
  };
}

/**
 * End of the second or a later interval (s.64(3), (4)): C - D, where C is the
 * reference deduction amount (total tax x baseline / T) and D the interval
 * deductible amount (total tax x interval proportion / T). A swing of more
 * than 50 points multiplies by N, the full intervals left plus one, and the
 * interval's proportion becomes the baseline from then on (s.64(4)(d)).
 */
export function laterIntervalAdjustment(params: {
  totalTaxIncurredMinor: number; intervalCount: number; intervalNumber: number;
  baselineBp: number; intervalProportionBp: number;
}): Adjustment {
  const { totalTaxIncurredMinor: total, intervalCount: t, intervalNumber: k, baselineBp, intervalProportionBp: p } = params;
  const bigSwing = Math.abs(p - baselineBp) > 5_000;
  const n = bigSwing ? t - k + 1 : 1;
  const adjustment = multiplyRational(total, (baselineBp - p) * n, FULL_BP * t);
  const c = multiplyRational(total, baselineBp, FULL_BP * t);
  const d = multiplyRational(total, p, FULL_BP * t);
  return {
    adjustmentMinor: adjustment,
    provision: bigSwing ? 's.64(4)' : 's.64(3)',
    newBaselineBp: bigSwing ? p : baselineBp,
    working: `C (reference deduction amount: ${eur(total)} x ${pct(baselineBp)} / ${t}) ${eur(c)} - D (interval deductible `
      + `amount: ${eur(total)} x ${pct(p)} / ${t}) ${eur(d)}`
      + (bigSwing ? `, x N ${n} (more than 50 points from the baseline; the full intervals left plus one)` : '')
      + ` = ${eur(adjustment)}`,
  };
}

/**
 * A supply of the capital good in the adjustment period (s.64(6)). Taxable:
 * the owner may deduct E x N / T, E being the non-deductible amount. Exempt:
 * the owner pays B x N / T, B being the total reviewed deductible amount. In
 * the initial interval both use the tax actually deducted. N is the full
 * intervals left at the supply plus one.
 */
export function disposalAdjustment(params: {
  totalTaxIncurredMinor: number; deductedMinor: number; intervalCount: number;
  intervalNumber: number; baselineBp: number | null; taxable: boolean;
}): { adjustmentMinor: number; working: string } {
  const { totalTaxIncurredMinor: total, intervalCount: t, intervalNumber: k } = params;
  const n = t - k + 1;
  const inInitial = k === 1 || params.baselineBp === null;
  const reviewed = inInitial ? params.deductedMinor : multiplyRational(total, params.baselineBp!, FULL_BP);
  if (params.taxable) {
    const e = total - reviewed;
    const amount = multiplyRational(e, n, t);
    return { adjustmentMinor: -amount, working: `Taxable supply, s.64(6)(a): E ${eur(e)} x N ${n} / T ${t} = ${eur(amount)} deductible` };
  }
  const amount = multiplyRational(reviewed, n, t);
  return { adjustmentMinor: amount, working: `Exempt supply, s.64(6)(b): B ${eur(reviewed)} x N ${n} / T ${t} = ${eur(amount)} payable` };
}

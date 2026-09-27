import type { PayFrequency } from '@/db/schema';
import { addDays, asIsoDate, endOfMonth, makeDate, parts, type IsoDate } from '../dates';

/**
 * The PAYE pay calendar (issue #526).
 *
 * The total number of pay periods in a year is 52, 26 or 12 (S.I. 345/2018
 * reg.11(3); S.I. 510/2018 reg.14(2)(c)). The income tax week 1 is 1 to 7
 * January, week 2 is 8 to 14 January, and so on; a weekly payment on 31
 * December (30 or 31 December in a leap year) falls in week 53, which
 * reg.15 taxes as if it were paid on 1 January. Fortnight n is weeks 2n−1
 * and 2n; month n is the calendar month ("income tax month" means a calendar
 * month, reg.2(1)).
 */

export const PERIODS_IN_YEAR: Record<PayFrequency, number> = { weekly: 52, fortnightly: 26, monthly: 12 };

function dayOfYear(date: IsoDate): number {
  const { year } = parts(date);
  return Math.round((Date.parse(date) - Date.parse(`${year}-01-01`)) / 86_400_000) + 1;
}

/** The pay period number a pay date falls in: week 1–53, fortnight 1–27, or month 1–12. */
export function periodNumber(frequency: PayFrequency, payDate: IsoDate): number {
  const week = Math.floor((dayOfYear(payDate) - 1) / 7) + 1;
  if (frequency === 'weekly') return week;
  if (frequency === 'fortnightly') return Math.ceil(week / 2);
  return parts(payDate).month;
}

/** Whether a period number is beyond the year's count (week 53, fortnight 27): taxed as if paid on 1 January (reg.15). */
export function isExtraPeriod(frequency: PayFrequency, period: number): boolean {
  return period > PERIODS_IN_YEAR[frequency];
}

/** The calendar dates of a pay period, as the default for a run. */
export function periodDates(frequency: PayFrequency, year: number, period: number): { start: IsoDate; end: IsoDate } {
  if (frequency === 'monthly') {
    const start = makeDate(year, period, 1);
    return { start, end: endOfMonth(start) };
  }
  const weeks = frequency === 'weekly' ? 1 : 2;
  const start = addDays(asIsoDate(`${year}-01-01`), (period - 1) * 7 * weeks);
  const last = addDays(start, 7 * weeks - 1);
  const yearEnd = asIsoDate(`${year}-12-31`);
  return { start, end: last > yearEnd ? yearEnd : last };
}

/** The insurable weeks a weekly or fortnightly period holds; a monthly run's are the person's to give (issue #529). */
export function defaultInsurableWeeks(frequency: PayFrequency): number | null {
  return frequency === 'weekly' ? 1 : frequency === 'fortnightly' ? 2 : null;
}

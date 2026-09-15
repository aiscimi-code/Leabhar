import {
  type IsoDate, makeDate, addMonths, addDays, endOfMonth, parts, asIsoDate, daysBetween,
} from '../dates';

/**
 * Period generators (README §8, §9).
 *
 * These emit explicit date ranges that are then stored as editable rows. The
 * frequency is a convenience for creating them, not a rule the engine applies
 * later — README §8 is explicit that quarterly periods must not be hard-coded,
 * and that the user must be able to define the company's actual periods.
 */

export type VatFrequency =
  | 'monthly' | 'bi_monthly' | 'four_monthly' | 'half_yearly' | 'annual';

const MONTHS_PER_PERIOD: Record<VatFrequency, number> = {
  monthly: 1,
  bi_monthly: 2,
  four_monthly: 4,
  half_yearly: 6,
  annual: 12,
};

export interface GeneratedVatPeriod {
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  filingDeadline: IsoDate;
  frequency: VatFrequency;
}

export interface VatPeriodOptions {
  /**
   * Days after the period end by which the return is due. Configurable rather
   * than hard-coded, per README §35: deadlines differ by filing method and can
   * change, so the application must not assert one as universal.
   */
  filingDeadlineDays?: number;
  /**
   * Some deadlines are expressed as "the Nth day of the following month"
   * instead of a day offset. When set, this takes precedence.
   */
  filingDeadlineDayOfFollowingMonth?: number;
}

/**
 * Generate VAT periods for a calendar year.
 *
 * Irish bi-monthly VAT periods run Jan-Feb, Mar-Apr and so on, i.e. they are
 * anchored to the calendar year rather than to the company's financial year.
 * That anchoring is why VAT periods and accounting periods are separate
 * entities (README §9) rather than one derived from the other.
 */
export function generateVatPeriods(
  year: number,
  frequency: VatFrequency,
  options: VatPeriodOptions = {},
): GeneratedVatPeriod[] {
  const monthsPer = MONTHS_PER_PERIOD[frequency];
  const periods: GeneratedVatPeriod[] = [];

  for (let startMonth = 1; startMonth <= 12; startMonth += monthsPer) {
    const startDate = makeDate(year, startMonth, 1);
    const endMonth = startMonth + monthsPer - 1;
    const endDate = endOfMonth(makeDate(year, endMonth, 1));

    periods.push({
      name: vatPeriodName(year, startMonth, endMonth, frequency),
      startDate,
      endDate,
      filingDeadline: computeFilingDeadline(endDate, options),
      frequency,
    });
  }

  return periods;
}

function computeFilingDeadline(endDate: IsoDate, options: VatPeriodOptions): IsoDate {
  if (options.filingDeadlineDayOfFollowingMonth !== undefined) {
    const next = addMonths(endDate, 1);
    const { year, month } = parts(next);
    const monthEnd = parts(endOfMonth(next)).day;
    return makeDate(year, month, Math.min(options.filingDeadlineDayOfFollowingMonth, monthEnd));
  }
  // Default: the 19th of the following month, the standard non-ROS date.
  // Editable per company, because ROS filers get a later date.
  const next = addMonths(endDate, 1);
  const { year, month } = parts(next);
  return makeDate(year, month, options.filingDeadlineDays ?? 19);
}

const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function vatPeriodName(
  year: number, startMonth: number, endMonth: number, frequency: VatFrequency,
): string {
  if (frequency === 'annual') return `${year} (annual)`;
  if (startMonth === endMonth) return `${MONTH_ABBREV[startMonth - 1]} ${year}`;
  return `${MONTH_ABBREV[startMonth - 1]}–${MONTH_ABBREV[endMonth - 1]} ${year}`;
}

export interface GeneratedAccountingPeriod {
  kind: 'financial_year' | 'month';
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
}

/**
 * Generate a financial year and its constituent months.
 *
 * The year is defined by its end date, which is how Irish companies express it
 * ("year-end 31 December"). A year ending 31 December 2025 starts 1 January
 * 2025; one ending 30 June 2025 starts 1 July 2024.
 */
export function generateFinancialYear(
  yearEndDay: number,
  yearEndMonth: number,
  endYear: number,
): { year: GeneratedAccountingPeriod; months: GeneratedAccountingPeriod[] } {
  const monthEnd = parts(endOfMonth(makeDate(endYear, yearEndMonth, 1))).day;
  const endDate = makeDate(endYear, yearEndMonth, Math.min(yearEndDay, monthEnd));
  const startDate = addDays(addMonths(endDate, -12), 1);

  const isCalendarYear = yearEndMonth === 12 && yearEndDay === 31;
  const name = isCalendarYear
    ? `FY ${endYear}`
    : `FY ${parts(startDate).year}/${endYear}`;

  const months: GeneratedAccountingPeriod[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const monthEndDate = endOfMonth(cursor);
    const periodEnd = monthEndDate > endDate ? endDate : monthEndDate;
    const p = parts(cursor);
    months.push({
      kind: 'month',
      name: `${MONTH_ABBREV[p.month - 1]} ${p.year}`,
      startDate: cursor,
      endDate: periodEnd,
    });
    cursor = addDays(periodEnd, 1);
  }

  return {
    year: { kind: 'financial_year', name, startDate, endDate },
    months,
  };
}

export interface FirstYearOptions {
  /**
   * A first financial year shorter than this is almost certainly not what the
   * company intends — incorporate on 30 December with a 31 December year-end
   * and the literal rule produces a two-day set of accounts. Below this
   * threshold the first period extends to the following year-end instead.
   *
   * Exposed as an option rather than buried in the function because it is a
   * business judgement, not a rule of law: the Companies Act allows a first
   * financial year of up to 18 months, and both a two-day period and a
   * twelve-month one are permissible. The default of 90 days reflects normal
   * practice; a company with a reason to do otherwise can override it.
   */
  minimumFirstPeriodDays?: number;
  /** Statutory maximum length of a first financial year, in months. */
  maximumFirstPeriodMonths?: number;
}

/**
 * The first financial year of a newly incorporated company runs from the date
 * of incorporation to the first year-end, which is usually not twelve months.
 * Treating it as a full year would put pre-incorporation dates inside the books.
 */
export function generateFirstFinancialYear(
  incorporationDate: IsoDate,
  yearEndDay: number,
  yearEndMonth: number,
  options: FirstYearOptions = {},
): GeneratedAccountingPeriod & { warnings: string[] } {
  const minimumDays = options.minimumFirstPeriodDays ?? 90;
  const maximumMonths = options.maximumFirstPeriodMonths ?? 18;
  const warnings: string[] = [];

  const inc = parts(incorporationDate);
  let endYear = inc.year;
  const yearEndFor = (y: number): IsoDate => {
    const monthEnd = parts(endOfMonth(makeDate(y, yearEndMonth, 1))).day;
    return makeDate(y, yearEndMonth, Math.min(yearEndDay, monthEnd));
  };

  let endDate = yearEndFor(endYear);

  // A year-end already past on the incorporation date belongs to the next year.
  if (endDate <= incorporationDate) {
    endYear += 1;
    endDate = yearEndFor(endYear);
  }

  // An implausibly short first period extends to the following year-end.
  if (daysBetween(incorporationDate, endDate) < minimumDays) {
    const extended = yearEndFor(endYear + 1);
    const monthsLong = monthsBetween(incorporationDate, extended);
    if (monthsLong <= maximumMonths) {
      endYear += 1;
      endDate = extended;
      warnings.push(
        `The first year-end after incorporation would have given a financial year of `
          + `under ${minimumDays} days, so it has been extended to ${endDate}. `
          + 'Confirm this matches the period you registered with the CRO.',
      );
    }
  }

  const lengthMonths = monthsBetween(incorporationDate, endDate);
  if (lengthMonths > maximumMonths) {
    warnings.push(
      `This first financial year is about ${lengthMonths} months long, which exceeds `
        + `the ${maximumMonths}-month maximum. Check the year-end date.`,
    );
  }

  return {
    kind: 'financial_year',
    name: `FY ${endYear} (first period)`,
    startDate: incorporationDate,
    endDate,
    warnings,
  };
}

/** Whole months between two dates, used only for length sanity checks. */
function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parts(from), b = parts(to);
  return (b.year - a.year) * 12 + (b.month - a.month) + (b.day >= a.day ? 0 : -1);
}

/** Find the period whose range contains a date. Null means an exception. */
export function findPeriodFor<T extends { startDate: string; endDate: string }>(
  periods: T[],
  date: IsoDate,
): T | null {
  return periods.find((p) => date >= p.startDate && date <= p.endDate) ?? null;
}

/**
 * Detect overlaps and gaps in a set of periods. Both are configuration errors
 * that would otherwise surface as a transaction silently landing in the wrong
 * period, or in none at all.
 */
export function validatePeriodSequence<T extends { name: string; startDate: string; endDate: string }>(
  periods: T[],
): Array<{ kind: 'overlap' | 'gap' | 'inverted'; message: string }> {
  const issues: Array<{ kind: 'overlap' | 'gap' | 'inverted'; message: string }> = [];
  const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));

  for (const period of sorted) {
    if (period.endDate < period.startDate) {
      issues.push({
        kind: 'inverted',
        message: `Period "${period.name}" ends (${period.endDate}) before it starts (${period.startDate}).`,
      });
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.startDate <= previous.endDate) {
      issues.push({
        kind: 'overlap',
        message: `Periods "${previous.name}" and "${current.name}" overlap: `
          + `${previous.name} ends ${previous.endDate}, ${current.name} starts ${current.startDate}.`,
      });
    } else {
      const expected = addDays(asIsoDate(previous.endDate), 1);
      if (current.startDate !== expected) {
        issues.push({
          kind: 'gap',
          message: `Gap between "${previous.name}" (ends ${previous.endDate}) and `
            + `"${current.name}" (starts ${current.startDate}). Transactions dated in `
            + 'the gap would not belong to any period.',
        });
      }
    }
  }

  return issues;
}

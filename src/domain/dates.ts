/**
 * Date primitives.
 *
 * Accounting dates are calendar dates, not instants. A transaction dated
 * 2025-01-31 is on that date in every timezone. Storing them as ISO date
 * strings (YYYY-MM-DD) rather than epoch timestamps removes an entire class of
 * off-by-one-day period-assignment bugs, which in an accounting system means a
 * transaction landing in the wrong VAT period.
 */

export type IsoDate = string & { readonly __brand: 'IsoDate' };

export class DateError extends Error {}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function asIsoDate(value: string): IsoDate {
  const m = ISO_DATE.exec(value.trim());
  if (!m) throw new DateError(`Not an ISO date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12) throw new DateError(`Invalid month in ${value}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new DateError(`Invalid day in ${value}`);
  return value.trim() as IsoDate;
}

export function isIsoDate(value: string): boolean {
  try { asIsoDate(value); return true; } catch { return false; }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function makeDate(year: number, month: number, day: number): IsoDate {
  return asIsoDate(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

export function today(): IsoDate {
  const now = new Date();
  return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function parts(date: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(date)!;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Lexicographic comparison is correct for zero-padded ISO dates. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: IsoDate, b: IsoDate): boolean { return a < b; }
export function isAfter(a: IsoDate, b: IsoDate): boolean { return a > b; }

/** Inclusive on both ends, which is how accounting periods are defined. */
export function isWithin(date: IsoDate, start: IsoDate, end: IsoDate): boolean {
  return date >= start && date <= end;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parts(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return makeDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Clamps to month end: 2025-01-31 + 1 month = 2025-02-28. */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = parts(date);
  const totalMonths = (year * 12) + (month - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  return makeDate(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth)));
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, daysInMonth(year, month));
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parts(a), pb = parts(b);
  const ms = Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day);
  return Math.round(ms / 86_400_000);
}

/** Display form for an Irish audience: 31/01/2025. */
export function formatDateIE(date: IsoDate): string {
  const { year, month, day } = parts(date);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/**
 * Parse a date out of arbitrary text (a CSV cell, an extracted invoice field).
 *
 * `dayFirst` defaults to true because Irish and European bank exports use
 * DD/MM/YYYY. Where the value is genuinely ambiguous (01/02/2025) the caller
 * must decide; this function does not guess silently across formats, it applies
 * the stated convention. Import mapping records which convention was used.
 */
export function parseDateFlexible(input: string, dayFirst = true): IsoDate {
  const text = input.trim();
  if (text === '') throw new DateError('Empty date');

  if (ISO_DATE.test(text)) return asIsoDate(text);

  // ISO datetime — take the date part only.
  const isoDateTime = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(text);
  if (isoDateTime) return asIsoDate(isoDateTime[1]!);

  // Numeric with separators: 31/01/2025, 31-01-2025, 31.01.2025, 31/01/25
  const numeric = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]), b = Number(numeric[2]), c = Number(numeric[3]);
    if (numeric[1]!.length === 4) return makeDate(a, b, c);   // 2025/01/31
    const year = expandYear(c);
    let day = dayFirst ? a : b;
    let month = dayFirst ? b : a;
    // An impossible month under the stated convention means the file uses the
    // other one. Swapping is safe only because the alternative is unambiguous.
    if (month > 12 && day <= 12) { const t = day; day = month; month = t; }
    return makeDate(year, month, day);
  }

  // Textual months: 31 Jan 2025, Jan 31 2025, 31-Jan-25
  const textual = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/,]*(\d{2,4})$/.exec(text);
  if (textual) {
    return makeDate(expandYear(Number(textual[3])), monthFromName(textual[2]!), Number(textual[1]));
  }
  const textualFirst = /^([A-Za-z]{3,})[\s\-/]*(\d{1,2})[\s\-/,]*(\d{2,4})$/.exec(text);
  if (textualFirst) {
    return makeDate(expandYear(Number(textualFirst[3])), monthFromName(textualFirst[1]!), Number(textualFirst[2]));
  }

  // Compact: 20250131
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return makeDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  throw new DateError(`Cannot parse date: ${JSON.stringify(input)}`);
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  // Two-digit years: 70-99 -> 1900s, 00-69 -> 2000s.
  return year >= 70 ? 1900 + year : 2000 + year;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthFromName(name: string): number {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  if (index === -1) throw new DateError(`Unknown month name: ${name}`);
  return index + 1;
}

/** An instant, for audit rows and timestamps. Distinct from a calendar date. */
export function nowIso(): string {
  return new Date().toISOString();
}

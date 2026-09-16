import { describe, it, expect } from 'vitest';
import {
  asIsoDate, makeDate, parseDateFlexible, addDays, addMonths, addYears, endOfMonth,
  startOfMonth, daysBetween, isWithin, formatDateIE, DateError, compareDates,
} from './dates';

describe('asIsoDate', () => {
  it('accepts valid ISO dates', () => {
    expect(asIsoDate('2025-01-31')).toBe('2025-01-31');
    expect(asIsoDate('2024-02-29')).toBe('2024-02-29'); // leap year
  });
  it('rejects impossible dates instead of rolling them over', () => {
    expect(() => asIsoDate('2025-02-29')).toThrow(DateError); // not a leap year
    expect(() => asIsoDate('2025-13-01')).toThrow(DateError);
    expect(() => asIsoDate('2025-04-31')).toThrow(DateError);
    expect(() => asIsoDate('2025-00-10')).toThrow(DateError);
    expect(() => asIsoDate('31/01/2025')).toThrow(DateError);
  });
});

describe('parseDateFlexible', () => {
  it('parses Irish/European day-first formats', () => {
    expect(parseDateFlexible('31/01/2025')).toBe('2025-01-31');
    expect(parseDateFlexible('01-02-2025')).toBe('2025-02-01');
    expect(parseDateFlexible('01.02.2025')).toBe('2025-02-01');
    expect(parseDateFlexible('31/01/25')).toBe('2025-01-31');
  });

  it('parses month-first when told to', () => {
    expect(parseDateFlexible('01/02/2025', false)).toBe('2025-01-02');
    expect(parseDateFlexible('12/31/2025', false)).toBe('2025-12-31');
  });

  it('recovers when the stated convention is impossible', () => {
    // Day-first requested, but 31 cannot be a month.
    expect(parseDateFlexible('01/31/2025', true)).toBe('2025-01-31');
  });

  it('parses ISO and compact forms', () => {
    expect(parseDateFlexible('2025-01-31')).toBe('2025-01-31');
    expect(parseDateFlexible('2025-01-31T14:22:00Z')).toBe('2025-01-31');
    expect(parseDateFlexible('2025-01-31 14:22:00')).toBe('2025-01-31');
    expect(parseDateFlexible('20250131')).toBe('2025-01-31');
    expect(parseDateFlexible('2025/01/31')).toBe('2025-01-31');
  });

  it('parses textual months', () => {
    expect(parseDateFlexible('31 Jan 2025')).toBe('2025-01-31');
    expect(parseDateFlexible('31-Jan-25')).toBe('2025-01-31');
    expect(parseDateFlexible('Jan 31 2025')).toBe('2025-01-31');
    expect(parseDateFlexible('31 January 2025')).toBe('2025-01-31');
    expect(parseDateFlexible('1 December 2025')).toBe('2025-12-01');
  });

  it('expands two-digit years on the 70/69 boundary', () => {
    expect(parseDateFlexible('01/01/69')).toBe('2069-01-01');
    expect(parseDateFlexible('01/01/70')).toBe('1970-01-01');
  });

  it('refuses what it cannot parse', () => {
    expect(() => parseDateFlexible('')).toThrow(DateError);
    expect(() => parseDateFlexible('not a date')).toThrow(DateError);
    expect(() => parseDateFlexible('31/31/2025')).toThrow(DateError);
  });
});

describe('arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays(makeDate(2025, 1, 31), 1)).toBe('2025-02-01');
    expect(addDays(makeDate(2024, 2, 28), 1)).toBe('2024-02-29');
    expect(addDays(makeDate(2025, 12, 31), 1)).toBe('2026-01-01');
    expect(addDays(makeDate(2025, 1, 1), -1)).toBe('2024-12-31');
  });

  it('clamps month addition to the end of the target month', () => {
    expect(addMonths(makeDate(2025, 1, 31), 1)).toBe('2025-02-28');
    expect(addMonths(makeDate(2024, 1, 31), 1)).toBe('2024-02-29');
    expect(addMonths(makeDate(2025, 1, 31), 2)).toBe('2025-03-31');
    expect(addMonths(makeDate(2025, 12, 1), 1)).toBe('2026-01-01');
    expect(addMonths(makeDate(2025, 1, 15), -1)).toBe('2024-12-15');
  });

  it('adds years, handling 29 February', () => {
    expect(addYears(makeDate(2024, 2, 29), 1)).toBe('2025-02-28');
    expect(addYears(makeDate(2025, 6, 30), 1)).toBe('2026-06-30');
  });

  it('finds month boundaries', () => {
    expect(endOfMonth(makeDate(2025, 2, 10))).toBe('2025-02-28');
    expect(endOfMonth(makeDate(2024, 2, 10))).toBe('2024-02-29');
    expect(endOfMonth(makeDate(2025, 12, 1))).toBe('2025-12-31');
    expect(startOfMonth(makeDate(2025, 12, 25))).toBe('2025-12-01');
  });

  it('counts days between dates', () => {
    expect(daysBetween(makeDate(2025, 1, 1), makeDate(2025, 1, 31))).toBe(30);
    expect(daysBetween(makeDate(2025, 1, 31), makeDate(2025, 1, 1))).toBe(-30);
    expect(daysBetween(makeDate(2024, 2, 28), makeDate(2024, 3, 1))).toBe(2);
    // Across a DST transition, which is why these are calendar dates not instants.
    expect(daysBetween(makeDate(2025, 3, 29), makeDate(2025, 3, 31))).toBe(2);
    expect(daysBetween(makeDate(2025, 10, 25), makeDate(2025, 10, 27))).toBe(2);
  });
});

describe('period containment', () => {
  it('is inclusive at both ends', () => {
    const start = makeDate(2025, 1, 1), end = makeDate(2025, 2, 28);
    expect(isWithin(makeDate(2025, 1, 1), start, end)).toBe(true);
    expect(isWithin(makeDate(2025, 2, 28), start, end)).toBe(true);
    expect(isWithin(makeDate(2024, 12, 31), start, end)).toBe(false);
    expect(isWithin(makeDate(2025, 3, 1), start, end)).toBe(false);
  });
  it('sorts lexicographically', () => {
    const dates = [makeDate(2025, 10, 1), makeDate(2025, 2, 1), makeDate(2025, 1, 31)];
    expect([...dates].sort(compareDates)).toEqual(['2025-01-31', '2025-02-01', '2025-10-01']);
  });
});

describe('formatting', () => {
  it('formats for an Irish audience', () => {
    expect(formatDateIE(makeDate(2025, 1, 31))).toBe('31/01/2025');
    expect(formatDateIE(makeDate(2025, 12, 5))).toBe('05/12/2025');
  });
});

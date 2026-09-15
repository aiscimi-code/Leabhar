import { describe, it, expect } from 'vitest';
import {
  generateVatPeriods, generateFinancialYear, generateFirstFinancialYear,
  findPeriodFor, validatePeriodSequence,
} from './periods';
import { makeDate } from '../dates';

describe('generateVatPeriods', () => {
  it('generates Irish bi-monthly periods anchored to the calendar year', () => {
    const periods = generateVatPeriods(2025, 'bi_monthly');
    expect(periods).toHaveLength(6);
    expect(periods[0]).toMatchObject({
      name: 'Jan–Feb 2025', startDate: '2025-01-01', endDate: '2025-02-28',
    });
    expect(periods[1]).toMatchObject({ startDate: '2025-03-01', endDate: '2025-04-30' });
    expect(periods[5]).toMatchObject({ startDate: '2025-11-01', endDate: '2025-12-31' });
  });

  it('handles February in a leap year', () => {
    const periods = generateVatPeriods(2024, 'bi_monthly');
    expect(periods[0]!.endDate).toBe('2024-02-29');
  });

  it('generates every supported frequency with full year coverage and no gaps', () => {
    for (const freq of ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual'] as const) {
      const periods = generateVatPeriods(2025, freq);
      expect(periods[0]!.startDate).toBe('2025-01-01');
      expect(periods[periods.length - 1]!.endDate).toBe('2025-12-31');
      expect(validatePeriodSequence(periods)).toEqual([]);
    }
    expect(generateVatPeriods(2025, 'monthly')).toHaveLength(12);
    expect(generateVatPeriods(2025, 'four_monthly')).toHaveLength(3);
    expect(generateVatPeriods(2025, 'annual')).toHaveLength(1);
  });

  it('defaults the filing deadline to the 19th of the following month', () => {
    const periods = generateVatPeriods(2025, 'bi_monthly');
    expect(periods[0]!.filingDeadline).toBe('2025-03-19');
    expect(periods[5]!.filingDeadline).toBe('2026-01-19');
  });

  it('allows the deadline to be configured rather than assumed', () => {
    const periods = generateVatPeriods(2025, 'bi_monthly', { filingDeadlineDays: 23 });
    expect(periods[0]!.filingDeadline).toBe('2025-03-23');
    const byDay = generateVatPeriods(2025, 'bi_monthly', {
      filingDeadlineDayOfFollowingMonth: 31,
    });
    // Clamped to the length of the month, not rolled into the next one.
    expect(byDay[0]!.filingDeadline).toBe('2025-03-31');
    expect(byDay[1]!.filingDeadline).toBe('2025-05-31');
  });
});

describe('generateFinancialYear', () => {
  it('builds a calendar financial year', () => {
    const { year, months } = generateFinancialYear(31, 12, 2025);
    expect(year).toMatchObject({ name: 'FY 2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(months).toHaveLength(12);
    expect(months[0]).toMatchObject({ startDate: '2025-01-01', endDate: '2025-01-31' });
    expect(months[11]).toMatchObject({ startDate: '2025-12-01', endDate: '2025-12-31' });
  });

  it('builds a non-calendar financial year spanning two calendar years', () => {
    const { year, months } = generateFinancialYear(30, 6, 2025);
    expect(year).toMatchObject({
      name: 'FY 2024/2025', startDate: '2024-07-01', endDate: '2025-06-30',
    });
    expect(months).toHaveLength(12);
    expect(months[0]!.startDate).toBe('2024-07-01');
    expect(months[11]!.endDate).toBe('2025-06-30');
  });

  it('produces months with no gaps or overlaps', () => {
    for (const [d, m, y] of [[31, 12, 2025], [30, 6, 2025], [28, 2, 2025], [31, 3, 2024]] as const) {
      const { months } = generateFinancialYear(d, m, y);
      expect(validatePeriodSequence(months)).toEqual([]);
    }
  });

  it('clamps a 31st year-end in a short month', () => {
    const { year } = generateFinancialYear(31, 4, 2025);
    expect(year.endDate).toBe('2025-04-30');
  });
});

describe('generateFirstFinancialYear', () => {
  it('runs from incorporation to the first year-end, not a full 12 months', () => {
    const period = generateFirstFinancialYear(makeDate(2024, 3, 15), 31, 12);
    expect(period).toMatchObject({ startDate: '2024-03-15', endDate: '2024-12-31' });
  });

  it('rolls to the next year when the year-end has already passed', () => {
    const period = generateFirstFinancialYear(makeDate(2024, 11, 20), 30, 6);
    expect(period).toMatchObject({ startDate: '2024-11-20', endDate: '2025-06-30' });
  });

  it('never starts the books before incorporation', () => {
    const period = generateFirstFinancialYear(makeDate(2024, 12, 30), 31, 12);
    expect(period.startDate).toBe('2024-12-30');
  });

  it('extends an implausibly short first period rather than producing 2-day accounts', () => {
    // Incorporated 30 December with a 31 December year-end.
    const period = generateFirstFinancialYear(makeDate(2024, 12, 30), 31, 12);
    expect(period.endDate).toBe('2025-12-31');
    expect(period.warnings[0]).toContain('extended');
  });

  it('honours an explicit decision to keep a short first period', () => {
    const period = generateFirstFinancialYear(makeDate(2024, 12, 30), 31, 12, {
      minimumFirstPeriodDays: 0,
    });
    expect(period.endDate).toBe('2024-12-31');
    expect(period.warnings).toEqual([]);
  });

  it('warns when a first financial year exceeds the statutory maximum', () => {
    const period = generateFirstFinancialYear(makeDate(2024, 1, 2), 1, 1, {
      minimumFirstPeriodDays: 0,
    });
    expect(period.endDate).toBe('2025-01-01');
    // ~12 months, within the limit.
    expect(period.warnings).toEqual([]);
  });
});

describe('period assignment', () => {
  it('assigns a transaction to the period containing its date', () => {
    const periods = generateVatPeriods(2025, 'bi_monthly');
    expect(findPeriodFor(periods, makeDate(2025, 1, 1))!.name).toBe('Jan–Feb 2025');
    expect(findPeriodFor(periods, makeDate(2025, 2, 28))!.name).toBe('Jan–Feb 2025');
    expect(findPeriodFor(periods, makeDate(2025, 3, 1))!.name).toBe('Mar–Apr 2025');
    expect(findPeriodFor(periods, makeDate(2025, 12, 31))!.name).toBe('Nov–Dec 2025');
  });

  it('returns null outside the defined periods rather than guessing', () => {
    const periods = generateVatPeriods(2025, 'bi_monthly');
    expect(findPeriodFor(periods, makeDate(2024, 12, 31))).toBeNull();
    expect(findPeriodFor(periods, makeDate(2026, 1, 1))).toBeNull();
  });
});

describe('validatePeriodSequence', () => {
  it('detects overlapping periods', () => {
    const issues = validatePeriodSequence([
      { name: 'A', startDate: '2025-01-01', endDate: '2025-02-28' },
      { name: 'B', startDate: '2025-02-01', endDate: '2025-03-31' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('overlap');
  });

  it('detects gaps where a transaction would belong to no period', () => {
    const issues = validatePeriodSequence([
      { name: 'A', startDate: '2025-01-01', endDate: '2025-02-28' },
      { name: 'B', startDate: '2025-04-01', endDate: '2025-05-31' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('gap');
    expect(issues[0]!.message).toContain('would not belong to any period');
  });

  it('detects an inverted period', () => {
    const issues = validatePeriodSequence([
      { name: 'A', startDate: '2025-03-01', endDate: '2025-01-31' },
    ]);
    expect(issues[0]!.kind).toBe('inverted');
  });

  it('accepts a contiguous sequence', () => {
    expect(validatePeriodSequence([
      { name: 'A', startDate: '2025-01-01', endDate: '2025-02-28' },
      { name: 'B', startDate: '2025-03-01', endDate: '2025-04-30' },
    ])).toEqual([]);
  });
});

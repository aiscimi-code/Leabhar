import { describe, it, expect } from 'vitest';
import { classAPrsi, cumulativeShare, taxToCutOff, uscOnBands, type ClassAFigures } from './statutory';
import { isValidPpsn, requireValidPpsn, PpsnError } from './ppsn';
import { periodNumber, periodDates, isExtraPeriod } from './calendar';
import { asIsoDate } from '../dates';

/** SWCA 2005 s.13 from 1 January 2026 (and 1 October 2025's rates). */
const CLASS_A_2026: ClassAFigures = {
  employeeThresholdMinor: 35_200, creditUpperMinor: 42_400, creditMaxMinor: 1_200, employeeRateBp: 420,
  employerThresholdMinor: 55_200, employerLowerRateBp: 800, employerHigherRateBp: 1025, ntfLevyRateBp: 100,
};

describe('PAYE arithmetic (S.I. 345/2018 reg.11)', () => {
  it('taxes a €4,000 month 1 at 20% to the cut-off, 40% above, less credits', () => {
    // €44,000 cut-off and €4,000 credits a year: month 1 is 1/12 of each.
    const srcop = cumulativeShare(4_400_000, 1, 12);
    const credits = cumulativeShare(400_000, 1, 12);
    expect([srcop, credits]).toEqual([366_667, 33_333]);
    expect(taxToCutOff({ payMinor: 400_000, cutOffMinor: srcop, creditsMinor: credits, standardBp: 2000, higherBp: 4000 }))
      .toEqual({ atStandardMinor: 366_667, atHigherMinor: 33_333, grossTaxMinor: 86_666, taxMinor: 53_333 });
  });

  it('never charges less than nothing: credits above the gross tax give zero, not a payment', () => {
    expect(taxToCutOff({ payMinor: 50_000, cutOffMinor: 366_667, creditsMinor: 33_333, standardBp: 2000, higherBp: 4000 }).taxMinor).toBe(0);
  });
});

describe('USC arithmetic (S.I. 510/2018 reg.14)', () => {
  it('charges a €4,000 month 1 across the 2026 bands', () => {
    const bands = [
      { rateBasisPoints: 50, bandMinor: cumulativeShare(1_201_200, 1, 12) },
      { rateBasisPoints: 200, bandMinor: cumulativeShare(1_668_800, 1, 12) },
      { rateBasisPoints: 300, bandMinor: cumulativeShare(4_134_400, 1, 12) },
      { rateBasisPoints: 800, bandMinor: null },
    ];
    const r = uscOnBands(400_000, bands);
    expect(r.lines.map((l) => l.uscMinor)).toEqual([501, 2_781, 4_825]);
    // €48,000 a year: €60.06 + €333.76 + €579.00 = €972.82, a twelfth of which is €81.07.
    expect(r.uscMinor).toBe(8_107);
  });
});

describe('PRSI Class A (SWCA 2005 s.13(2); NTF Act 2000 s.4)', () => {
  it('charges no employee contribution at €352 a week, but the employer\'s is still due', () => {
    expect(classAPrsi(35_200, 1, CLASS_A_2026)).toEqual({ employeeMinor: 0, creditMinor: 0, employerMinor: 2_816, ntfLevyMinor: 352, band: 'nil' });
  });

  it('reduces the contribution by the PRSI credit between €352.01 and €424', () => {
    // €400: 4.2% = €16.80; credit €12 − (€400 − €352.01) ÷ 6 = €4.00; employee €12.80.
    expect(classAPrsi(40_000, 1, CLASS_A_2026)).toEqual({ employeeMinor: 1_280, creditMinor: 400, employerMinor: 3_200, ntfLevyMinor: 400, band: 'credit' });
  });

  it('gives the full credit of €12 at €352.01', () => {
    const r = classAPrsi(35_201, 1, CLASS_A_2026);
    expect([r.creditMinor, r.employeeMinor]).toEqual([1_200, 1_478 - 1_200]);
  });

  it('charges the full rate on all pay above €424, and the employer\'s higher rate on all pay above €552', () => {
    expect(classAPrsi(42_401, 1, CLASS_A_2026).band).toBe('full');
    expect(classAPrsi(60_000, 1, CLASS_A_2026)).toEqual({ employeeMinor: 2_520, creditMinor: 0, employerMinor: 6_150, ntfLevyMinor: 600, band: 'full' });
    expect(classAPrsi(55_200, 1, CLASS_A_2026).employerMinor).toBe(4_416);
    expect(classAPrsi(55_201, 1, CLASS_A_2026).employerMinor).toBe(5_658);
  });

  it('scales the weekly thresholds by the insurable weeks in the period (issue #529)', () => {
    // €2,000 over 4 weeks is €500 a week: full employee rate, employer lower rate.
    expect(classAPrsi(200_000, 4, CLASS_A_2026)).toMatchObject({ employeeMinor: 8_400, employerMinor: 16_000, band: 'full' });
    // €1,600 over 4 weeks is €400 a week: the credit, four times over, rounded once: 4 × €4.0017 = €16.01.
    expect(classAPrsi(160_000, 4, CLASS_A_2026)).toMatchObject({ creditMinor: 1_601, employeeMinor: 6_720 - 1_601 });
  });
});

describe('PPSN (S.I. 345/2018 reg.17(1))', () => {
  it('accepts a number whose check character is right, with or without a second letter', () => {
    expect(['1234567T', '1234567TW', '1234567FA', '1234567 t'].map(isValidPpsn)).toEqual([true, true, true, true]);
  });

  it('refuses a wrong check character or a malformed number, never storing it', () => {
    expect(isValidPpsn('1234567A')).toBe(false);
    expect(() => requireValidPpsn('1234567A')).toThrow(PpsnError);
    expect(() => requireValidPpsn('123456T')).toThrow(/seven digits/);
    expect(requireValidPpsn('1234567-tw')).toBe('1234567TW');
  });
});

describe('the pay calendar (reg.11(3), reg.15)', () => {
  it('numbers weeks from 1 January, fortnights by pairs of weeks, and months by the calendar', () => {
    const d = (s: string) => asIsoDate(s);
    expect([periodNumber('weekly', d('2026-01-07')), periodNumber('weekly', d('2026-01-08')), periodNumber('weekly', d('2026-12-30'))]).toEqual([1, 2, 52]);
    expect(periodNumber('weekly', d('2026-12-31'))).toBe(53);
    expect(periodNumber('weekly', d('2028-12-30'))).toBe(53); // a leap year: 30 December is the 365th day
    expect(isExtraPeriod('weekly', 53)).toBe(true);
    expect([periodNumber('fortnightly', d('2026-01-14')), periodNumber('fortnightly', d('2026-01-15'))]).toEqual([1, 2]);
    expect(periodNumber('monthly', d('2026-03-31'))).toBe(3);
    expect(periodDates('weekly', 2026, 2)).toEqual({ start: '2026-01-08', end: '2026-01-14' });
    expect(periodDates('monthly', 2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});

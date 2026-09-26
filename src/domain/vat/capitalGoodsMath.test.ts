import { describe, it, expect } from 'vitest';
import {
  intervalSchedule, initialIntervalAdjustment, laterIntervalAdjustment, disposalAdjustment, adjustmentDate,
} from './capitalGoodsMath';

/**
 * Issue #208: the capital goods scheme's arithmetic, checked against the
 * worked examples in Revenue's Tax and Duty Manual "VAT - Capital Goods Scheme"
 * (docs/statutes/_inbox/C/immovable-goods/capital-goods-scheme.md).
 */

const EUR = (n: number) => Math.round(n * 100);

describe('intervals (Manual examples 1-3, table 3.1)', () => {
  const s = intervalSchedule({ initialIntervalStart: '2013-09-13', intervalCount: 20, yearEndDay: 31, yearEndMonth: 12 });
  it('initial interval is 12 months; the second runs to the year end; then accounting years', () => {
    expect(s[0]).toEqual({ number: 1, start: '2013-09-13', end: '2014-09-12' });
    expect(s[1]).toEqual({ number: 2, start: '2014-09-13', end: '2014-12-31' });
    expect(s[2]).toEqual({ number: 3, start: '2015-01-01', end: '2015-12-31' });
    expect(s[19]).toEqual({ number: 20, start: '2032-01-01', end: '2032-12-31' });
    expect(s).toHaveLength(20);
  });
  it('a 31 March year end (example 7)', () => {
    const c = intervalSchedule({ initialIntervalStart: '2011-08-21', intervalCount: 20, yearEndDay: 31, yearEndMonth: 3 });
    expect(c[1]).toEqual({ number: 2, start: '2012-08-21', end: '2013-03-31' });
    expect(c[4]!.end).toBe('2016-03-31');
  });
  it('a refurbishment has 10 intervals', () => {
    expect(intervalSchedule({ initialIntervalStart: '2023-07-31', intervalCount: 10, yearEndDay: 31, yearEndMonth: 12 })).toHaveLength(10);
  });
  it('the adjustment goes in the period after the interval', () => {
    expect(adjustmentDate('2015-09-12')).toBe('2015-09-13');
  });
});

describe('end of the initial interval, s.64(2)', () => {
  it('example 4: 100% deducted, 80% use, €270,000 payable', () => {
    const a = initialIntervalAdjustment({ totalTaxIncurredMinor: EUR(1_350_000), deductedMinor: EUR(1_350_000), initialProportionBp: 8_000 });
    expect(a.adjustmentMinor).toBe(EUR(270_000));
    expect(a.provision).toBe('s.64(2)');
  });
  it('example 5: 10% deducted, 20% use, €13,500 deductible', () => {
    const a = initialIntervalAdjustment({ totalTaxIncurredMinor: EUR(135_000), deductedMinor: EUR(13_500), initialProportionBp: 2_000 });
    expect(a.adjustmentMinor).toBe(-EUR(13_500));
  });
});

describe('later intervals, s.64(3) and (4)', () => {
  const base = { totalTaxIncurredMinor: EUR(1_350_000), intervalCount: 20, baselineBp: 8_000 };
  it('example 6: 70% against 80%, €6,750 payable', () => {
    const a = laterIntervalAdjustment({ ...base, intervalNumber: 6, intervalProportionBp: 7_000 });
    expect(a).toMatchObject({ adjustmentMinor: EUR(6_750), provision: 's.64(3)', newBaselineBp: 8_000 });
  });
  it('example 6: 95% against 80%, €10,125 deductible', () => {
    expect(laterIntervalAdjustment({ ...base, intervalNumber: 10, intervalProportionBp: 9_500 }).adjustmentMinor).toBe(-EUR(10_125));
  });
  it('the same use: no adjustment', () => {
    expect(laterIntervalAdjustment({ ...base, intervalNumber: 2, intervalProportionBp: 8_000 }).adjustmentMinor).toBe(0);
  });
  it('example 7: a swing of more than 50 points, x N = 16, €194,400 deductible, baseline reset to 90%', () => {
    const a = laterIntervalAdjustment({ totalTaxIncurredMinor: EUR(405_000), intervalCount: 20, intervalNumber: 5, baselineBp: 3_000, intervalProportionBp: 9_000 });
    expect(a).toMatchObject({ adjustmentMinor: -EUR(194_400), provision: 's.64(4)', newBaselineBp: 9_000 });
  });
  it('exactly 50 points is not a big swing', () => {
    expect(laterIntervalAdjustment({ ...base, intervalNumber: 5, baselineBp: 8_000, intervalProportionBp: 3_000 }).provision).toBe('s.64(3)');
  });
});

describe('a supply of the good, s.64(6)', () => {
  it('example 8: taxable supply in the 7th interval, E x 14 / 20 = €401,625 deductible', () => {
    const a = disposalAdjustment({
      totalTaxIncurredMinor: EUR(675_000), deductedMinor: EUR(101_250), intervalCount: 20, intervalNumber: 7, baselineBp: 1_500, taxable: true,
    });
    expect(a.adjustmentMinor).toBe(-EUR(401_625));
  });
  it('example 9: exempt supply in the 4th interval, B x 17 / 20 = €344,250 payable', () => {
    const a = disposalAdjustment({
      totalTaxIncurredMinor: EUR(405_000), deductedMinor: EUR(405_000), intervalCount: 20, intervalNumber: 4, baselineBp: 10_000, taxable: false,
    });
    expect(a.adjustmentMinor).toBe(EUR(344_250));
  });
});

import { describe, it, expect } from 'vitest';
import { and, eq, lt } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, ensureHistoricalTaxRates } from './setup';
import { DEFAULT_TAX_RATES, DEFAULT_VAT_TREATMENTS } from './vatTreatments';
import { VATCA_REVISED_CURATED_RULES } from '../rules/vatcaRevisedCuration';
import { TAX_RATE_SYNC_MAP } from '../rules/taxRateSync';
import { resolveTreatment } from '../vat/engine';
import { addDays, asIsoDate } from '../dates';
import { auditEvents, taxRates } from '@/db/schema';

/**
 * Issue #617: the seeded VAT rates are dated and cited from the curated s.46
 * rules (LRC-revised text), history included, and the two are held in step
 * here. A rate the repository's sources do not cover is not seeded.
 */

const vatSeeds = DEFAULT_TAX_RATES.filter((r) => r.taxType === 'vat');
const bp = (percent: number) => Math.round(percent * 100);

describe('the seeded rates agree with the curated s.46 rules', () => {
  it.each(TAX_RATE_SYNC_MAP)('$taxRateCode: one seed row per curated version of $ruleKey, same rate and window', ({ ruleKey, taxRateCode }) => {
    const curated = VATCA_REVISED_CURATED_RULES.filter((r) => r.ruleKey === ruleKey)
      .map((r) => ({
        rateBasisPoints: bp(r.numericValue!), effectiveFrom: r.effectiveFrom,
        // Curated windows end on the first day of the next version; tax_rates ends on the last day.
        effectiveTo: r.effectiveTo ? addDays(asIsoDate(r.effectiveTo), -1) : undefined,
      }));
    const seeded = vatSeeds.filter((r) => r.code === taxRateCode)
      .map(({ rateBasisPoints, effectiveFrom, effectiveTo }) => ({ rateBasisPoints, effectiveFrom, effectiveTo }));
    expect(seeded).toEqual(curated);
  });

  it('the standard rate: 23% from 2012, 21% for 1 Sep 2020 – 28 Feb 2021, 23% from 1 Mar 2021', () => {
    expect(vatSeeds.filter((r) => r.code === 'VAT_STD').map((r) => [r.rateBasisPoints, r.effectiveFrom, r.effectiveTo ?? null]))
      .toEqual([[2300, '2012-01-01', '2020-08-31'], [2100, '2020-09-01', '2021-02-28'], [2300, '2021-03-01', null]]);
  });

  it('the 9% rate starts with the earliest curated 9% period', () => {
    const earliest = VATCA_REVISED_CURATED_RULES.filter((r) => r.numericValue === 9)
      .map((r) => r.effectiveFrom).sort()[0];
    expect(vatSeeds.find((r) => r.code === 'VAT_SECOND_RED')!.effectiveFrom).toBe(earliest);
  });

  it('every VAT rate that is a statutory rate cites its provision', () => {
    for (const r of vatSeeds.filter((x) => x.code !== 'VAT_NONE')) {
      expect(r.sourceNote, r.code).toMatch(/VATCA 2010 s\.46\(1[A]?\)/);
    }
  });

  it('per code: windows are contiguous, never overlap, and exactly one is still open', () => {
    for (const code of new Set(vatSeeds.map((r) => r.code))) {
      const rows = vatSeeds.filter((r) => r.code === code);
      expect(rows.filter((r) => !r.effectiveTo), code).toHaveLength(1);
      expect(rows.at(-1)!.effectiveTo, code).toBeUndefined();
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.effectiveFrom, code).toBe(addDays(asIsoDate(rows[i - 1]!.effectiveTo!), 1));
      }
    }
  });
});

describe('a new book resolves the rate in force on each date', () => {
  const { db } = createTestDatabase();
  const { companyId, treatmentsByCode: tr } = createCompany(db, { legalName: 'History Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] });
  const rateOn = (code: string, date: string) => resolveTreatment(db, { companyId, treatmentId: tr[code]!, onDate: asIsoDate(date) }).rateBasisPoints;

  it('standard: 23% in 2015, 21% in October 2020, 23% in 2026', () => {
    expect(rateOn('IE_STD', '2015-06-01')).toBe(2300);
    expect(rateOn('IE_STD', '2020-10-15')).toBe(2100);
    expect(rateOn('IE_STD', '2021-02-28')).toBe(2100);
    expect(rateOn('IE_STD', '2021-03-01')).toBe(2300);
    expect(rateOn('IE_STD', '2026-03-01')).toBe(2300);
  });

  it('reduced and livestock from the Act\'s commencement', () => {
    expect(rateOn('IE_RED', '2010-11-01')).toBe(1350);
    expect(rateOn('IE_LIVESTOCK', '2015-06-01')).toBe(480);
  });

  it('a date the sources do not cover is refused, not given a rate', () => {
    expect(() => rateOn('IE_STD', '2011-06-01')).toThrow(/No "VAT standard rate" rate was in force/);
  });

  it('postponed accounting does not apply before it commenced', () => {
    expect(() => rateOn('IMPORT_PA', '2020-12-30')).toThrow(/only takes effect from 2020-12-31/);
    expect(rateOn('IMPORT_PA', '2021-01-04')).toBe(2100);
    expect(DEFAULT_VAT_TREATMENTS.find((t) => t.code === 'IMPORT_PA')!.sourceNote).toMatch(/s\.53A.*reg\.14A/);
  });
});

describe('a book seeded before the history (ensureHistoricalTaxRates)', () => {
  it('adds only the windows before its earliest rate, once, and audits them', () => {
    const { db } = createTestDatabase();
    const { companyId, treatmentsByCode: tr } = createCompany(db, { legalName: 'Old Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] });
    // As the books were seeded before #617: every rate from 1 March 2021.
    db.delete(taxRates).where(and(eq(taxRates.companyId, companyId), lt(taxRates.effectiveFrom, '2021-03-01'), eq(taxRates.code, 'VAT_STD'))).run();
    db.update(taxRates).set({ effectiveFrom: '2021-03-01' }).where(and(eq(taxRates.companyId, companyId), eq(taxRates.code, 'VAT_RED'))).run();
    expect(() => resolveTreatment(db, { companyId, treatmentId: tr['IE_STD']!, onDate: asIsoDate('2020-10-15') })).toThrow();

    const added = ensureHistoricalTaxRates(db, companyId);
    expect(added).toEqual(expect.arrayContaining(['VAT_STD', 'VAT_RED']));
    expect(resolveTreatment(db, { companyId, treatmentId: tr['IE_STD']!, onDate: asIsoDate('2020-10-15') }).rateBasisPoints).toBe(2100);
    const red = db.select().from(taxRates).where(and(eq(taxRates.companyId, companyId), eq(taxRates.code, 'VAT_RED'))).all()
      .map((r) => [r.effectiveFrom, r.effectiveTo]).sort();
    expect(red).toEqual([['2010-11-01', '2021-02-28'], ['2021-03-01', null]]);
    expect(db.select().from(auditEvents).where(eq(auditEvents.companyId, companyId)).all()
      .some((e) => e.entityType === 'tax_rate' && /issue #617/.test(e.reason ?? ''))).toBe(true);

    expect(ensureHistoricalTaxRates(db, companyId)).toEqual([]);
  });
});

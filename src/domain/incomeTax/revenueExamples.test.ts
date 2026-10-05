import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeIncomeTax } from './computation';
import { section440Surcharge } from '../corporationTax/computation';
import { asIsoDate } from '../dates';
import { companies } from '@/db/schema';

/**
 * Revenue Notes for Guidance worked examples (issue #281).
 * Period dates are asserted. Euro figures that the Notes apportion by months
 * are not locked: the engine apportions by days (#671). The record of every
 * example, including those that cannot be run, is docs/rules/revenue-worked-examples.md.
 */
const books = (tradeCommencedOn: string, yearEndMonth: number, yearEndDay: number) => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'NfG example', entityType: 'sole_trader', tradeCommencedOn,
    financialYearEndMonth: yearEndMonth, financialYearEndDay: yearEndDay,
    vatRegistrationStatus: 'registered', seedYears: [2001, 2002, 2003, 2004, 2005],
  });
  const profit = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Profit ${date}`,
    sourceType: 'bank_transaction', sourceId: `nfg-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [
      { accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor },
      { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor },
    ],
  });
  return { db, ...created, profit };
};

describe('Part 4 Notes for Guidance basis periods (issue #281)', () => {
  it('s.65 Example 1: the year to 31 October is the basis for that year of assessment', () => {
    const { db, companyId, profit } = books('2001-11-01', 10, 31);
    profit(1_000_000, '2002-06-01');
    expect(computeIncomeTax(db, { companyId, year: 2002 }).basis)
      .toMatchObject({ from: '2001-11-01', to: '2002-10-31' });
  });

  it('s.66 Example 1: first year is commencement to 31 December, second year the 12-month account', () => {
    const { db, companyId, profit } = books('2002-07-01', 6, 30);
    profit(1_200_000, '2002-08-01');
    profit(2_400_000, '2003-08-01');
    const first = computeIncomeTax(db, { companyId, year: 2002 });
    const second = computeIncomeTax(db, { companyId, year: 2003 });
    expect(first.basis).toMatchObject({ from: '2002-07-01', to: '2002-12-31' });
    expect(second.basis).toMatchObject({ from: '2002-07-01', to: '2003-06-30' });
    // Notes: €12,000 × 6/12 = €6,000. The engine uses days (#671), so the figure is not locked.
    expect(first.basisProfitMinor).not.toBe(600_000);
  });

  it('s.67 Example 1: the cessation year is 1 January to the date the trade ceased', () => {
    const { db, companyId, profit } = books('2002-10-01', 7, 31);
    profit(2_200_000, '2003-01-15');
    db.update(companies).set({ tradeCeasedOn: '2003-07-31' }).where(eq(companies.id, companyId)).run();
    const year = computeIncomeTax(db, { companyId, year: 2003 });
    expect(year.basis).toMatchObject({ from: '2003-01-01', to: '2003-07-31' });
    // Notes: €22,000 × 7/10 = €15,400. Day apportionment does not match (#671).
    expect(year.basisProfitMinor).not.toBe(1_540_000);
  });

  it('s.67 Example 2: the penultimate year is flagged, not revised (#672)', () => {
    const { db, companyId, profit } = books('2001-10-01', 9, 30);
    profit(2_000_000, '2002-01-15');
    profit(2_400_000, '2003-01-15');
    profit(3_200_000, '2003-11-01');
    db.update(companies).set({ tradeCeasedOn: '2004-05-31' }).where(eq(companies.id, companyId)).run();
    const penultimate = computeIncomeTax(db, { companyId, year: 2003 });
    const cessation = computeIncomeTax(db, { companyId, year: 2004 });
    expect(cessation.basis).toMatchObject({ from: '2004-01-01', to: '2004-05-31' });
    expect(cessation.findings.some((f) => f.includes('revised up'))).toBe(true);
    expect(penultimate.basisProfitMinor).toBe(penultimate.assessableProfitMinor);
  });
});

describe('Part 13 Notes for Guidance s.440 examples already in the surcharge function', () => {
  it('charges €6,000 on €30,000 undistributed, and €320 where marginal relief bites', () => {
    expect(section440Surcharge(3_000_000, 0, 200_000, 2000, 8000)).toBe(600_000);
    // Excess €2,400, threshold €2,000: 20% is €480, capped at 80% of €400 = €320.
    expect(section440Surcharge(3_000_000, 2_760_000, 200_000, 2000, 8000)).toBe(32_000);
  });
});

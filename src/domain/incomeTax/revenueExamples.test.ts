import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeIncomeTax } from './computation';
import { recordCtDecision, section440Surcharge } from '../corporationTax/computation';
import { asIsoDate } from '../dates';
import { companies } from '@/db/schema';

/**
 * Revenue Notes for Guidance worked examples (issue #281).
 * Period dates and the Notes' euro figures are asserted. Whole calendar months
 * are apportioned as months, as the Notes do (#671). The record of every
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
    // The Notes use 2002. The wear and tear rate is in force from 4 December 2002,
    // and a computation runs from commencement, so the same case is run for 2005.
    const { db, companyId, profit } = books('2003-11-01', 10, 31);
    profit(1_000_000, '2005-06-01');
    expect(computeIncomeTax(db, { companyId, year: 2005 }).basis)
      .toMatchObject({ from: '2004-11-01', to: '2005-10-31' });
  });

  it('s.66 Example 1: first year is commencement to 31 December, second year the 12-month account', () => {
    const { db, companyId, profit } = books('2002-07-01', 6, 30);
    profit(1_200_000, '2002-08-01');
    profit(2_400_000, '2003-08-01');
    const first = computeIncomeTax(db, { companyId, year: 2002 });
    const second = computeIncomeTax(db, { companyId, year: 2003 });
    expect(first.basis).toMatchObject({ from: '2002-07-01', to: '2002-12-31' });
    expect(second.basis).toMatchObject({ from: '2002-07-01', to: '2003-06-30' });
    expect(first.basisProfitMinor).toBe(600_000); // €12,000 × 6/12
    expect(second.basisProfitMinor).toBe(1_200_000);
  });

  it('s.66 Example 4: the third year is reduced by the second year\'s excess when the election is recorded', () => {
    const { db, companyId, profit } = books('2002-07-01', 6, 30);
    profit(1_600_000, '2002-08-01');
    profit(1_200_000, '2003-08-01');
    expect(computeIncomeTax(db, { companyId, year: 2003 }).basisProfitMinor).toBe(1_600_000);
    recordCtDecision(db, {
      companyId, subjectType: 'basis_election', subjectId: companyId, periodEnd: '2004-12-31', choice: 'elect', decidedBy: 'Trader',
    });
    const third = computeIncomeTax(db, { companyId, year: 2004 });
    // Actual 2003 is 6/12 of €16,000 + 6/12 of €12,000 = €14,000. Excess €2,000. Revised €10,000.
    expect(third.thirdYearReliefMinor).toBe(200_000);
    expect(third.basisProfitMinor).toBe(1_000_000);
  });

  it('s.67 Example 1: the cessation year is 1 January to the date the trade ceased', () => {
    const { db, companyId, profit } = books('2002-10-01', 7, 31);
    profit(2_200_000, '2003-01-15');
    db.update(companies).set({ tradeCeasedOn: '2003-07-31' }).where(eq(companies.id, companyId)).run();
    const year = computeIncomeTax(db, { companyId, year: 2003 });
    expect(year.basis).toMatchObject({ from: '2003-01-01', to: '2003-07-31' });
    expect(year.basisProfitMinor).toBe(1_540_000); // €22,000 × 7/10
  });

  it('s.67 Example 2: the penultimate year is revised up to its actual profits (#672)', () => {
    // The Notes' first account is the year to 30 September 2002. The trade is taken to
    // commence on 1 January 2002, since the wear and tear rate starts on 4 December 2002.
    const { db, companyId, profit } = books('2002-01-01', 9, 30);
    profit(2_000_000, '2002-01-15');
    profit(2_400_000, '2003-01-15');
    profit(3_200_000, '2003-11-01');
    db.update(companies).set({ tradeCeasedOn: '2004-05-31' }).where(eq(companies.id, companyId)).run();
    const penultimate = computeIncomeTax(db, { companyId, year: 2003 });
    const cessation = computeIncomeTax(db, { companyId, year: 2004 });
    expect(cessation.basis).toMatchObject({ from: '2004-01-01', to: '2004-05-31' });
    expect(cessation.findings.some((f) => f.includes('revised up'))).toBe(true);
    expect(cessation.basisProfitMinor).toBe(2_000_000); // €32,000 × 5/8
    // €24,000 × 9/12 + €32,000 × 3/8 = €18,000 + €12,000.
    expect(penultimate.basis).toMatchObject({ from: '2003-01-01', to: '2003-12-31' });
    expect(penultimate.basisProfitMinor).toBe(3_000_000);
    expect(penultimate.assessableProfitMinor).toBe(3_000_000);
  });
});

describe('Part 13 Notes for Guidance s.440 examples already in the surcharge function', () => {
  it('charges €6,000 on €30,000 undistributed, and €320 where marginal relief bites', () => {
    expect(section440Surcharge(3_000_000, 0, 200_000, 2000, 8000)).toBe(600_000);
    // Excess €2,400, threshold €2,000: 20% is €480, capped at 80% of €400 = €320.
    expect(section440Surcharge(3_000_000, 2_760_000, 200_000, 2000, 8000)).toBe(32_000);
  });
});

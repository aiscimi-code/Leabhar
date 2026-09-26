import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { addPartner, setPartnerShare, PartnerError } from '../config/partners';
import { recordCtDecision } from '../corporationTax/computation';
import { computeIncomeTax, IncomeTaxError } from './computation';
import { asIsoDate } from '../dates';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';

const setup = (entityType: 'sole_trader' | 'partnership', tradeCommencedOn: string, yearEndMonth = 12) => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: entityType === 'sole_trader' ? 'Aoife Byrne' : 'Byrne & Walsh', entityType, tradeCommencedOn,
    financialYearEndMonth: yearEndMonth, financialYearEndDay: yearEndMonth === 6 ? 30 : 31,
    vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
  });
  const income = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`, sourceType: 'bank_transaction',
    sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor }, { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor }],
  });
  return { db, ...created, income };
};

describe('entity types', () => {
  it('gives a sole trader a capital account and drawings, and no corporation tax or directors accounts', () => {
    const { db, companyId } = setup('sole_trader', '2023-01-01');
    const names = new Map(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().map((a) => [a.code, a.name]));
    expect([names.get('3000'), names.get('3200'), names.has('2200'), names.has('6160')]).toEqual(['Capital account', 'Drawings', false, false]);
  });

  it('refuses income tax for a company, and partners for anything but a partnership', () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Co Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    expect(() => computeIncomeTax(db, { companyId, year: 2025 })).toThrow(IncomeTaxError);
    expect(() => addPartner(db, { companyId, name: 'X', shareBasisPoints: 10_000, joinedOn: '2025-01-01', recordedBy: 'Me' })).toThrow(PartnerError);
  });
});

describe('sole trader', () => {
  it('charges 2025 income tax and USC at the Finance Act 2024 bands and credits', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2025-06-01');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    expect(c.basis).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    const me = c.individuals[0]!;
    // 44,000 at 20% + 16,000 at 40% - 2,000 personal - 2,000 earned income credit.
    expect(me.incomeTaxMinor).toBe(1_120_000);
    // 12,012 at 0.5% + 15,370 at 2% + 32,618 at 3%.
    expect(me.uscMinor).toBe(134_600);
    expect(me.prsiMinor).toBeNull();
    expect(c.findings.some((f) => f.includes('No PRSI Class S rate'))).toBe(true);
    expect(c.dates).toMatchObject({ preliminaryTaxDue: '2025-10-31', returnDue: '2026-10-31' });
    expect(c.decisions[0]).toMatchObject({ subjectType: 'personal_status', suggested: 'single' });
  });

  it('uses the band and credit of the status a person records', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2025-06-01');
    recordCtDecision(db, { companyId, subjectType: 'personal_status', subjectId: companyId, periodEnd: '2025-12-31', choice: 'married_one_income', decidedBy: 'Aoife' });
    // 53,000 at 20% + 7,000 at 40% - 4,000 - 2,000.
    expect(computeIncomeTax(db, { companyId, year: 2025 }).individuals[0]!.incomeTaxMinor).toBe(740_000);
  });

  it('applies the 2026 USC bands and PRSI Class S from the 2026 rules', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2026-06-01');
    const me = computeIncomeTax(db, { companyId, year: 2026 }).individuals[0]!;
    // 12,012 at 0.5% + 16,688 at 2% + 31,300 at 3%.
    expect(me.uscMinor).toBe(6006 + 33_376 + 93_900);
    expect(me.prsiMinor).toBe(252_000);
  });

  it('taxes the first year from commencement and the second on the 12-month account (s.66)', () => {
    const { db, companyId, income } = setup('sole_trader', '2024-07-01');
    income(3_000_000, '2024-09-01');
    income(5_000_000, '2025-03-01');
    expect(computeIncomeTax(db, { companyId, year: 2024 })).toMatchObject({ basis: { from: '2024-07-01', to: '2024-12-31' }, assessableProfitMinor: 3_000_000 });
    expect(computeIncomeTax(db, { companyId, year: 2025 })).toMatchObject({ basis: { from: '2025-01-01', to: '2025-12-31' }, assessableProfitMinor: 5_000_000 });
  });

  it('reduces the third year by the second year\'s excess over its actual profits (s.66(3))', () => {
    const { db, companyId, income } = setup('sole_trader', '2024-07-01', 6);
    income(12_000_000, '2024-08-01'); // year to 30 June 2025
    income(6_000_000, '2025-08-01');  // year to 30 June 2026
    const second = computeIncomeTax(db, { companyId, year: 2025 });
    expect(second.basis).toMatchObject({ from: '2024-07-01', to: '2025-06-30' });
    expect(second.assessableProfitMinor).toBe(12_000_000);
    const third = computeIncomeTax(db, { companyId, year: 2026 });
    // Actual 2025: 181/365 of 120,000 + 184/365 of 60,000.
    const actual2025 = Math.round(12_000_000 * 181 / 365) + Math.round(6_000_000 * 184 / 365);
    expect(third.thirdYearReliefMinor).toBe(Math.min(12_000_000 - actual2025, 6_000_000));
  });
});

describe('partnership', () => {
  it('apportions the profit by the shares in force, day by day through a change (s.1008)', () => {
    const { db, companyId, income } = setup('partnership', '2023-01-01');
    const a = addPartner(db, { companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2023-01-01', recordedBy: 'Aoife', isPrecedentPartner: true });
    const b = addPartner(db, { companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2023-01-01', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: a.id, shareBasisPoints: 7000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: b.id, shareBasisPoints: 3000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    income(3_650_000, '2025-03-01');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    const byName = Object.fromEntries(c.individuals.map((i) => [i.name, i.profitMinor]));
    // 182 days at 50/50, 183 days at 70/30 of 36,500.
    expect(byName).toEqual({ Aoife: 910_000 + 1_281_000, Brian: 910_000 + 549_000 });
    expect(c.findings.some((f) => f.includes('add up to'))).toBe(false);
    expect(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().filter((x) => x.name.includes('Aoife')).length).toBe(2);
  });

  it('flags shares that do not add up to 100% and a missing precedent partner', () => {
    const { db, companyId, income } = setup('partnership', '2023-01-01');
    addPartner(db, { companyId, name: 'Aoife', shareBasisPoints: 6000, joinedOn: '2023-01-01', recordedBy: 'Aoife' });
    income(1_000_000, '2025-03-01');
    const f = computeIncomeTax(db, { companyId, year: 2025 }).findings;
    expect(f.some((x) => x.includes('add up to 60%'))).toBe(true);
    expect(f.some((x) => x.includes('No precedent partner'))).toBe(true);
  });
});

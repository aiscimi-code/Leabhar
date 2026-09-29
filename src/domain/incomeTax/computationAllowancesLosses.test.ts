import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { setPartnerActivityStatus, addPartner } from '../config/partners';
import { recordCtDecision, CtDecisionError } from '../corporationTax/computation';
import { computeIncomeTax, type IndividualLiability } from './computation';
import { asIsoDate } from '../dates';
import { fixedAssets, partners } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ids } from '@/lib/ids';
import { multiplyRational } from '../money';

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

const expense = (s: ReturnType<typeof setup>, amountMinor: number, date: string) => postJournalEntry(s.db, {
  companyId: s.companyId, entryDate: asIsoDate(date), narrative: `Costs ${date}`, sourceType: 'bank_transaction',
  sourceId: `e-${date}-${amountMinor}`, baseCurrency: 'EUR',
  lines: [{ accountId: s.accountsByCode['6070']!, debitMinor: amountMinor }, { accountId: s.accountsByKey['bank_control']!, creditMinor: amountMinor }],
});

describe('capital allowances for the year of assessment (s.284, issue #285)', () => {
  it('gives each year of assessment its own allowance, and a balancing allowance the apportioned treatment loses', () => {
    const s = setup('sole_trader', '2024-07-01', 6);
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2024-08-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
      disposalDate: '2025-05-31', disposalProceedsMinor: 3_000_000,
    }).run();
    s.income(10_000_000, '2024-09-01');
    s.income(10_000_000, '2025-03-01');
    const y2024 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(y2024.basis).toMatchObject({ from: '2024-07-01', to: '2024-12-31' });
    expect(y2024.capitalAllowancesMinor).toBe(-multiplyRational(1_000_000, 184, 366));
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    const firstYearClaim = multiplyRational(1_000_000, 184, 366);
    expect(y2025.capitalAllowancesMinor).toBe(-((8_000_000 - firstYearClaim) - 3_000_000));
    expect(y2025.assessableProfitMinor).toBe(20_000_000 + y2025.capitalAllowancesMinor);
    expect(y2025.capitalAllowanceLines.some((l) => l.label.includes('balancing allowances'))).toBe(true);
  });

  it('gives a full year allowance for a 12-month basis period after a short first one', () => {
    const s = setup('sole_trader', '2024-10-01', 6);
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Server', assetCategory: 'computer_equipment',
      purchaseDate: '2024-10-15', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    s.income(6_000_000, '2024-11-01');
    s.income(6_000_000, '2025-03-01');
    const y2024 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(y2024.capitalAllowancesMinor).toBe(-multiplyRational(1_000_000, 92, 366));
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(y2025.capitalAllowancesMinor).toBe(-1_000_000);
  });
});

describe('trading losses (ss.381, 382; issue #285)', () => {
  it('carries a trading loss forward and uses it in a later year (s.382)', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(1_000_000, '2024-06-01');
    expense(s, 6_000_000, '2024-06-02');
    const loss = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(loss.tradingLossMinor).toBe(5_000_000);
    expect(loss.individuals[0]!).toMatchObject({ profitMinor: -5_000_000, lossCarriedForwardMinor: 5_000_000, totalMinor: 0 });
    s.income(8_000_000, '2025-06-01');
    const me25 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 }).individuals[0]!;
    expect(me25).toMatchObject({ profitMinor: 8_000_000, broughtForwardLossUsedMinor: 5_000_000 });
    expect(me25.incomeTaxMinor).toBe(600_000 - 400_000);
    expect(me25.lossCarriedForwardMinor).toBe(0);
  });

  it('applies a person\'s s.381 claim to the amount they record, and refuses one without an amount', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(1_000_000, '2024-06-01');
    expense(s, 6_000_000, '2024-06-02');
    const pending = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 }).decisions.find((d) => d.subjectType === 'income_tax_loss_claim')!;
    expect(pending).toMatchObject({ suggested: 'carry_forward', decided: null, amountMinor: 5_000_000 });
    expect(() => recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2024-12-31', choice: 'claim_381', decidedBy: 'Aoife',
    })).toThrow(CtDecisionError);
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2024-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 2_000_000,
    });
    const claimed = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(claimed.individuals[0]!).toMatchObject({ claimedAgainstOtherIncomeMinor: 2_000_000, lossCarriedForwardMinor: 3_000_000 });
    s.income(4_000_000, '2025-06-01');
    expect(computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 }).individuals[0]!).toMatchObject({
      profitMinor: 4_000_000, broughtForwardLossUsedMinor: 3_000_000,
    });
  });
});

import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { setPartnerActivityStatus, addPartner } from '../config/partners';
import { recordCtDecision } from '../corporationTax/computation';
import { computeIncomeTax, type IndividualLiability } from './computation';
import { asIsoDate } from '../dates';
import { fixedAssets, partners } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ids } from '@/lib/ids';

const setup = (entityType: 'sole_trader' | 'partnership', tradeCommencedOn: string) => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: entityType === 'sole_trader' ? 'Aoife Byrne' : 'Byrne & Walsh', entityType, tradeCommencedOn,
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

describe('allowance-created losses and partner status (issues #467, #493)', () => {
  it('treats an allowance-created loss as a trading loss only under the recorded s.392 election, and caps s.381 without it', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(200_000, '2025-06-01');
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2025-02-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    const c = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(c).toMatchObject({ lossBeforeAllowancesMinor: 0, allowanceLossMinor: 800_000, tradingLossMinor: 800_000 });
    expect(c.individuals[0]!.lossCarriedForwardMinor).toBe(0);
    const pending = c.decisions.find((d) => d.subjectType === 'allowance_loss_election')!;
    expect(pending.amountMinor).toBe(800_000);
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2025-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 800_000,
    });
    expect(computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 }).individuals[0]!.claimedAgainstOtherIncomeMinor).toBe(0);
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'allowance_loss_election', subjectId: s.companyId,
      periodEnd: '2025-12-31', choice: 'elect', decidedBy: 'Aoife',
    });
    expect(computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 }).individuals[0]!).toMatchObject({
      claimedAgainstOtherIncomeMinor: 800_000, lossCarriedForwardMinor: 0,
    });
  });

  it('carries unused allowances forward as allowances without the s.392 election', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(200_000, '2025-06-01');
    s.income(3_000_000, '2026-06-01');
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2025-02-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    expect(computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 }).individuals[0]!).toMatchObject({
      lossCarriedForwardMinor: 0, allowancesCarriedForwardMinor: 800_000,
    });
    const y2026 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2026 }).individuals[0]!;
    expect(y2026).toMatchObject({
      profitMinor: 2_000_000, allowancesBroughtForwardUsedMinor: 800_000, allowancesCarriedForwardMinor: 0,
    });
    expect(y2026.incomeTax[0]!.label).toContain('12000.00');
  });

  it('gives no earned income credit to a sleeping partner, and flags an unrecorded status', () => {
    const s = setup('partnership', '2024-01-01');
    const active = addPartner(s.db, {
      companyId: s.companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2024-01-01',
      recordedBy: 'Aoife', isPrecedentPartner: true, activityStatus: 'active',
    });
    const sleeping = addPartner(s.db, {
      companyId: s.companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2024-01-01',
      recordedBy: 'Aoife', activityStatus: 'sleeping',
    });
    s.income(6_000_000, '2025-06-01');
    const c = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    const byName = Object.fromEntries(c.individuals.map((i) => [i.name, i])) as Record<string, IndividualLiability>;
    expect(byName.Aoife!.incomeTax.some((l) => l.label.includes('earned income tax credit'))).toBe(true);
    expect(byName.Brian!.incomeTax.some((l) => l.label.includes('earned income tax credit'))).toBe(false);
    expect(byName.Brian!.incomeTaxMinor - byName.Aoife!.incomeTaxMinor).toBe(200_000);
    setPartnerActivityStatus(s.db, { companyId: s.companyId, partnerId: sleeping.id, activityStatus: 'active', recordedBy: 'Aoife' });
    s.db.update(partners).set({ activityStatus: null }).where(eq(partners.id, active.id)).run();
    const flagged = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(flagged.findings.some((f) => f.includes('Aoife') && f.includes('status is not recorded'))).toBe(true);
  });

  it('limits an s.381 claim to the year\'s own loss and splits a partnership loss by shares', () => {
    const sole = setup('sole_trader', '2024-01-01');
    sole.income(1_000_000, '2024-06-01');
    expense(sole, 6_000_000, '2024-06-02');
    sole.income(1_000_000, '2025-06-01');
    expense(sole, 2_000_000, '2025-06-02');
    recordCtDecision(sole.db, {
      companyId: sole.companyId, subjectType: 'income_tax_loss_claim', subjectId: sole.companyId,
      periodEnd: '2025-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 3_000_000,
    });
    expect(computeIncomeTax(sole.db, { companyId: sole.companyId, year: 2025 }).individuals[0]!).toMatchObject({
      profitMinor: -1_000_000, claimedAgainstOtherIncomeMinor: 1_000_000, lossCarriedForwardMinor: 5_000_000,
    });

    const firm = setup('partnership', '2024-01-01');
    addPartner(firm.db, { companyId: firm.companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2024-01-01', recordedBy: 'Aoife', isPrecedentPartner: true });
    addPartner(firm.db, { companyId: firm.companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2024-01-01', recordedBy: 'Aoife' });
    firm.income(1_000_000, '2024-06-01');
    expense(firm, 5_000_000, '2024-06-02');
    expect(Object.fromEntries(computeIncomeTax(firm.db, { companyId: firm.companyId, year: 2024 }).individuals.map((i) => [i.name, i.lossCarriedForwardMinor])))
      .toEqual({ Aoife: 2_000_000, Brian: 2_000_000 });
    firm.income(6_000_000, '2025-06-01');
    const y2025 = computeIncomeTax(firm.db, { companyId: firm.companyId, year: 2025 });
    expect(Object.fromEntries(y2025.individuals.map((i) => [i.name, i.broughtForwardLossUsedMinor])))
      .toEqual({ Aoife: 2_000_000, Brian: 2_000_000 });
    expect(y2025.individuals.every((i) => i.incomeTaxMinor === 0)).toBe(true);
  });
});

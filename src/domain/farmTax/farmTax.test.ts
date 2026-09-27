import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { journalLines, reviewItems } from '@/db/schema';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { asIsoDate } from '../dates';
import { recordCtDecision, capitalAllowances, computeCorporationTax } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { buildForm11 } from '../incomeTax/form11';
import { registerFixedAsset } from '../assets/register';
import { saveFarmProfile } from '../farm/setup';
import {
  recordGrant, linkGrantReceipt, reconcileGrants, recordFarmPartnershipRegistration, successionCreditFor, recordShareFarming,
  farmTaxSummary, tradingStockValue,
} from '.';

type Entity = 'sole_trader' | 'partnership' | 'company';

function book(entityType: Entity = 'sole_trader', commenced = '2023-01-01') {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'Feirm', entityType, chartKind: 'farm', tradeCommencedOn: entityType === 'company' ? undefined : commenced,
    vatRegistrationStatus: 'registered', seedYears: [2022, 2023, 2024, 2025, 2026],
  });
  const { companyId } = created;
  const byCode = created.accountsByCode;
  const bank = created.accountsByKey['bank_control']!;
  saveFarmProfile(db, { companyId, farmName: 'Gort', recordedBy: 'o' });
  const post = (date: string, lines: Array<{ code: string; debit?: number; credit?: number }>, sourceType: 'manual_adjustment' | 'opening_balance' = 'manual_adjustment') =>
    postJournalEntry(db, {
      companyId, entryDate: asIsoDate(date), narrative: `Entry ${date}`, sourceType, baseCurrency: 'EUR',
      lines: lines.map((l) => ({ accountId: l.code === 'bank' ? bank : byCode[l.code]!, debitMinor: l.debit ?? 0, creditMinor: l.credit ?? 0 })),
    });
  /** Farm sales received, and a profit of that amount for the year. */
  const sales = (date: string, amount: number) => post(date, [{ code: 'bank', debit: amount }, { code: '4000', credit: amount }]);
  const decide = (subjectType: Parameters<typeof recordCtDecision>[1]['subjectType'], year: number, choice: string, extra: { amountMinor?: number; note?: string } = {}) =>
    recordCtDecision(db, { companyId, subjectType, subjectId: companyId, periodEnd: `${year}-12-31`, choice, decidedBy: 'Farmer', ...extra });
  return { db, companyId, byCode, bank, post, sales, decide };
}

describe('stock relief (ss.666, 667B, 667C; issue #544)', () => {
  /** Stock €20,000 at the start of 2025 and €25,000 at the end: the NfG's example. */
  function withStock(entityType: Entity = 'sole_trader') {
    const b = book(entityType);
    b.post('2024-12-31', [{ code: '1330', debit: 2_000_000 }, { code: '3000', credit: 2_000_000 }], 'opening_balance');
    // The increase is booked by the year-end valuation: Dr stock, Cr the change account.
    b.post('2025-12-31', [{ code: '1330', debit: 500_000 }, { code: '5040', credit: 500_000 }]);
    return b;
  }

  it('offers the claim, and deducts 25% of the increase only once it is recorded', () => {
    const { db, companyId, sales, decide } = withStock();
    sales('2025-06-01', 100_000); // with the €5,000 stock increase, a farming profit of €6,000
    expect(tradingStockValue(db, companyId, '2025-12-31')).toBe(2_500_000);
    const before = computeIncomeTax(db, { companyId, year: 2025 });
    expect(before.decisions.find((d) => d.subjectType === 'farm_stock_relief')).toMatchObject({ suggested: 'none', decided: null, amountMinor: 125_000 });
    expect(before.assessableProfitMinor).toBe(600_000);
    decide('farm_stock_relief', 2025, 'general');
    const after = computeIncomeTax(db, { companyId, year: 2025 });
    // €6,000 less 25% of the €5,000 increase: €4,750, as the Notes for Guidance example.
    expect(after.farm?.stockRelief).toMatchObject({ increaseMinor: 500_000, rateBasisPoints: 2500, reliefMinor: 125_000 });
    expect(after.assessableProfitMinor).toBe(475_000);
    const form = buildForm11(db, { companyId, year: 2025 });
    const trade = form.sections.find((s) => s.title.startsWith('Trading income'))!;
    expect(trade.lines.find((l) => l.label === 'Less stock relief (s.666)')?.amountMinor).toBe(-125_000);
  });

  it('never creates a loss', () => {
    const { db, companyId, post, decide } = withStock();
    post('2025-06-01', [{ code: '6210', debit: 400_000 }, { code: 'bank', credit: 400_000 }]); // profit €1,000
    decide('farm_stock_relief', 2025, 'young_trained');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    expect(c.farm?.stockRelief).toMatchObject({ rateBasisPoints: 10_000, grossReliefMinor: 500_000, reliefMinor: 100_000 });
    expect(c.assessableProfitMinor).toBe(0);
  });

  it('gives the partnership rate only to a partnership on the register', () => {
    const { db, companyId, sales, decide } = withStock();
    sales('2025-06-01', 100_000);
    decide('farm_stock_relief', 2025, 'registered_partnership');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    expect(c.farm?.stockRelief?.rateBasisPoints).toBe(2500);
    expect(c.findings.join(' ')).toMatch(/register of farm partnerships/);
  });

  it('is a deduction in a farming company\'s corporation tax too', () => {
    const { db, companyId, sales, decide } = withStock('company');
    sales('2025-06-01', 100_000);
    decide('farm_stock_relief', 2025, 'general');
    const ct = computeCorporationTax(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') });
    expect(ct.lines.find((l) => l.label === 'Deduct: stock relief')?.amountMinor).toBe(-125_000);
    expect(ct.tradingProfitMinor).toBe(475_000);
  });
});

describe('income averaging (s.657; issue #544)', () => {
  function fiveYears() {
    const b = book('sole_trader', '2023-01-01');
    // The Notes for Guidance example: 2017-2021 becomes 2021-2025 here.
    b.decide('farm_prior_profit', 2021, 'recorded', { amountMinor: 1_500_000, note: '2021 Form 11' });
    b.decide('farm_prior_profit', 2022, 'recorded', { amountMinor: 1_800_000, note: '2022 Form 11' });
    b.sales('2023-06-01', 2_100_000);
    b.sales('2024-06-01', 2_400_000);
    b.sales('2025-06-01', 2_100_000);
    return b;
  }

  it('charges one fifth of five years\' profits once elected', () => {
    const { db, companyId, decide } = fiveYears();
    expect(computeIncomeTax(db, { companyId, year: 2025 }).assessableProfitMinor).toBe(2_100_000);
    decide('farm_income_averaging', 2025, 'averaging');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    // 15,000 + 18,000 + 21,000 + 24,000 + 21,000 = 99,000; a fifth is 19,800.
    expect(c.farm?.averaging).toMatchObject({ applied: true, averageMinor: 1_980_000 });
    expect(c.farm?.averaging?.years.map((y) => [y.year, y.source])).toEqual([
      [2021, 'recorded'], [2022, 'recorded'], [2023, 'books'], [2024, 'books'], [2025, 'books'],
    ]);
    expect(c.assessableProfitMinor).toBe(1_980_000);
  });

  it('needs every year\'s profit, and allows a step-out once in five years', () => {
    const { db, companyId, decide } = fiveYears();
    decide('farm_income_averaging', 2024, 'averaging');
    const missing = computeIncomeTax(db, { companyId, year: 2024 });
    expect(missing.findings.join(' ')).toMatch(/profits of 2020/);
    expect(missing.assessableProfitMinor).toBe(2_400_000);
    decide('farm_income_averaging', 2024, 'step_out');
    decide('farm_income_averaging', 2025, 'step_out');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    expect(c.findings.join(' ')).toMatch(/once every 5 years/);
    expect(c.assessableProfitMinor).toBe(1_980_000);
  });
});

describe('farm capital allowances and grants (ss.658, 658A, 317; issues #543, #545)', () => {
  it('writes farm buildings off at 15% on the cost net of grants received, and slurry storage at 50%', () => {
    const { db, companyId, byCode, post } = book('company');
    post('2025-03-01', [{ code: '1590', debit: 10_000_000 }, { code: 'bank', credit: 10_000_000 }]);
    post('2024-05-01', [{ code: '1590', debit: 2_000_000 }, { code: 'bank', credit: 2_000_000 }]);
    const { asset: shed } = registerFixedAsset(db, {
      companyId, name: 'Cattle shed', assetCategory: 'farm_buildings', purchaseDate: '2025-03-01', costMinor: 10_000_000,
      accountId: byCode['1590']!, recordedBy: 'o',
    });
    registerFixedAsset(db, {
      companyId, name: 'Slurry tank', assetCategory: 'slurry_storage', purchaseDate: '2024-05-01', costMinor: 2_000_000,
      accountId: byCode['1590']!, recordedBy: 'o',
    });
    const grant = recordGrant(db, {
      companyId, scheme: 'TAMS 3', payer: 'DAFM', kind: 'capital', awardedMinor: 4_000_000, awardedOn: '2025-02-01',
      fixedAssetId: shed.id, recordedBy: 'o',
    });
    // The grant is received into deferred grant income.
    const receipt = post('2025-09-01', [{ code: 'bank', debit: 4_000_000 }, { code: '2300', credit: 4_000_000 }]);
    const line = db.select().from(journalLines).where(eq(journalLines.journalEntryId, receipt.id)).all().find((l) => l.creditMinor > 0)!;
    linkGrantReceipt(db, { companyId, grantId: grant.id, journalLineId: line.id, recordedBy: 'o' });

    const ca = capitalAllowances(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    const sources = ca.lines[0]!.sources.map((s) => [s.label.split(' (')[0], s.amountMinor]);
    // 15% of €60,000 (€100,000 less the €40,000 grant); 50% of the €20,000 tank.
    expect(sources).toEqual([['Cattle shed', 900_000], ['Slurry tank', 1_000_000]]);
    expect(ca.lines[0]!.citations.map((c) => c.ruleKey)).toEqual(expect.arrayContaining(['farm.buildings_rate', 'farm.slurry_rate', 'ct.allowances_net_of_grants']));
    // Year 7 of the shed takes what is left: 10%.
    const y7 = capitalAllowances(db, { companyId, from: '2031-01-01', to: '2031-12-31' });
    expect(y7.lines[0]!.sources.find((s) => s.label.startsWith('Cattle shed'))?.amountMinor).toBe(600_000);
  });

  it('treats slurry storage bought before 2023 as a farm building', () => {
    const { db, companyId, byCode, post } = book('company');
    post('2022-12-31', [{ code: '1590', debit: 1_000_000 }, { code: 'bank', credit: 1_000_000 }]);
    registerFixedAsset(db, {
      companyId, name: 'Old tank', assetCategory: 'slurry_storage', purchaseDate: '2022-12-31', costMinor: 1_000_000,
      accountId: byCode['1590']!, recordedBy: 'o',
    });
    const ca = capitalAllowances(db, { companyId, from: '2023-01-01', to: '2023-12-31' });
    expect(ca.lines[0]!.sources[0]!.amountMinor).toBe(150_000);
    expect(ca.findings.join(' ')).toMatch(/outside the s\.658A period/);
  });

  it('reconciles grants to their receipts and reports scheme income no grant claims', () => {
    const { db, companyId, post } = book();
    const biss = recordGrant(db, { companyId, scheme: 'BISS', payer: 'DAFM', kind: 'revenue', awardedMinor: 800_000, awardedOn: '2025-10-01', recordedBy: 'o' });
    const paid = post('2025-10-20', [{ code: 'bank', debit: 600_000 }, { code: '4010', credit: 600_000 }]);
    post('2025-11-20', [{ code: 'bank', debit: 50_000 }, { code: '4010', credit: 50_000 }]);
    const line = db.select().from(journalLines).where(eq(journalLines.journalEntryId, paid.id)).all().find((l) => l.creditMinor > 0)!;
    expect(() => recordGrant(db, { companyId, scheme: 'TAMS', payer: 'DAFM', kind: 'capital', awardedMinor: 1, awardedOn: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/names the asset/);
    linkGrantReceipt(db, { companyId, grantId: biss.id, journalLineId: line.id, recordedBy: 'o' });
    expect(() => linkGrantReceipt(db, { companyId, grantId: biss.id, journalLineId: line.id, recordedBy: 'o' })).toThrow(/already the receipt/);
    const r = reconcileGrants(db, { companyId, asOf: '2025-12-31' });
    expect(r.grants[0]).toMatchObject({ receivedMinor: 600_000, outstandingMinor: 200_000 });
    expect(r.unlinked.map((u) => u.amountMinor)).toEqual([50_000]);
    expect(db.select().from(reviewItems).all()).toHaveLength(1);
    const summary = farmTaxSummary(db, { companyId, year: 2025 });
    expect(summary.grants).toEqual({ revenueReceivedMinor: 600_000, capitalReceivedMinor: 0, awardedOutstandingMinor: 200_000, unlinkedMinor: 50_000 });
  });
});

describe('farm partnerships and share farming (issue #546)', () => {
  it('records the registers and the succession credit', () => {
    const { db, companyId } = book('partnership');
    expect(() => recordFarmPartnershipRegistration(db, { companyId, register: 'succession_farm_partnership', identifier: 'S1', registeredOn: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/registered farm partnership first/);
    recordFarmPartnershipRegistration(db, { companyId, register: 'registered_farm_partnership', identifier: 'RFP-1', registeredOn: '2024-01-01', recordedBy: 'o' });
    recordFarmPartnershipRegistration(db, { companyId, register: 'succession_farm_partnership', identifier: 'SFP-1', registeredOn: '2025-01-01', recordedBy: 'o' });
    expect(successionCreditFor(db, companyId, 2025)).toEqual({ creditMinor: 500_000, identifier: 'SFP-1' });
    expect(successionCreditFor(db, companyId, 2024)).toBeNull();
  });

  it('refuses a registration for books that are not a partnership\'s, and keeps share farming as a record', () => {
    const { db, companyId } = book('sole_trader');
    expect(() => recordFarmPartnershipRegistration(db, { companyId, register: 'registered_farm_partnership', identifier: 'X', registeredOn: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/not a partnership/);
    expect(() => recordShareFarming(db, { companyId, counterparty: 'J. Murphy', landProvidedBy: 'this_farm', outputShareBasisPoints: 6000, costShareBasisPoints: 5000, startsOn: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/parcels/);
    expect(recordShareFarming(db, { companyId, counterparty: 'J. Murphy', landProvidedBy: 'counterparty', outputShareBasisPoints: 4000, costShareBasisPoints: 4000, startsOn: '2025-01-01', recordedBy: 'o' }))
      .toMatchObject({ outputShareBasisPoints: 4000 });
  });
});

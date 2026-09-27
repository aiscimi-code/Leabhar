import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import {
  computeCorporationTax, recordCtDecision, CtDecisionError, capitalAllowances, section440Surcharge, section441Surcharge,
} from './computation';
import { fixedAssets, ctDecisions, accounts } from '@/db/schema';
import { asIsoDate } from '../dates';
import { eq } from 'drizzle-orm';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;
const from = asIsoDate('2025-01-01');
const to = asIsoDate('2025-12-31');

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'CT Ltd', vatRegistrationStatus: 'registered', seedYears: [2025, 2026, 2027] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;
});

/** Post an amount to an income (credit) or expense (debit) account against the bank. */
const post = (code: string, amountMinor: number, narrative: string, date = '2025-06-15') => {
  const income = code.startsWith('4');
  return postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative, sourceType: 'bank_transaction', sourceId: `t-${narrative}`,
    baseCurrency: 'EUR',
    lines: income
      ? [{ accountId: byKey['bank_control']!, debitMinor: amountMinor }, { accountId: byCode[code]!, creditMinor: amountMinor }]
      : [{ accountId: byCode[code]!, debitMinor: amountMinor, memo: narrative }, { accountId: byKey['bank_control']!, creditMinor: amountMinor }],
  });
};

const ct = () => computeCorporationTax(db, { companyId, from, to });

describe('computeCorporationTax', () => {
  it('charges trading profit at the 12.5% rate the s.21 rule states', () => {
    post('4020', 10_000_000, 'Consulting');
    post('6070', 2_000_000, 'Accountancy fees');
    const c = ct();
    expect(c.accountingProfitMinor).toBe(8_000_000);
    expect(c.tradingProfitMinor).toBe(8_000_000);
    expect(c.taxAtStandardRateMinor).toBe(1_000_000);
    expect(c.corporationTaxMinor).toBe(1_000_000);
    expect(c.rates.citations.map((x) => x.section)).toEqual(['TCA 1997 s.21', 'TCA 1997 s.21A']);
  });

  it('adds back depreciation under s.81(1)', () => {
    post('4020', 1_000_000, 'Consulting');
    post('6170', 100_000, 'Depreciation charge');
    const c = ct();
    const line = c.lines.find((l) => l.label.includes('Depreciation'))!;
    expect(line.amountMinor).toBe(100_000);
    expect(line.citations[0]!.ruleKey).toBe('ct.deduction_only_if_authorised');
    expect(c.tradingProfitMinor).toBe(1_000_000);
  });

  it('suggests adding back entertainment, and follows a person\'s decision instead', () => {
    post('4020', 1_000_000, 'Consulting');
    const entry = post('6110', 20_000, 'Client dinner at restaurant');
    const c = ct();
    const pending = c.decisions.find((d) => d.subjectType === 'journal_line')!;
    expect(pending).toMatchObject({ suggested: 'add_back_entertainment', decided: null, amountMinor: 20_000 });
    expect(pending.options.map((o) => o.choice)).toEqual(['add_back_entertainment', 'staff_entertainment', 'deductible']);
    expect(c.tradingProfitMinor).toBe(1_000_000);
    expect(c.lines.find((l) => l.kind === 'add_back')!.citations[0]!.section).toBe('TCA 1997 s.840');

    const first = recordCtDecision(db, { companyId, subjectType: 'journal_line', subjectId: pending.subjectId, periodEnd: to, choice: 'staff_entertainment', decidedBy: 'Director' });
    expect(ct().tradingProfitMinor).toBe(980_000);
    // Changing one's mind keeps the earlier decision, superseded.
    recordCtDecision(db, { companyId, subjectType: 'journal_line', subjectId: pending.subjectId, periodEnd: to, choice: 'add_back_entertainment', decidedBy: 'Director' });
    expect(ct().tradingProfitMinor).toBe(1_000_000);
    expect(db.select().from(ctDecisions).all().find((d) => d.id === first)!.supersededById).not.toBeNull();
    expect(entry.id).toBeTruthy();
  });

  it('refuses a choice that is not offered, or one nobody made', () => {
    expect(() => recordCtDecision(db, { companyId, subjectType: 'income_account', subjectId: byCode['4090']!, periodEnd: to, choice: 'deductible', decidedBy: 'Director' }))
      .toThrow(CtDecisionError);
    expect(() => recordCtDecision(db, { companyId, subjectType: 'income_account', subjectId: byCode['4090']!, periodEnd: to, choice: 'case_iii', decidedBy: ' ' }))
      .toThrow(CtDecisionError);
  });

  it('charges other income at the 25% rate, as the Case a person chooses', () => {
    post('4020', 1_000_000, 'Consulting');
    post('4090', 40_000, 'Deposit interest');
    let c = ct();
    expect(c.decisions.find((d) => d.subjectType === 'income_account')!.suggested).toBe('case_iv');
    expect(c.nonTradingIncomeMinor).toBe(40_000);
    expect(c.taxAtHigherRateMinor).toBe(10_000);
    expect(c.tradingProfitMinor).toBe(1_000_000);
    recordCtDecision(db, { companyId, subjectType: 'income_account', subjectId: byCode['4090']!, periodEnd: to, choice: 'case_i', decidedBy: 'Director' });
    c = ct();
    expect(c.nonTradingIncomeMinor).toBe(0);
    expect(c.tradingProfitMinor).toBe(1_040_000);
    expect(c.corporationTaxMinor).toBe(130_000);
  });

  it('gives wear and tear for eight years and then stops', () => {
    post('4020', 1_000_000, 'Consulting');
    db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId, name: 'Server', assetCategory: 'computer_equipment', purchaseDate: '2025-03-01',
      costMinor: 800_000, currency: 'EUR', baseCostMinor: 800_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    expect(ct().lines.find((l) => l.kind === 'deduction')!.amountMinor).toBe(-100_000);
    const inYear = (y: number) => computeCorporationTax(db, { companyId, from: asIsoDate(`${y}-01-01`), to: asIsoDate(`${y}-12-31`) })
      .lines.find((l) => l.kind === 'deduction')?.amountMinor ?? 0;
    expect(inYear(2032)).toBe(-100_000);
    expect(inYear(2033)).toBe(0);
  });

  it('reports a trading loss without charging tax on it', () => {
    post('4020', 100_000, 'Consulting');
    post('6070', 300_000, 'Accountancy fees');
    const c = ct();
    expect(c.tradingProfitMinor).toBe(0);
    expect(c.tradingLossMinor).toBe(200_000);
    expect(c.corporationTaxMinor).toBe(0);
    expect(c.losses.carriedForwardMinor).toBe(200_000);
    expect(c.decisions.find((d) => d.subjectType === 'loss_claim')).toMatchObject({ suggested: 'carry_forward', decided: null });
  });
});

describe('capital allowances', () => {
  const asset = (over: Partial<typeof fixedAssets.$inferInsert> = {}) => {
    const id = ids.fixedAsset();
    db.insert(fixedAssets).values({
      id, companyId, name: 'Server', assetCategory: 'computer_equipment', purchaseDate: '2025-03-01',
      costMinor: 800_000, currency: 'EUR', baseCostMinor: 800_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active', ...over,
    }).run();
    return id;
  };
  const in2027 = () => capitalAllowances(db, { companyId, from: '2027-01-01', to: '2027-12-31' });
  const line = (r: ReturnType<typeof in2027>, label: string) => r.lines.find((l) => l.label.includes(label))?.amountMinor;

  it('gives a balancing allowance for the unallowed cost less the proceeds (s.288(2))', () => {
    // Two years' allowances made (2025, 2026): 200,000; unallowed 600,000.
    asset({ disposalDate: '2027-06-01', disposalProceedsMinor: 300_000 });
    const r = in2027();
    expect(line(r, 'balancing allowances')).toBe(-300_000);
    expect(line(r, 'wear and tear')).toBeUndefined();
  });

  it('charges the excess of proceeds, limited to the allowances made (s.288(3), (4))', () => {
    asset({ disposalDate: '2027-06-01', disposalProceedsMinor: 700_000 });
    expect(line(in2027(), 'balancing charges')).toBe(100_000);
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'CT Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    asset({ disposalDate: '2027-06-01', disposalProceedsMinor: 900_000 });
    const r = in2027();
    expect(line(r, 'balancing charges')).toBe(200_000);
    expect(r.lines[0]!.sources[0]!.label).toContain('limited to allowances made');
  });

  it('makes no balancing charge on proceeds under €2,000, and says to check the buyer (s.288(3B))', () => {
    asset({ baseCostMinor: 10_000, costMinor: 10_000, disposalDate: '2027-06-01', disposalProceedsMinor: 150_000 });
    const r = in2027();
    expect(r.lines).toEqual([]);
    expect(r.findings.some((f) => f.includes('s.288(3B)'))).toBe(true);
  });

  it('refuses to guess missing proceeds', () => {
    asset({ disposalDate: '2027-06-01' });
    const r = in2027();
    expect(r.lines).toEqual([]);
    expect(r.findings.some((f) => f.includes('no proceeds are recorded'))).toBe(true);
  });

  it('scales wear and tear for a short accounting period (s.284(2)(b))', () => {
    asset({ purchaseDate: '2025-08-01' });
    const r = capitalAllowances(db, { companyId, from: '2025-07-01', to: '2025-12-31' });
    // 100,000 x 184/365.
    expect(line(r, 'wear and tear')).toBe(-50_411);
  });

  it('flags a 100% claim as needing the SEAI list (s.285A), and leaves intangibles to s.291A', () => {
    asset({ capitalAllowanceRateBasisPoints: 10_000, capitalAllowanceYears: 1, purchaseDate: '2027-02-01' });
    asset({ name: 'Brand licence', assetCategory: 'intangible', purchaseDate: '2027-02-01' });
    const r = in2027();
    expect(line(r, 'wear and tear')).toBe(-800_000);
    expect(r.lines[0]!.citations.map((c) => c.ruleKey)).toContain('ct.accelerated_energy_efficient');
    expect(r.findings.some((f) => f.includes('SEAI'))).toBe(true);
    expect(r.findings.some((f) => f.includes('s.291A'))).toBe(true);
  });
});

describe('motor cars (TCA Part 11, ss.373 and 374)', () => {
  const car = (over: Partial<typeof fixedAssets.$inferInsert> = {}) => {
    const id = ids.fixedAsset();
    db.insert(fixedAssets).values({
      id, companyId, name: 'Director car', assetCategory: 'motor_vehicles', purchaseDate: '2025-03-01',
      costMinor: 800_000, currency: 'EUR', baseCostMinor: 800_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active', ...over,
    }).run();
    return id;
  };
  const inYear = (y: number) => capitalAllowances(db, { companyId, from: `${y}-01-01`, to: `${y}-12-31` });
  const line = (r: ReturnType<typeof inYear>, label: string) => r.lines.find((l) => l.label.includes(label))?.amountMinor;

  it('restricts a car over the specified amount to €24,000 of cost (s.373(2), s.374(1))', () => {
    car({ costMinor: 3_000_000, baseCostMinor: 3_000_000 });
    const r = inYear(2025);
    expect(line(r, 'wear and tear')).toBe(-300_000);
    expect(r.lines[0]!.sources[0]!.label).toContain('24000.00');
    expect(r.lines[0]!.citations.map((c) => c.ruleKey)).toContain('ct.car_allowances_restricted_to_specified_amount');
    expect(r.lines[0]!.citations.map((c) => c.section)).toContain('TCA 1997 s.374');
    expect(r.findings.some((f) => f.includes('specified amount') && f.includes('374(1)'))).toBe(true);
  });

  it('computes a restricted car\'s balancing adjustment on the specified amount and scaled proceeds (s.374(2), (3))', () => {
    // Cost €30,000 restricted to €24,000; allowances made 2025–2026: €6,000; disposed of 2027 for €20,000,
    // scaled to €16,000 (24,000/30,000); unallowed €18,000: a balancing allowance of €2,000.
    car({ costMinor: 3_000_000, baseCostMinor: 3_000_000, disposalDate: '2027-06-01', disposalProceedsMinor: 2_000_000 });
    const r = inYear(2027);
    expect(line(r, 'balancing allowances')).toBe(-200_000);
    expect(r.lines[0]!.sources[0]!.label).toContain('scaled down, s.374(3)');
    expect(r.lines[0]!.citations.map((c) => c.ruleKey)).toContain('ct.car_disposal_proceeds_scaled_down');
  });

  it('gives a car under the specified amount its allowances on cost, with nothing flagged', () => {
    car({ costMinor: 2_000_000, baseCostMinor: 2_000_000 });
    const r = inYear(2025);
    expect(line(r, 'wear and tear')).toBe(-250_000);
    expect(r.findings.some((f) => f.includes('specified amount') || f.includes('s.373(1)'))).toBe(false);
  });

  it('leaves a commercial vehicle unrestricted and asks to confirm it is not a car (s.373(1))', () => {
    car({ name: 'Delivery van', costMinor: 3_000_000, baseCostMinor: 3_000_000 });
    const r = inYear(2025);
    expect(line(r, 'wear and tear')).toBe(-375_000);
    expect(r.findings.some((f) => f.includes('s.373(1)'))).toBe(true);
  });

  it('uses the €22,000 specified amount for a car bought in an accounting period ending 2002–2005', () => {
    car({ purchaseDate: '2005-03-01', costMinor: 3_000_000, baseCostMinor: 3_000_000 });
    const r = inYear(2005);
    expect(line(r, 'wear and tear')).toBe(-275_000);
    expect(r.lines[0]!.citations.map((c) => c.ruleKey)).toContain('ct.car_specified_amount_2002_to_2005');
  });

  it('refuses wear and tear for a period the curated rate does not cover, rather than charging 12.5% (issue #492)', () => {
    // A car bought in 1999: the 12.5%-over-8-years regime is curated from
    // 4 December 2002, so it did not apply. The old code charged it anyway —
    // the exact failure the window check exists to end.
    car({ purchaseDate: '1999-03-01', costMinor: 3_000_000, baseCostMinor: 3_000_000 });
    expect(() => inYear(1999)).toThrow(/ct.wear_and_tear_rate/);
    expect(() => inYear(1999)).toThrow(/does not cover the period/);
  });
  it('flags a car bought from July 2008: its CO2 emissions restriction (Chapter 1A) is not applied', () => {
    car({ costMinor: 2_000_000, baseCostMinor: 2_000_000 });
    expect(inYear(2025).findings.some((f) => f.includes('Chapter 1A'))).toBe(true);
  });

  it('does not raise the emissions question for a van or a car bought before July 2008', () => {
    car({ name: 'Delivery van' });
    car({ purchaseDate: '2005-03-01' });
    expect(inYear(2005).findings.some((f) => f.includes('Chapter 1A'))).toBe(false);
    expect(inYear(2025).findings.filter((f) => f.includes('Chapter 1A'))).toEqual([]);
  });
});

describe('loss relief', () => {
  const inYear = (y: number) => computeCorporationTax(db, { companyId, from: asIsoDate(`${y}-01-01`), to: asIsoDate(`${y}-12-31`) });

  it('carries a loss forward against the next period\'s trading profit (s.396(1))', () => {
    post('6070', 200_000, 'Setup costs', '2025-03-01');
    post('4020', 500_000, 'Consulting', '2026-03-01');
    const c = inYear(2026);
    expect(c.losses.broughtForwardUsedMinor).toBe(200_000);
    expect(c.tradingProfitMinor).toBe(300_000);
    expect(c.corporationTaxMinor).toBe(37_500);
    expect(c.lines.find((l) => l.label.includes('brought forward'))!.citations[0]!.section).toBe('TCA 1997 s.396');
  });

  it('sets a claimed loss back against the preceding period (s.396A)', () => {
    post('4020', 300_000, 'Consulting', '2025-03-01');
    post('6070', 100_000, 'Costs', '2026-03-01');
    recordCtDecision(db, { companyId, subjectType: 'loss_claim', subjectId: companyId, periodEnd: '2026-12-31', choice: 'claim_396a', decidedBy: 'Director' });
    expect(inYear(2025)).toMatchObject({ tradingProfitMinor: 200_000, corporationTaxMinor: 25_000, losses: { carriedBackInMinor: 100_000 } });
    expect(inYear(2026).losses).toMatchObject({ setBackMinor: 100_000, carriedForwardMinor: 0 });
  });

  it('relieves what is left on a value basis against tax on other income (s.396B)', () => {
    post('4020', 300_000, 'Consulting', '2025-03-01');
    post('6070', 700_000, 'Costs', '2026-03-01');
    post('4090', 100_000, 'Deposit interest', '2026-06-01');
    recordCtDecision(db, { companyId, subjectType: 'loss_claim', subjectId: companyId, periodEnd: '2026-12-31', choice: 'claim_396a_396b', decidedBy: 'Director' });
    const c = inYear(2026);
    // Loss 700,000 (the interest is taken out of trading): 300,000 set back, then 12.5% of the rest against the 25,000 on the interest.
    expect(c.losses).toMatchObject({ setBackMinor: 300_000, valueBasisCreditMinor: 25_000, carriedForwardMinor: 200_000 });
    expect(c.corporationTaxMinor).toBe(0);
  });
});

describe('close company surcharge', () => {
  it('matches Revenue\'s s.440 example: 20%, nothing up to €2,000, marginal relief above', () => {
    // The rates are arguments, never defaults (issue #490): 20% and the 80% cap.
    expect(section440Surcharge(3_000_000, 0, 200_000, 2000, 8000)).toBe(600_000);
    expect(section440Surcharge(3_000_000, 2_850_000, 200_000, 2000, 8000)).toBe(0);
    expect(section440Surcharge(3_000_000, 2_760_000, 200_000, 2000, 8000)).toBe(32_000);
  });

  it('matches Revenue\'s s.441 example 1 for a service company', () => {
    expect(section441Surcharge(700_000, 1_000_000, 600_000, 2000, 1500))
      .toEqual({ total: 600_000, at20: 100_000, at15: 500_000, surchargeMinor: 95_000 });
  });

  it('suggests close company status and computes the surcharge on undistributed deposit interest', () => {
    post('4020', 1_000_000, 'Consulting');
    post('4090', 800_000, 'Deposit interest');
    const c = ct();
    expect(c.decisions.find((d) => d.subjectType === 'company_status')!.suggested).toBe('close_trading');
    // 800,000 less 25% tax = 600,000, less 7.5% (a trading company) = 555,000; 20% = 111,000.
    expect(c.surcharge).toMatchObject({ distributableInvestmentIncomeMinor: 555_000, surchargeMinor: 111_000 });
    recordCtDecision(db, { companyId, subjectType: 'company_status', subjectId: companyId, periodEnd: to, choice: 'not_close', decidedBy: 'Director' });
    expect(ct().surcharge.surchargeMinor).toBe(0);
  });
});

describe('dates', () => {
  it('gives the CT1 date and one preliminary tax payment for a small company', () => {
    post('4020', 1_000_000, 'Consulting', '2025-06-15');
    post('4020', 1_000_000, 'Consulting', '2026-06-15');
    const c = computeCorporationTax(db, { companyId, from: asIsoDate('2026-01-01'), to: asIsoDate('2026-12-31') });
    expect(c.dates.returnDueDate).toBe('2027-09-23');
    expect(c.dates.smallCompany).toBe(true);
    expect(c.dates.precedingPeriodTaxMinor).toBe(125_000);
    expect(c.dates.preliminaryTax).toEqual([{ dueDate: '2026-11-23', amountMinor: 112_500, basis: "the lower of 90% of this period's tax and 100% of the preceding period's" }]);
  });

  it('gives a first period with tax under €200,000 nil preliminary tax (s.959AN(4), issue #284)', () => {
    post('4020', 40_000_000, 'Consulting');
    const c = ct();
    expect(c.corporationTaxMinor).toBe(5_000_000);
    expect(c.dates.preliminaryTax).toEqual([{
      dueDate: '2025-11-23', amountMinor: 0,
      basis: "nil: the company's first accounting period, with tax of 50000.00 under the 200000.00 limit",
    }]);
    expect(c.dates.citations.map((x) => x.ruleKey)).toContain('ct.preliminary_tax_first_period_nil');
    expect(c.dates.citations.find((x) => x.ruleKey === 'ct.preliminary_tax_first_period_nil')!.section).toBe('TCA 1997 s.959AN');
    expect(c.findings.some((f) => f.includes('first ever'))).toBe(true);
  });

  it('treats a first period with tax over €200,000 as large: instalments, not nil (issue #284)', () => {
    post('4020', 200_000_000, 'Consulting');
    const c = ct();
    expect(c.corporationTaxMinor).toBe(25_000_000);
    expect(c.dates.smallCompany).toBe(false);
    expect(c.dates.preliminaryTax.map((p) => [p.dueDate, p.amountMinor])).toEqual([['2025-06-23', 11_250_000], ['2025-11-23', 11_250_000]]);
  });

  it('splits preliminary tax in two once the preceding period\'s tax reached €200,000 (s.959AS)', () => {
    post('4020', 200_000_000, 'Consulting', '2025-03-01');
    post('4020', 200_000_000, 'Consulting', '2026-03-01');
    const c = computeCorporationTax(db, { companyId, from: asIsoDate('2026-01-01'), to: asIsoDate('2026-12-31') });
    expect(c.dates.smallCompany).toBe(false);
    expect(c.dates.preliminaryTax.map((p) => [p.dueDate, p.amountMinor])).toEqual([['2026-06-23', 11_250_000], ['2026-11-23', 11_250_000]]);
  });
});

describe('accounting periods and allowances (#488, #491, #495)', () => {
  it('reconstructs nothing: a short first period\'s scaled claim is what later periods build on (issue #488)', () => {
    // The books start 1 July 2025 (a 184-day first period) and the asset is
    // disposed of in the ninth period for €60,000. Hand-worked:
    //   period 1 (184/365 of €10,000)  =      €5,041.10
    //   periods 2–8 (7 full years)     =     €70,000.00
    //   made before disposal           =     €75,041.10
    //   unallowed cost                 =      €4,958.90
    //   balancing charge = min(60,000 − 4,958.90, 75,041.10) = €55,041.10
    // The old code reconstructed madeBefore as 8 × €10,000 = the full cost,
    // leaving nothing unallowed and charging the whole €60,000.
    const created = createCompany(db, { legalName: 'Short First Ltd', vatRegistrationStatus: 'registered', seedYears: [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033] });
    const short = created.companyId;
    const assetId = ids.fixedAsset();
    db.insert(fixedAssets).values({
      id: assetId, companyId: short, name: 'Machine', assetCategory: 'plant_machinery',
      purchaseDate: '2025-07-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
      disposalDate: '2033-06-01', disposalProceedsMinor: 6_000_000,
    }).run();
    postJournalEntry(db, {
      companyId: short, entryDate: asIsoDate('2025-07-01'), narrative: 'Purchase of machine', sourceType: 'fixed_asset',
      sourceId: assetId, baseCurrency: 'EUR',
      lines: [
        { accountId: created.accountsByKey['computer_equipment']!, debitMinor: 8_000_000 },
        { accountId: created.accountsByKey['bank_control']!, creditMinor: 8_000_000 },
      ],
    });

    const c = computeCorporationTax(db, { companyId: short, from: asIsoDate('2033-01-01'), to: asIsoDate('2033-12-31') });
    const charge = c.lines.find((l) => l.label === 'Add: balancing charges')!;
    expect(charge.amountMinor).toBe(5_504_110);
    expect(charge.sources[0]!.label).toContain('proceeds 60000.00 less unallowed 4958.90');
  });

  it('counts the purchase-year claim once for a 29 February year end (issue #491)', () => {
    // The purchase period ends 29 February 2024; the next one ends
    // 28 February 2025. Comparing the raw month-day strings put the second
    // period at "year 1 of 8" again — a full year's allowance miscounted.
    const created = createCompany(db, {
      legalName: 'Leap Year Ltd', vatRegistrationStatus: 'registered',
      financialYearEndDay: 29, financialYearEndMonth: 2, seedYears: [2023, 2024, 2025],
    });
    const leap = created.companyId;
    db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: leap, name: 'Van', assetCategory: 'motor_vehicles',
      purchaseDate: '2023-07-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    const r = capitalAllowances(db, { companyId: leap, from: '2024-03-01', to: '2025-02-28' });
    const line = r.lines.find((l) => l.label.includes('wear and tear'))!;
    // The second period's claim is year 2, not the purchase year again. The
    // amount is the annual allowance scaled for the period: the year spanning
    // 29 February 2024 measures 366 days against this period's 365 (the same
    // s.284(2)(b) scaling every period gets).
    expect(line.sources[0]!.label).toContain('year 2 of 8');
    expect(line.amountMinor).toBe(-997_268);
  });

  it('refuses an accounting period longer than 12 months, rather than capping its thresholds (issue #495)', () => {
    post('4020', 10_000_000, 'Consulting');
    expect(() => computeCorporationTax(db, { companyId, from: asIsoDate('2024-01-01'), to: asIsoDate('2025-03-31') }))
      .toThrow(/longer than the 12 months TCA s\.955 permits/);
    // The refusal wrote nothing.
    expect(db.select().from(ctDecisions).all()).toHaveLength(0);
  });
});

describe('the close company surcharge\'s inputs (#489, #494)', () => {
  it('reads distributions from the dividends account by its system key, whatever its code is (issue #489)', () => {
    // A migrated chart whose dividends account is not code 3200.
    db.update(accounts).set({ code: '3900' }).where(eq(accounts.id, byCode['3200']!)).run();
    post('4090', 10_000_000, 'Deposit interest');
    postJournalEntry(db, {
      companyId, entryDate: asIsoDate('2025-06-20'), narrative: 'Dividend paid', sourceType: 'manual_adjustment',
      sourceId: 'div-1', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['3200']!, debitMinor: 2_000_000 },
        { accountId: byKey['bank_control']!, creditMinor: 2_000_000 },
      ],
    });

    const c = ct();
    expect(c.surcharge.distributionsMinor).toBe(2_000_000);
    // The distributions themselves raise no finding — only the (undecided)
    // trading-company suggestion does, which is #494's to answer.
    expect(c.surcharge.findings.some((f) => f.includes('dividends'))).toBe(false);
    // The s.440 working counts the distributions against the distributable
    // investment income.
    expect(c.surcharge.working).toContain('− distributions 20000.00');
  });

  it('says when no dividends account exists instead of silently computing on nil distributions (issue #489)', () => {
    db.update(accounts)
      .set({ code: '9999', systemKey: null, isSystem: false })
      .where(eq(accounts.id, byCode['3200']!)).run();
    post('4090', 10_000_000, 'Deposit interest');
    const c = ct();
    expect(c.surcharge.distributionsMinor).toBe(0);
    expect(c.findings.some((f) => f.includes('No dividends account') && f.includes('dividends_paid'))).toBe(true);
  });

  it('offers the trading-company test as a person\'s decision, suggested from the income split (issue #494)', () => {
    // One large deposit-interest year: the income split reads "not trading",
    // but a genuine trading company keeps the s.434(5A)(b) reduction once the
    // person records the facts test.
    post('4090', 10_000_000, 'Deposit interest');
    post('4020', 1_000_000, 'Consulting');
    const suggested = ct();
    const pending = suggested.decisions.find((d) => d.subjectType === 'trading_company')!;
    expect(pending.suggested).toBe('not_trading');
    expect(pending.reason).toContain('facts test');
    expect(suggested.surcharge.working).not.toContain('trading company reduction');
    expect(suggested.findings.some((f) => f.includes('s.434(5A)(b)') || f.includes('trading'))).toBe(true);

    recordCtDecision(db, {
      companyId, subjectType: 'trading_company', subjectId: companyId, periodEnd: to,
      choice: 'trading', decidedBy: 'Director',
    });
    const decided = ct();
    const decision = decided.decisions.find((d) => d.subjectType === 'trading_company')!;
    expect(decision.decided).toBe('trading');
    expect(decided.surcharge.working).toContain('after the 7.5% trading company reduction');
  });
});

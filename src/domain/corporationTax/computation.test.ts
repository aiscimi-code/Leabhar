import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeCorporationTax, recordCtDecision, CtDecisionError } from './computation';
import { fixedAssets, ctDecisions } from '@/db/schema';
import { asIsoDate } from '../dates';
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
    expect(c.findings.some((f) => f.includes('s.396'))).toBe(true);
  });
});

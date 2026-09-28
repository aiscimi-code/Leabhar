import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { accountingPeriods, employees } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { ids } from '@/lib/ids';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { asIsoDate } from '../dates';
import { profitAndLoss } from './financial';
import {
  BALANCE_SHEET_FORMAT_1, PROFIT_AND_LOSS_FORMAT_1, schedule3ABalanceSheet, schedule3AProfitAndLoss, mapAccountToFormatItem,
} from './schedule3A';
import { companySize, recordCompanySizeDecision } from './companySize';

/** Issue #554: Schedule 3A Format 1, and company size under ss.280A, 280D and 280F. */

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Méid Teoranta', seedYears: [2025, 2026] });
  ({ companyId } = created);
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
});

type Line = { accountId: string; debitMinor?: number; creditMinor?: number };
const post = (date: string, lines: Line[]) =>
  postJournalEntry(db, { companyId, entryDate: asIsoDate(date), narrative: 'Test', sourceType: 'manual_adjustment', baseCurrency: 'EUR', lines });
const d = asIsoDate;

describe('Schedule 3A, Format 1', () => {
  it('quotes every heading from the Schedule as captured', () => {
    const text = readFileSync('docs/statutes/companies-act-2014/schedule-3A.md', 'utf8').replace(/\s+/g, ' ');
    for (const item of [...BALANCE_SHEET_FORMAT_1, ...PROFIT_AND_LOSS_FORMAT_1]) {
      expect(text, item.code).toContain(item.heading);
    }
  });

  it('lays the ledger out under the format, with totals equal to the ledger, and no offsetting', () => {
    post('2025-01-02', [{ accountId: acc['bank_control']!, debitMinor: 1_000_000 }, { accountId: acc['share_capital']!, creditMinor: 1_000_000 }]);
    post('2025-06-01', [{ accountId: acc['bank_control']!, debitMinor: 100_000 }, { accountId: byCode['4020']!, creditMinor: 100_000 }]);
    post('2026-02-01', [{ accountId: acc['debtors']!, debitMinor: 500_000 }, { accountId: byCode['4020']!, creditMinor: 500_000 }]);
    post('2026-02-02', [{ accountId: byCode['6000']!, debitMinor: 100_000 }, { accountId: acc['bank_control']!, creditMinor: 100_000 }]);
    post('2026-02-03', [{ accountId: byCode['6060']!, debitMinor: 80_000 }, { accountId: acc['creditors']!, creditMinor: 80_000 }]);
    post('2026-02-04', [{ accountId: acc['directors_current_account']!, debitMinor: 50_000 }, { accountId: acc['bank_control']!, creditMinor: 50_000 }]);
    post('2026-02-05', [{ accountId: acc['bank_control']!, debitMinor: 400_000 }, { accountId: byCode['2210']!, creditMinor: 400_000 }]);

    const p = schedule3AProfitAndLoss(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    const item = (code: string) => p.lines.find((l) => l.code === code)?.amountMinor;
    expect([item('1'), item('5'), item('3'), item('16')]).toEqual([500_000, 180_000, 500_000, 320_000]);
    expect(p.ledgerProfitMinor).toBe(profitAndLoss(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') }).netProfit.valueMinor);
    expect(p.reconciles).toBe(true);

    const b = schedule3ABalanceSheet(db, { companyId, asOf: d('2026-12-31'), financialYearStart: d('2026-01-01') });
    const line = (code: string) => b.lines.find((l) => l.code === code);
    // The director owes the company: a debtor, not a negative creditor.
    expect(line('B.II.4')!.accounts[0]).toMatchObject({ amountMinor: 50_000, reclassifiedFrom: 'C.9' });
    expect(line('B.II.1')!.amountMinor).toBe(500_000);
    expect(line('B.IV')!.amountMinor).toBe(1_350_000);
    expect(line('C.5')!.amountMinor).toBe(80_000);
    expect(line('F.2')!.amountMinor).toBe(400_000);
    expect(line('H.I')!.amountMinor).toBe(1_000_000);
    // 2025's profit was never closed to reserves: brought forward, not this year's.
    expect(line('H.V')!.amountMinor).toBe(100_000);
    expect(line('H.VI')!.amountMinor).toBe(320_000);
    expect(b.totals).toMatchObject({ A: 0, B: 1_900_000, C: 80_000, D: 1_820_000, E: 1_820_000, F: 400_000, H: 1_420_000 });
    expect(b.balanceSheetTotalMinor).toBe(1_900_000);
    expect([b.ledgerNetAssetsMinor, b.differenceMinor, b.reconciles]).toEqual([1_420_000, 0, true]);
  });

  it('a person maps an account to another item from a date; earlier periods keep the default', () => {
    post('2025-03-01', [{ accountId: byCode['6040']!, debitMinor: 10_000 }, { accountId: acc['bank_control']!, creditMinor: 10_000 }]);
    post('2026-03-01', [{ accountId: byCode['6040']!, debitMinor: 20_000 }, { accountId: acc['bank_control']!, creditMinor: 20_000 }]);
    mapAccountToFormatItem(db, { companyId, accountId: byCode['6040']!, itemCode: '4', effectiveFrom: '2026-01-01', recordedBy: 'o', note: 'Advertising is a distribution cost' });
    const y26 = schedule3AProfitAndLoss(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    expect(y26.lines.find((l) => l.code === '4')!.accounts[0]).toMatchObject({ amountMinor: 20_000, source: 'mapped' });
    const y25 = schedule3AProfitAndLoss(db, { companyId, from: d('2025-01-01'), to: d('2025-12-31') });
    expect(y25.lines.find((l) => l.code === '5')!.accounts[0]).toMatchObject({ amountMinor: 10_000, source: 'default' });
    expect(() => mapAccountToFormatItem(db, { companyId, accountId: byCode['6040']!, itemCode: 'B.II.4', effectiveFrom: '2026-01-01', recordedBy: 'o' }))
      .toThrow(/not a profit and loss item/);
    expect(() => mapAccountToFormatItem(db, { companyId, accountId: acc['debtors']!, itemCode: 'D', effectiveFrom: '2026-01-01', recordedBy: 'o' }))
      .toThrow(/not a balance sheet item/);
  });
});

describe('company size (ss.280A, 280D, 280F)', () => {
  const sale = (date: string, amount: number) => post(date, [{ accountId: acc['bank_control']!, debitMinor: amount }, { accountId: byCode['4020']!, creditMinor: amount }]);

  it('a first financial year is sized on its own figures; an unanswered exclusion is an open point', () => {
    sale('2026-03-01', 500_000);
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'prior_year_size', choice: 'first_financial_year', decidedBy: 'o' });
    let r = companySize(db, { companyId, financialYearEnd: '2026-12-31' });
    // Turnover and balance sheet within the micro limits; no employees known, which cannot change two limbs met.
    expect([r.size, r.status, r.firstFinancialYear]).toEqual(['micro', 'needs_decision', true]);
    expect(r.openPoints.join(' ')).toMatch(/whether an exclusion applies/);
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'exclusion', choice: 'none', decidedBy: 'o' });
    r = companySize(db, { companyId, financialYearEnd: '2026-12-31' });
    expect([r.size, r.status]).toEqual(['micro', 'classified']);
    expect(r.consequence).toMatch(/micro companies regime/);
    // An investment undertaking cannot be micro: small instead.
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'exclusion', choice: 'investment_undertaking', decidedBy: 'o' });
    expect(companySize(db, { companyId, financialYearEnd: '2026-12-31' }).size).toBe('small');
  });

  it('keeps a size for a year its figures exceed, under the two-year rule', () => {
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2025-12-31', kind: 'exclusion', choice: 'none', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2025-12-31', kind: 'prior_year_size', choice: 'small', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2025-12-31', kind: 'prior_year_conditions', choice: 'small', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2025-12-31', kind: 'average_employees', count: 20, note: 'Monthly headcount, averaged', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'average_employees', count: 20, note: 'Monthly headcount, averaged', decidedBy: 'o' });
    sale('2025-06-01', 1_000_000_000);  // €10m: within the small limits.
    sale('2026-06-01', 1_000_000_000);  // Another €10m in 2026, and €20m in the bank: over the small balance sheet limit.
    const y25 = companySize(db, { companyId, financialYearEnd: '2025-12-31' });
    expect(y25.size).toBe('small');
    // 2026: turnover €10m is within €15m but the balance sheet (€20m) is over €7.5m; employees 20 ≤ 50, so still 2 of 3.
    expect(companySize(db, { companyId, financialYearEnd: '2026-12-31' }).size).toBe('small');
    // With 60 employees, 2026 meets only one limb; 2025 met the conditions and qualified, so 2026 stays small.
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'average_employees', count: 60, note: 'Recount', decidedBy: 'o' });
    const y26 = companySize(db, { companyId, financialYearEnd: '2026-12-31' });
    expect([y26.size, y26.year.conditions!.find((c) => c.size === 'small')!.met]).toEqual(['small', false]);
    expect(y26.basis.find((b) => b.startsWith('small'))).toMatch(/qualifies under the two-year rule/);
  });

  it('takes the average number of employees from payroll, month by month, when none is recorded', () => {
    // Two staff for the whole year, a third for three months: (12 + 12 + 3) / 12.
    for (const n of [1, 2]) {
      db.insert(employees).values({ id: ids.employee(), companyId, firstName: 'A', lastName: String(n), employerReference: `E${n}`, employmentId: String(n), startDate: '2025-01-01', payFrequency: 'monthly', recordedBy: 'o' }).run();
    }
    db.insert(employees).values({ id: ids.employee(), companyId, firstName: 'B', lastName: '3', employerReference: 'E3', employmentId: '3', startDate: '2026-03-15', leftOn: '2026-05-02', payFrequency: 'monthly', recordedBy: 'o' }).run();
    expect(companySize(db, { companyId, financialYearEnd: '2026-12-31' }).year.employees).toMatchObject({ average: 2.25, employeeMonths: 27, months: 12, source: 'payroll' });
  });

  it('the year before, missing from the books, is needed when this year\'s figures are over', () => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Nua Teoranta', seedYears: [2026] });
    ({ companyId } = created);
    acc = created.accountsByKey;
    byCode = created.accountsByCode;
    sale('2026-03-01', 1_000_000_000);
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'exclusion', choice: 'none', decidedBy: 'o' });
    const r = companySize(db, { companyId, financialYearEnd: '2026-12-31' });
    expect([r.size, r.status]).toEqual([null, 'needs_decision']);
    expect(r.openPoints.join(' ')).toMatch(/year before is not in these books/);
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'prior_year_size', choice: 'medium', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2026-12-31', kind: 'prior_year_conditions', choice: 'medium', decidedBy: 'o' });
    expect(companySize(db, { companyId, financialYearEnd: '2026-12-31' }).size).toBe('medium');
  });

  it('adjusts the turnover limb for a financial year that is not a year', () => {
    db.insert(accountingPeriods).values({ id: ids.accountingPeriod(), companyId, kind: 'financial_year', name: 'Short', startDate: '2027-01-01', endDate: '2027-06-30' }).run();
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2027-06-30', kind: 'prior_year_size', choice: 'first_financial_year', decidedBy: 'o' });
    sale('2027-02-01', 50_000_000); // €500,000 in six months: over €900,000 × 181/365.
    const limb = companySize(db, { companyId, financialYearEnd: '2027-06-30' }).year.conditions!.find((c) => c.size === 'micro')!.limbs[0]!;
    expect(limb).toMatchObject({ appliedThreshold: 44_630_136, met: false });
  });

  it('applies the figures S.I. 301/2024 replaced to a year it does not reach, and follows the s.280I election (#555)', () => {
    for (const y of [2023, 2024, 2016]) {
      db.insert(accountingPeriods).values({ id: ids.accountingPeriod(), companyId, kind: 'financial_year', name: `FY${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31` }).run();
    }
    sale('2023-03-01', 1_300_000_000); // €13m: over the old €12m small limit, within the new €15m.
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2023-12-31', kind: 'prior_year_size', choice: 'first_financial_year', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2023-12-31', kind: 'exclusion', choice: 'none', decidedBy: 'o' });
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2023-12-31', kind: 'average_employees', count: 12, note: 'Monthly headcount', decidedBy: 'o' });
    const limbOf = (r: ReturnType<typeof companySize>) => r.year.conditions!.find((c) => c.size === 'small')!.limbs[0]!;
    // No election: a year beginning in 2023 takes the figures before the substitution, and says so.
    let r = companySize(db, { companyId, financialYearEnd: '2023-12-31' });
    expect([r.year.criteria, limbOf(r).ruleKey, limbOf(r).threshold, limbOf(r).met]).toEqual(['before_2024', 'company.small_company_turnover_threshold_pre_2024', 1_200_000_000, false]);
    expect(r.status).toBe('needs_decision');
    expect(r.openPoints.join(' ')).toMatch(/s\.280I/);
    // Elected from 2023: the substituted €15m applies.
    recordCompanySizeDecision(db, { companyId, financialYearEnd: '2023-12-31', kind: 'size_criteria_election', choice: 'fy_from_2023', decidedBy: 'o', note: 'Directors\' election' });
    r = companySize(db, { companyId, financialYearEnd: '2023-12-31' });
    // Turnover now within the limit, employees within, balance sheet (€13m) over: 2 of 3, small.
    expect([r.year.criteria, limbOf(r).threshold, limbOf(r).met, r.status, r.size]).toEqual(['as_substituted_2024', 1_500_000_000, true, 'classified', 'small']);
    // A year beginning in 2024 takes the substituted figures whatever the election; employees are never amended.
    expect(companySize(db, { companyId, financialYearEnd: '2024-12-31' }).year.criteria).toBe('as_substituted_2024');
    expect(companySize(db, { companyId, financialYearEnd: '2023-12-31' }).year.conditions!.find((c) => c.size === 'small')!.limbs[2]!.threshold).toBe(50);
    expect(() => recordCompanySizeDecision(db, { companyId, financialYearEnd: '2023-12-31', kind: 'size_criteria_election', choice: '2022', decidedBy: 'o' }))
      .toThrow(/fy_from_2024, fy_from_2023/);
    // Before the 2017 insertion there are no figures held.
    expect(companySize(db, { companyId, financialYearEnd: '2016-12-31' }).status).toBe('no_thresholds');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany, ensureDefaultAccounts } from './setup';
import { postJournalEntry } from '../accounting/journal';
import { profitAndLoss, balanceSheet } from '../reports/financial';
import { DEFAULT_ACCOUNTS, normalBalance, signedBalance } from './chartOfAccounts';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate, type IsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;

const FY_START = makeDate(2025, 1, 1);
const FY_END = makeDate(2025, 12, 31);

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2024, 2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
});

const post = (lines: Array<{ accountId: string; debitMinor?: number; creditMinor?: number }>,
              date: IsoDate = makeDate(2025, 6, 15), narrative = 'Test') =>
  postJournalEntry(db, {
    companyId, entryDate: date, narrative, sourceType: 'manual_adjustment',
    baseCurrency: 'EUR', lines,
  });

describe('the default chart (EPIC 04, issues #357, #358, #359)', () => {
  it('gives every account a unique code and a report section a report reads', () => {
    const codes = new Set(DEFAULT_ACCOUNTS.map((a) => a.code));
    expect(codes.size).toBe(DEFAULT_ACCOUNTS.length);
    const seeded = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
    expect(seeded).toHaveLength(DEFAULT_ACCOUNTS.length);
    for (const account of seeded) {
      expect(account.reportSection, `${account.code} has no report section`).toBeTruthy();
    }
  });

  it('splits the payroll liabilities the payroll engine will post to (issue #357)', () => {
    // One account per statutory deduction, each addressable by systemKey, and
    // no combined PAYE/PRSI/USC account to blur them together.
    expect(byCode['2410']).toBeTruthy();
    expect(byCode['2420']).toBeTruthy();
    expect(byCode['2430']).toBeTruthy();
    expect(byCode['2440']).toBeTruthy();
    expect(byCode['2450']).toBeTruthy();
    expect(DEFAULT_ACCOUNTS.find((a) => a.code === '2400')).toBeUndefined();

    for (const key of ['paye_payable', 'usc_payable', 'prsi_payable', 'net_wages_payable', 'pension_payable']) {
      expect(acc[key], `system account ${key} missing`).toBeTruthy();
    }

    // A payroll run gross to net: gross wages expensed, each deduction held,
    // net pay owed to the employees. It balances.
    post([
      { accountId: byCode['6180']!, debitMinor: 300_000 },
      { accountId: byCode['2410']!, creditMinor: 50_000, memo: 'PAYE' },
      { accountId: byCode['2420']!, creditMinor: 15_000, memo: 'USC' },
      { accountId: byCode['2430']!, creditMinor: 12_000, memo: 'PRSI' },
      { accountId: byCode['2440']!, creditMinor: 223_000, memo: 'Net pay' },
    ]);
    expect(signedBalance('liability', 0, 50_000)).toBe(50_000);
  });

  it('keeps employer PRSI and employer pension as costs, not liabilities', () => {
    const prsi = db.select().from(accounts).where(eq(accounts.id, byCode['6190']!)).get();
    const pension = db.select().from(accounts).where(eq(accounts.id, byCode['6185']!)).get();
    expect(prsi?.type).toBe('expense');
    expect(prsi?.vatApplicable).toBe(false);
    expect(pension?.type).toBe('expense');
    expect(pension?.vatApplicable).toBe(false);
  });

  it('puts loan capital in non-current liabilities, interest below operating profit (issue #358)', () => {
    const loan = db.select().from(accounts).where(eq(accounts.id, byCode['2210']!)).get();
    const currentPortion = db.select().from(accounts).where(eq(accounts.id, byCode['2215']!)).get();
    const interest = db.select().from(accounts).where(eq(accounts.id, byCode['6710']!)).get();
    expect(loan?.subtype).toBe('non_current_liability');
    expect(loan?.reportSection).toBe('long_term_liabilities');
    expect(currentPortion?.reportSection).toBe('current_liabilities');
    expect(interest?.reportSection).toBe('finance_costs');

    // A drawdown and a repayment's interest half.
    post([
      { accountId: acc['bank_control']!, debitMinor: 500_000 },
      { accountId: byCode['2210']!, creditMinor: 500_000, memo: 'Loan drawdown' },
    ], makeDate(2025, 2, 1), 'Loan drawdown');
    post([
      { accountId: byCode['6710']!, debitMinor: 25_000, memo: 'Interest' },
      { accountId: acc['bank_control']!, creditMinor: 25_000 },
    ], makeDate(2025, 7, 1), 'Loan repayment — interest');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(pl.operatingProfit.valueMinor).toBe(0);
    expect(pl.financeCosts.valueMinor).toBe(25_000);
    expect(pl.netProfit.valueMinor).toBe(-25_000);

    const bs = balanceSheet(db, {
      companyId, asOf: FY_END, financialYearStart: FY_START,
    });
    expect(bs.longTermLiabilities.valueMinor).toBe(500_000);
    expect(bs.currentLiabilities.valueMinor).toBe(0);
    expect(bs.totalLiabilities.valueMinor).toBe(500_000);
    expect(bs.balances).toBe(true);
  });

  it('seeds stock accounts the opening/closing stock journals use (issue #359)', () => {
    const stock = db.select().from(accounts).where(eq(accounts.id, byCode['1300']!)).get();
    const resale = db.select().from(accounts).where(eq(accounts.id, byCode['5020']!)).get();
    expect(acc['stock_on_hand']).toBe(byCode['1300']);
    expect(stock?.type).toBe('asset');
    expect(stock?.subtype).toBe('current_asset');
    expect(resale?.type).toBe('expense');
    expect(resale?.subtype).toBe('cost_of_sales');

    // Opening stock journal: Dr stock / Cr retained-style equity, then closing
    // stock to cost of sales. Both land in the right sections.
    post([
      { accountId: byCode['1300']!, debitMinor: 40_000 },
      { accountId: byCode['5020']!, creditMinor: 40_000 },
    ], makeDate(2025, 12, 31), 'Closing stock');

    const bs = balanceSheet(db, { companyId, asOf: FY_END, financialYearStart: FY_START });
    expect(bs.currentAssets.valueMinor).toBe(40_000);
    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(pl.costOfSales.valueMinor).toBe(-40_000);
  });

  it('adds the new accounts to a book created before they existed (ensureDefaultAccounts)', () => {
    const before = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
    // Simulate a book created with an older, shorter chart: delete the
    // accounts this PR added.
    const addedCodes = ['1300', '2215', '2410', '2420', '2430', '2440', '2450', '5020', '6185', '6710'];
    for (const code of addedCodes) {
      const row = before.find((a) => a.code === code);
      db.delete(accounts).where(eq(accounts.id, row!.id)).run();
    }

    const { added } = ensureDefaultAccounts(db, companyId, 'test');
    expect(added.sort()).toEqual(addedCodes.slice().sort());

    // Nothing the user already had was touched: same names, same codes.
    const after = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
    expect(after).toHaveLength(before.length);
    for (const code of ['4000', '6180', '6190', '2210']) {
      const old = before.find((a) => a.code === code)!;
      const now = after.find((a) => a.code === code)!;
      expect(now.name).toBe(old.name);
      expect(now.id).toBe(old.id);
    }
  });
});

describe('normalBalance', () => {
  it('increases with a debit for assets and expenses, a credit for the rest', () => {
    expect(normalBalance('asset')).toBe('debit');
    expect(normalBalance('expense')).toBe('debit');
    expect(normalBalance('liability')).toBe('credit');
    expect(normalBalance('equity')).toBe('credit');
    expect(normalBalance('income')).toBe('credit');
    // An asset in credit is behaving abnormally: negative.
    expect(signedBalance('asset', 0, 100)).toBe(-100);
    expect(signedBalance('liability', 100, 0)).toBe(-100);
  });
});

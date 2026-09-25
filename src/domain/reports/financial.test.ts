import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount, systemAccountId } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { importStatement } from '../banking/import';
import { classifyTransaction } from '../banking/classify';
import { profitAndLoss, balanceSheet, explainAccount } from './financial';
import { flattenSources, renderExplanation } from './explain';
import { trialBalance } from '../accounting/ledger';
import { bankTransactions } from '@/db/schema';
import { makeDate, type IsoDate } from '../dates';
import { formatAmount } from '../money';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

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
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
});

const post = (lines: Array<{ accountId: string; debitMinor?: number; creditMinor?: number }>,
              date: IsoDate = makeDate(2025, 6, 15), narrative = 'Test') =>
  postJournalEntry(db, {
    companyId, entryDate: date, narrative, sourceType: 'manual_adjustment',
    baseCurrency: 'EUR', lines,
  });

const seedShareCapital = () =>
  post([
    { accountId: acc['bank_control']!, debitMinor: 10_000 },
    { accountId: acc['share_capital']!, creditMinor: 10_000 },
  ], makeDate(2025, 1, 2), 'Share capital subscribed');

describe('profitAndLoss', () => {
  it('computes revenue, expenses and net profit', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 500_000 },
      { accountId: byCode['4000']!, creditMinor: 500_000 },
    ], makeDate(2025, 3, 1), 'Software sales');
    post([
      { accountId: byCode['6010']!, debitMinor: 100_000 },
      { accountId: acc['bank_control']!, creditMinor: 100_000 },
    ], makeDate(2025, 4, 1), 'Hosting');
    post([
      { accountId: byCode['5000']!, debitMinor: 50_000 },
      { accountId: acc['bank_control']!, creditMinor: 50_000 },
    ], makeDate(2025, 4, 2), 'Direct costs');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(pl.revenue.valueMinor).toBe(500_000);
    expect(pl.costOfSales.valueMinor).toBe(50_000);
    expect(pl.grossProfit.valueMinor).toBe(450_000);
    expect(pl.operatingExpenses.valueMinor).toBe(100_000);
    expect(pl.netProfit.valueMinor).toBe(350_000);
  });

  it('respects the period boundaries', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 100_000 },
      { accountId: byCode['4000']!, creditMinor: 100_000 },
    ], makeDate(2024, 6, 1), 'Prior year sale');
    post([
      { accountId: acc['bank_control']!, debitMinor: 200_000 },
      { accountId: byCode['4000']!, creditMinor: 200_000 },
    ], makeDate(2025, 6, 1), 'This year sale');

    expect(profitAndLoss(db, { companyId, from: FY_START, to: FY_END }).revenue.valueMinor)
      .toBe(200_000);
  });

  it('explains each figure down to the accounts behind it', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 500_000 },
      { accountId: byCode['4000']!, creditMinor: 300_000 },
      { accountId: byCode['4010']!, creditMinor: 200_000 },
    ], makeDate(2025, 3, 1), 'Mixed revenue');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(pl.revenue.components).toHaveLength(2);
    expect(pl.revenue.components.map((c) => c.label)).toContain('4000 Software sales');
    expect(pl.revenue.method).toContain('trading income');
    expect(pl.netProfit.method).toContain('not the same as taxable profit');
  });

  it('keeps FX differences out of trading revenue', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 100_000 },
      { accountId: byCode['4000']!, creditMinor: 100_000 },
    ], makeDate(2025, 3, 1), 'Sale');
    post([
      { accountId: acc['bank_control']!, debitMinor: 5_000 },
      { accountId: acc['fx_gain_loss']!, creditMinor: 5_000 },
    ], makeDate(2025, 3, 2), 'FX gain');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(pl.revenue.valueMinor).toBe(100_000);
    expect(pl.otherIncome.valueMinor).toBe(5_000);
    expect(pl.netProfit.valueMinor).toBe(105_000);
  });
});

describe('balanceSheet', () => {
  it('balances on a simple set of books', () => {
    seedShareCapital();
    post([
      { accountId: acc['bank_control']!, debitMinor: 500_000 },
      { accountId: byCode['4000']!, creditMinor: 500_000 },
    ], makeDate(2025, 3, 1), 'Sale');
    post([
      { accountId: byCode['6010']!, debitMinor: 100_000 },
      { accountId: acc['bank_control']!, creditMinor: 100_000 },
    ], makeDate(2025, 4, 1), 'Hosting');

    const bs = balanceSheet(db, { companyId, asOf: FY_END, financialYearStart: FY_START });
    expect(bs.balances).toBe(true);
    expect(bs.differenceMinor).toBe(0);
    expect(bs.netAssets.valueMinor).toBe(bs.totalEquity.valueMinor);
    expect(bs.profitForPeriod.valueMinor).toBe(400_000);
    expect(bs.shareCapital.valueMinor).toBe(10_000);
  });

  // The test that catches engine bugs: balance from the journal lines alone,
  // over generated data, rather than from a hand-computed fixture.
  it('balances after arbitrary generated sequences of postings', () => {
    seedShareCapital();

    const expenseAccounts = ['6000', '6010', '6020', '6060', '6110', '6120'];
    const incomeAccounts = ['4000', '4010', '4020'];

    // Deterministic pseudo-random, so a failure is reproducible.
    let seed = 42;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };

    for (let i = 0; i < 200; i++) {
      const amount = 100 + next(500_000);
      const month = 1 + next(12);
      const day = 1 + next(28);
      const date = makeDate(2025, month, day);

      switch (next(5)) {
        case 0: { // Sale with VAT
          const vat = Math.round(amount * 0.23);
          post([
            { accountId: acc['bank_control']!, debitMinor: amount + vat },
            { accountId: byCode[incomeAccounts[next(incomeAccounts.length)]!]!, creditMinor: amount },
            { accountId: acc['vat_on_sales']!, creditMinor: vat },
          ], date, `Sale ${i}`);
          break;
        }
        case 1: { // Purchase with VAT
          const vat = Math.round(amount * 0.23);
          post([
            { accountId: byCode[expenseAccounts[next(expenseAccounts.length)]!]!, debitMinor: amount },
            { accountId: acc['vat_on_purchases']!, debitMinor: vat },
            { accountId: acc['bank_control']!, creditMinor: amount + vat },
          ], date, `Purchase ${i}`);
          break;
        }
        case 2: { // Director-paid expense
          post([
            { accountId: byCode[expenseAccounts[next(expenseAccounts.length)]!]!, debitMinor: amount },
            { accountId: acc['directors_current_account']!, creditMinor: amount },
          ], date, `Director paid ${i}`);
          break;
        }
        case 3: { // Fixed asset purchase
          post([
            { accountId: acc['computer_equipment']!, debitMinor: amount },
            { accountId: acc['bank_control']!, creditMinor: amount },
          ], date, `Asset ${i}`);
          break;
        }
        default: { // Invoice raised then settled
          post([
            { accountId: acc['debtors']!, debitMinor: amount },
            { accountId: byCode['4000']!, creditMinor: amount },
          ], date, `Invoice ${i}`);
          post([
            { accountId: acc['bank_control']!, debitMinor: amount },
            { accountId: acc['debtors']!, creditMinor: amount },
          ], date, `Settlement ${i}`);
        }
      }
    }

    const tb = trialBalance(db, { companyId, asOf: FY_END });
    expect(tb.balanced).toBe(true);

    const bs = balanceSheet(db, { companyId, asOf: FY_END, financialYearStart: FY_START });
    expect(bs.differenceMinor).toBe(0);
    expect(bs.balances).toBe(true);

    // And the two statements agree with each other.
    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    expect(bs.profitForPeriod.valueMinor).toBe(pl.netProfit.valueMinor);
  });

  it('balances mid-year, before any year-end close has run', () => {
    seedShareCapital();
    post([
      { accountId: acc['bank_control']!, debitMinor: 123_456 },
      { accountId: byCode['4000']!, creditMinor: 123_456 },
    ], makeDate(2025, 2, 1), 'Sale');

    const bs = balanceSheet(db, {
      companyId, asOf: makeDate(2025, 6, 30), financialYearStart: FY_START,
    });
    expect(bs.balances).toBe(true);
  });

  it('shows the director’s current account as a liability', () => {
    seedShareCapital();
    post([
      { accountId: byCode['6140']!, debitMinor: 20_000 },
      { accountId: acc['directors_current_account']!, creditMinor: 20_000 },
    ], makeDate(2025, 3, 1), 'Director paid for training');

    const bs = balanceSheet(db, { companyId, asOf: FY_END, financialYearStart: FY_START });
    const director = bs.currentLiabilities.components
      .find((c) => c.label.includes('current account'))!;
    expect(director.valueMinor).toBe(20_000);
    expect(bs.balances).toBe(true);
  });

  it('flags prior-year profit that has not been closed to reserves', () => {
    seedShareCapital();
    post([
      { accountId: acc['bank_control']!, debitMinor: 100_000 },
      { accountId: byCode['4000']!, creditMinor: 100_000 },
    ], makeDate(2024, 6, 1), 'Prior year sale');

    const bs = balanceSheet(db, { companyId, asOf: FY_END, financialYearStart: FY_START });
    expect(bs.retainedEarnings.valueMinor).toBe(100_000);
    expect(bs.retainedEarnings.notes.join(' ')).toContain('not been journalled into reserves');
    expect(bs.balances).toBe(true);
  });
});

describe('explainAccount', () => {
  it('drills from an account to the entries behind it', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 's.csv',
      content: 'Date,Description,Amount\n15/03/2025,VERCEL,-123.00',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    const tx = db.select().from(bankTransactions).get()!;
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });

    const explanation = explainAccount(db, {
      companyId, accountId: byCode['6010']!, to: FY_END,
    });

    // No invoice, so no input VAT: the whole payment is the cost (issue #203).
    expect(explanation.valueMinor).toBe(12_300);
    expect(explanation.sources).toHaveLength(1);
    // The source points at the bank transaction, so the UI can reach the document.
    expect(explanation.sources[0]!.entityType).toBe('bank_transaction');
    expect(explanation.sources[0]!.entityId).toBe(tx.id);
    expect(explanation.method).toContain('1 journal line');
  });

  it('flattens a whole report tree to its underlying records', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 100_000 },
      { accountId: byCode['4000']!, creditMinor: 100_000 },
    ], makeDate(2025, 3, 1), 'Sale');
    post([
      { accountId: byCode['6010']!, debitMinor: 30_000 },
      { accountId: acc['bank_control']!, creditMinor: 30_000 },
    ], makeDate(2025, 4, 1), 'Hosting');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    const sources = flattenSources(pl.netProfit);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.label.includes('4000'))).toBe(true);
    expect(sources.some((s) => s.label.includes('6010'))).toBe(true);
  });

  it('renders an explanation as readable text for the accountant pack', () => {
    post([
      { accountId: acc['bank_control']!, debitMinor: 100_000 },
      { accountId: byCode['4000']!, creditMinor: 100_000 },
    ], makeDate(2025, 3, 1), 'Sale');

    const pl = profitAndLoss(db, { companyId, from: FY_START, to: FY_END });
    const text = renderExplanation(pl.netProfit, formatAmount);
    expect(text).toContain('Net profit: 1000.00');
    expect(text).toContain('Revenue');
    expect(text).toContain('4000 Software sales');
  });
});

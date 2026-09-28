import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { customers, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany, addBankAccount } from '../config/setup';
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal';
import { createInvoice } from '../invoicing/invoices';
import { asIsoDate, type IsoDate } from '../dates';
import { cashFlowStatement } from './cashFlow';
import { comparativeStatements, priorYearPeriod, incomeExpenseByMonth, invoicesByParty } from './analysis';
import { profitAndLoss } from './financial';

/** Issue #553: cash flow, comparatives, income and expense analysis. */

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Sreabh Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
  ({ companyId } = created);
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'] });
});

type Line = { accountId: string; debitMinor?: number; creditMinor?: number };
const post = (date: string, lines: Line[], sourceType: 'manual_adjustment' | 'fixed_asset' | 'depreciation' = 'manual_adjustment') =>
  postJournalEntry(db, { companyId, entryDate: asIsoDate(date), narrative: 'Test', sourceType, baseCurrency: 'EUR', lines });
const d = (s: string) => s as IsoDate;

describe('cash flow statement, indirect method', () => {
  it('builds operating, investing and financing flows from ledger movements and reconciles to bank', () => {
    // Opening position in 2025: shares subscribed for €10,000.
    post('2025-01-02', [{ accountId: acc['bank_control']!, debitMinor: 1_000_000 }, { accountId: acc['share_capital']!, creditMinor: 1_000_000 }]);
    // 2026: a sale on credit €5,000, €3,000 of it received; costs €1,200 paid; €800 owed to a supplier.
    post('2026-02-01', [{ accountId: acc['debtors']!, debitMinor: 500_000 }, { accountId: byCode['4020']!, creditMinor: 500_000 }]);
    post('2026-03-01', [{ accountId: acc['bank_control']!, debitMinor: 300_000 }, { accountId: acc['debtors']!, creditMinor: 300_000 }]);
    post('2026-03-02', [{ accountId: byCode['6000']!, debitMinor: 120_000 }, { accountId: acc['bank_control']!, creditMinor: 120_000 }]);
    post('2026-03-03', [{ accountId: byCode['6060']!, debitMinor: 80_000 }, { accountId: acc['creditors']!, creditMinor: 80_000 }]);
    // A laptop €2,000 bought, depreciated €500, a loan of €4,000 drawn, a dividend of €1,000 paid.
    post('2026-04-01', [{ accountId: acc['computer_equipment']!, debitMinor: 200_000 }, { accountId: acc['bank_control']!, creditMinor: 200_000 }], 'fixed_asset');
    post('2026-12-31', [{ accountId: acc['depreciation_expense']!, debitMinor: 50_000 }, { accountId: acc['accumulated_depreciation']!, creditMinor: 50_000 }], 'depreciation');
    post('2026-05-01', [{ accountId: acc['bank_control']!, debitMinor: 400_000 }, { accountId: byCode['2210']!, creditMinor: 400_000 }]);
    post('2026-06-01', [{ accountId: acc['dividends_paid']!, debitMinor: 100_000 }, { accountId: acc['bank_control']!, creditMinor: 100_000 }]);
    // An older laptop (cost €1,000, depreciated €600) sold for €300: a €100 loss.
    post('2025-06-01', [{ accountId: acc['computer_equipment']!, debitMinor: 100_000 }, { accountId: acc['bank_control']!, creditMinor: 100_000 }], 'fixed_asset');
    post('2025-12-31', [{ accountId: acc['depreciation_expense']!, debitMinor: 60_000 }, { accountId: acc['accumulated_depreciation']!, creditMinor: 60_000 }], 'depreciation');
    post('2026-07-01', [
      { accountId: acc['bank_control']!, debitMinor: 30_000 }, { accountId: acc['accumulated_depreciation']!, debitMinor: 60_000 },
      { accountId: acc['disposal_of_assets']!, debitMinor: 10_000 }, { accountId: acc['computer_equipment']!, creditMinor: 100_000 },
    ], 'fixed_asset');

    const cf = cashFlowStatement(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    // Profit: 5,000 − 1,200 − 800 − 500 − 100 = 2,400.
    expect(cf.profitMinor).toBe(240_000);
    expect(cf.nonCashItems.map((l) => l.amountMinor)).toEqual([50_000, 10_000]);
    const wc = Object.fromEntries(cf.workingCapital.map((l) => [l.label, l.amountMinor]));
    expect(wc['(Increase)/decrease in 1100 Trade debtors']).toBe(-200_000);
    expect(wc['Increase/(decrease) in 2000 Trade creditors']).toBe(80_000);
    expect(cf.operating.totalMinor).toBe(240_000 + 60_000 - 200_000 + 80_000);
    expect(cf.investing.lines.map((l) => [l.label, l.amountMinor])).toEqual([
      ['Payments for fixed assets', -200_000], ['Proceeds from disposals of fixed assets', 30_000],
    ]);
    expect(cf.financing.lines.map((l) => l.amountMinor).sort((a, b) => a - b)).toEqual([-100_000, 400_000]);
    // Bank: 10,000 − 1,000 (2025 laptop) = 9,000 opening; + 3,000 − 1,200 − 2,000 + 4,000 − 1,000 + 300 = 12,100 closing.
    expect(cf.cash).toMatchObject({ openingMinor: 900_000, closingMinor: 1_210_000, movementMinor: 310_000 });
    expect(cf.netCashFlowMinor).toBe(310_000);
    expect(cf.reconciles).toBe(true);
  });

  it('a reversed disposal takes its proceeds back out, and the year-end close changes nothing', () => {
    post('2025-06-01', [{ accountId: acc['computer_equipment']!, debitMinor: 100_000 }, { accountId: acc['bank_control']!, creditMinor: 100_000 }], 'fixed_asset');
    const sale = post('2026-07-01', [{ accountId: acc['bank_control']!, debitMinor: 100_000 }, { accountId: acc['computer_equipment']!, creditMinor: 100_000 }], 'fixed_asset');
    reverseJournalEntry(db, { companyId, entryId: sale.id, reversalDate: asIsoDate('2026-07-02'), reason: 'Sale fell through' });
    const cf = cashFlowStatement(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    expect(cf.investing.lines).toEqual([]);
    expect([cf.netCashFlowMinor, cf.reconciles]).toEqual([0, true]);
  });

  it('flags a movement on suspense', () => {
    post('2026-02-01', [{ accountId: acc['bank_control']!, debitMinor: 5_000 }, { accountId: acc['suspense']!, creditMinor: 5_000 }]);
    const cf = cashFlowStatement(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    expect(cf.findings.join(' ')).toMatch(/Suspense is unclassified/);
    expect(cf.reconciles).toBe(true);
  });
});

describe('comparative periods', () => {
  it('sets the same period a year earlier, keeping month ends', () => {
    expect(priorYearPeriod(d('2024-03-01'), d('2025-02-28'))).toEqual({ from: '2023-03-01', to: '2024-02-29' });
    expect(priorYearPeriod(d('2026-01-01'), d('2026-06-15'))).toEqual({ from: '2025-01-01', to: '2025-06-15' });
  });

  it('shows each account beside its figure a year earlier, and the change', () => {
    post('2025-03-01', [{ accountId: acc['bank_control']!, debitMinor: 100_000 }, { accountId: byCode['4020']!, creditMinor: 100_000 }]);
    post('2026-03-01', [{ accountId: acc['bank_control']!, debitMinor: 150_000 }, { accountId: byCode['4020']!, creditMinor: 150_000 }]);
    post('2025-04-01', [{ accountId: byCode['6000']!, debitMinor: 20_000 }, { accountId: acc['bank_control']!, creditMinor: 20_000 }]);
    const c = comparativeStatements(db, { companyId, from: d('2026-01-01'), to: d('2026-12-31') });
    const pl = Object.fromEntries(c.profitAndLoss.map((r) => [r.label, r]));
    expect(pl['4020 Consulting income']).toMatchObject({ currentMinor: 150_000, priorMinor: 100_000, changeMinor: 50_000, depth: 1 });
    expect(pl['6000 Software and subscriptions']).toMatchObject({ currentMinor: 0, priorMinor: 20_000 });
    expect(pl['Net profit']).toMatchObject({ currentMinor: 150_000, priorMinor: 80_000 });
    const bs = Object.fromEntries(c.balanceSheet.map((r) => [r.label, r]));
    expect(bs['Net assets']).toMatchObject({ currentMinor: 230_000, priorMinor: 80_000 });
    expect(c.balances).toEqual({ current: true, prior: true });
  });
});

describe('income and expense analysis', () => {
  it('by account by month totals to the profit and loss account', () => {
    post('2026-01-10', [{ accountId: acc['bank_control']!, debitMinor: 100_000 }, { accountId: byCode['4020']!, creditMinor: 100_000 }]);
    post('2026-03-10', [{ accountId: acc['bank_control']!, debitMinor: 40_000 }, { accountId: byCode['4000']!, creditMinor: 40_000 }]);
    post('2026-03-11', [{ accountId: byCode['6000']!, debitMinor: 15_000 }, { accountId: acc['bank_control']!, creditMinor: 15_000 }]);
    const r = incomeExpenseByMonth(db, { companyId, from: d('2026-01-01'), to: d('2026-03-31') });
    expect(r.months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.income.map((a) => [a.code, a.byMonthMinor])).toEqual([['4000', [0, 0, 40_000]], ['4020', [100_000, 0, 0]]]);
    expect(r.netByMonthMinor).toEqual([100_000, 0, 25_000]);
    expect(r.netMinor).toBe(profitAndLoss(db, { companyId, from: d('2026-01-01'), to: d('2026-03-31') }).netProfit.valueMinor);
  });

  it('by customer and by supplier, from posted invoices, credit notes taken off', () => {
    const cust = ids.customer();
    db.insert(customers).values({ id: cust, companyId, name: 'Cliant', matchKey: 'cliant', countryCode: 'IE' }).run();
    const supp = ids.supplier();
    db.insert(suppliers).values({ id: supp, companyId, name: 'Soláthraí', matchKey: 'solathrai', countryCode: 'IE' }).run();
    const inv = createInvoice(db, { companyId, direction: 'sales', invoiceDate: asIsoDate('2026-02-01'), customerId: cust,
      lines: [{ description: 'Work', netMinor: 100_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] });
    createInvoice(db, { companyId, direction: 'sales', invoiceDate: asIsoDate('2026-02-05'), customerId: cust, isCreditNote: true, creditNoteOfId: inv.invoiceId,
      lines: [{ description: 'Credit', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] });
    createInvoice(db, { companyId, direction: 'purchase', invoiceDate: asIsoDate('2026-02-03'), supplierId: supp,
      lines: [{ description: 'Hosting', netMinor: 30_000, accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']! }] });
    const sales = invoicesByParty(db, { companyId, direction: 'sales', from: d('2026-01-01'), to: d('2026-12-31') });
    expect(sales.rows).toEqual([expect.objectContaining({ name: 'Cliant', invoiceCount: 1, creditNoteCount: 1, netMinor: 90_000 })]);
    expect(sales.total.netMinor).toBe(90_000);
    const purchases = invoicesByParty(db, { companyId, direction: 'purchase', from: d('2026-01-01'), to: d('2026-12-31') });
    expect(purchases.rows[0]).toMatchObject({ name: 'Soláthraí', netMinor: 30_000 });
  });
});

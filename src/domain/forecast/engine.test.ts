import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { customers, suppliers, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany, addBankAccount } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { buildVat3Return } from '../vat/report';
import { asIsoDate, type IsoDate } from '../dates';
import {
  assembleForecast, buildForecast, forecastDefaults, forecastOptions, occurrences, setForecastDefaults,
  createRecurringItem, updateRecurringItem, type ForecastLine, type ForecastOptions, type ForecastResult,
} from '.';

/** Issue #565: the cash forecast and its company defaults. */

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let cust: string;
let supp: string;
const d = (s: string) => s as IsoDate;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Sreabh Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
  ({ companyId } = created);
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'] });
  postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-01-02'), narrative: 'Capital', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: acc['bank_control']!, debitMinor: 1_000_000 }, { accountId: acc['share_capital']!, creditMinor: 1_000_000 }] });
  cust = ids.customer();
  db.insert(customers).values({ id: cust, companyId, name: 'Cliant', matchKey: 'cliant', countryCode: 'IE' }).run();
  supp = ids.supplier();
  db.insert(suppliers).values({ id: supp, companyId, name: 'Soláthraí', matchKey: 'solathrai', countryCode: 'IE' }).run();
});

const sale = (invoiceDate: string, dueDate: string, netMinor: number, extra: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, { companyId, direction: 'sales', invoiceDate: d(invoiceDate), dueDate: d(dueDate), customerId: cust,
    lines: [{ description: 'Work', netMinor, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }], ...extra });
const bill = (invoiceDate: string, dueDate: string, netMinor: number) =>
  createInvoice(db, { companyId, direction: 'purchase', invoiceDate: d(invoiceDate), dueDate: d(dueDate), supplierId: supp,
    documentId: insertConfirmedDocument(db, companyId), lines: [{ description: 'Hosting', netMinor, accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']! }] });
const options = (overrides: Parameters<typeof forecastOptions>[1]['overrides'] = {}) =>
  forecastOptions(db, { companyId, asOf: d('2026-03-01'), overrides: { horizonDays: 92, granularity: 'monthly', ...overrides } });
const everyLine = (f: ForecastResult) => f.buckets.flatMap((b) => [...b.inflows, ...b.outflows]);

describe('the opening position and the running balance', () => {
  it('opens at the ledger balance of bank and cash, and each bucket closes at the opening plus the flows so far', () => {
    sale('2026-02-20', '2026-03-20', 100_000);
    bill('2026-02-25', '2026-04-10', 50_000);
    const f = buildForecast(db, options());
    expect(f.openingCash.totalMinor).toBe(accountBalance(db, { companyId, accountId: acc['bank_control']!, asOf: d('2026-03-01') }));
    expect(f.openingCash.totalMinor).toBe(1_000_000);
    expect(f.buckets.map((b) => b.label)).toEqual(['2026-03', '2026-04', '2026-05']);
    let running = f.openingCash.totalMinor;
    for (const b of f.buckets) {
      running += b.inflowMinor + b.outflowMinor;
      expect(b.closingBalanceMinor).toBe(running);
      expect(b.netMinor).toBe([...b.inflows, ...b.outflows].reduce((s, l) => s + l.amountMinor, 0));
    }
    expect(f.closingBalanceMinor).toBe(running);
  });

  it('forecasts invoices gross, as the cash moves, on their due dates', () => {
    sale('2026-02-20', '2026-03-20', 100_000);
    bill('2026-02-25', '2026-04-10', 50_000);
    const lines = everyLine(buildForecast(db, options()));
    expect(lines.find((l) => l.category === 'receipt')).toMatchObject({ date: '2026-03-20', amountMinor: 123_000, source: 'ledger', isEstimate: false });
    expect(lines.find((l) => l.category === 'payment')).toMatchObject({ date: '2026-04-10', amountMinor: -61_500, source: 'ledger' });
  });

  it('marks an unfiled VAT return whose date has passed as overdue', () => {
    sale('2025-12-01', '2026-06-01', 10_000);
    const line = everyLine(buildForecast(db, options())).find((l) => l.category === 'tax')!;
    expect(line).toMatchObject({ date: '2026-03-01', overdue: true, dueDate: '2026-01-19', amountMinor: -2_300, description: 'VAT: Nov–Dec 2025' });
  });

  it('places what is already overdue on the forecast date, marked, with the date it was due', () => {
    sale('2026-01-10', '2026-02-10', 10_000);
    const line = everyLine(buildForecast(db, options())).find((l) => l.category === 'receipt')!;
    expect(line).toMatchObject({ date: '2026-03-01', overdue: true, dueDate: '2026-02-10', amountMinor: 12_300 });
  });

  it('leaves out anything due after the horizon, and part-paid invoices count only what is still owed', () => {
    const late = sale('2026-02-20', '2026-07-01', 10_000);
    const part = sale('2026-02-21', '2026-03-25', 100_000);
    recordPayment(db, { companyId, direction: 'received', paymentDate: d('2026-02-28'), amountMinor: 23_000, allocations: [{ invoiceId: part.invoiceId, allocatedMinor: 23_000 }] });
    const lines = everyLine(buildForecast(db, options())).filter((l) => l.category === 'receipt');
    expect(lines.map((l) => [l.entityRef?.id, l.amountMinor])).toEqual([[part.invoiceId, 100_000]]);
    expect(lines.some((l) => l.entityRef?.id === late.invoiceId)).toBe(false);
  });

  it('converts a foreign-currency invoice at its own booked rate, and says so', () => {
    // USD 1,000 net at 0.9 EUR per USD: EUR 900 net, 1,107 gross.
    createInvoice(db, { companyId, direction: 'sales', invoiceDate: d('2026-02-20'), dueDate: d('2026-03-20'), customerId: cust, currency: 'USD',
      fxRate: { numerator: 9, denominator: 10, source: 'ECB' },
      lines: [{ description: 'Work', netMinor: 100_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] });
    const line = everyLine(buildForecast(db, options())).find((l) => l.category === 'receipt')!;
    expect(line.amountMinor).toBe(110_700);
    expect(line.estimateBasis).toMatch(/Converted from USD at the invoice's booked rate/);
  });

  it('records the lowest point and warns below the minimum cash', () => {
    bill('2026-02-25', '2026-04-10', 900_000);
    sale('2026-02-20', '2026-05-20', 900_000);
    const f = buildForecast(db, options({ minimumCashMinor: 100_000 }));
    // 10,000 − 11,070 = −1,070 at the end of April; the VAT period's net is paid in March.
    const vat = buildVat3Return(db, { companyId, vatPeriodId: db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Jan–Feb 2026')).get()!.id }).netPositionMinor;
    expect(f.lowestPointMinor).toBe(1_000_000 - vat - 1_107_000);
    expect(f.lowestPointDate).toBe('2026-04-30');
    expect(f.belowMinimum).toBe(true);
  });
});

describe('receipt basis (decisions on #333)', () => {
  it('uses each customer\'s history when chosen, and a per-customer delay overrides it', () => {
    const paid = sale('2025-11-01', '2025-12-01', 10_000);
    recordPayment(db, { companyId, direction: 'received', paymentDate: d('2025-12-15'), amountMinor: 12_300, allocations: [{ invoiceId: paid.invoiceId, allocatedMinor: 12_300 }] });
    sale('2026-02-20', '2026-03-20', 100_000);
    const byDue = everyLine(buildForecast(db, options())).find((l) => l.category === 'receipt')!;
    expect(byDue.date).toBe('2026-03-20');
    const byHistory = everyLine(buildForecast(db, options({ receiptBasis: 'customer_history' }))).find((l) => l.category === 'receipt')!;
    expect(byHistory).toMatchObject({ date: '2026-04-03', isEstimate: true });
    expect(byHistory.estimateBasis).toMatch(/paid on average 14 day\(s\) late over 1 invoice/);
    const overridden = everyLine(buildForecast(db, options({ receiptBasis: 'customer_history', customerDelayDays: { [cust]: 5 } })))
      .find((l) => l.category === 'receipt')!;
    expect(overridden.date).toBe('2026-03-25');
  });
});

describe('VAT in the forecast (#566)', () => {
  it('is due on the 19th under s.76, or the 23rd on the ROS basis (s.78(2)), at the return\'s figure', () => {
    sale('2026-02-20', '2026-06-20', 100_000);
    const period = db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Jan–Feb 2026')).get()!;
    const net = buildVat3Return(db, { companyId, vatPeriodId: period.id }).netPositionMinor;
    expect(net).toBeGreaterThan(0);
    const statutory = everyLine(buildForecast(db, options())).find((l) => l.category === 'tax')!;
    expect(statutory).toMatchObject({ date: '2026-03-19', amountMinor: -net, source: 'rule', ruleKey: 'vat.return_due_within_9_days' });
    const ros = everyLine(buildForecast(db, options({ dueDateBasis: 'ros' }))).find((l) => l.category === 'tax')!;
    expect(ros.date).toBe('2026-03-23');
    expect(ros.estimateBasis).toMatch(/s\.78\(2\)/);
  });

  it('reads a filed return\'s figures, and does not forecast a filed return whose date has passed', () => {
    const period = db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Jan–Feb 2026')).get()!;
    db.update(vatPeriods).set({ status: 'submitted', filedT3Minor: 40_000, filedT4Minor: 5_000 }).where(eq(vatPeriods.id, period.id)).run();
    const line = everyLine(buildForecast(db, options())).find((l) => l.category === 'tax')!;
    expect(line).toMatchObject({ date: '2026-03-19', amountMinor: -35_000, isEstimate: false });
    const after = buildForecast(db, forecastOptions(db, { companyId, asOf: d('2026-03-20'), overrides: { horizonDays: 30 } }));
    expect(everyLine(after).some((l) => l.key === `vat:${period.id}`)).toBe(false);
  });

  it('lists a VAT repayment as a finding, never as cash in', () => {
    bill('2026-02-25', '2026-06-10', 100_000);
    const period = db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Jan–Feb 2026')).get()!;
    const net = buildVat3Return(db, { companyId, vatPeriodId: period.id }).netPositionMinor;
    expect(net).toBe(-23_000);
    const f = buildForecast(db, options());
    expect(everyLine(f).some((l) => l.category === 'tax')).toBe(false);
    expect(f.findings).toContain('VAT repayments of 230.00 are not forecast as cash in: when Revenue repays is not known.');
  });
});

describe('recurring items (#567) in the forecast', () => {
  it('forecasts each occurrence of the current version only', () => {
    const rent = createRecurringItem(db, { companyId, recordedBy: 'owner', description: 'Rent', direction: 'outflow', amountMinor: 200_000,
      frequency: 'monthly', startDate: '2026-01-05', endDate: null });
    let lines = everyLine(buildForecast(db, options())).filter((l) => l.category === 'recurring');
    expect(lines.map((l) => [l.date, l.amountMinor, l.source])).toEqual([
      ['2026-03-05', -200_000, 'assumption'], ['2026-04-05', -200_000, 'assumption'], ['2026-05-05', -200_000, 'assumption'],
    ]);
    const v2 = updateRecurringItem(db, { companyId, itemId: rent.id, recordedBy: 'owner', changes: { amountMinor: 220_000 } });
    lines = everyLine(buildForecast(db, options())).filter((l) => l.category === 'recurring');
    expect(lines.map((l) => l.amountMinor)).toEqual([-220_000, -220_000, -220_000]);
    expect(lines.every((l) => l.entityRef?.id === v2.id)).toBe(true);
    expect(() => updateRecurringItem(db, { companyId, itemId: rent.id, recordedBy: 'owner', changes: { amountMinor: 1 } })).toThrow(/replaced/);
  });
});

describe('assembling a forecast', () => {
  const o: ForecastOptions = {
    companyId: 'c', asOf: d('2026-03-01'), horizonEnd: d('2026-03-14'), granularity: 'weekly', receiptBasis: 'due_date',
    includePurchaseOrders: false, includeUnconfirmed: true, includeOwnerTax: true, minimumCashMinor: 0, dueDateBasis: 'statutory',
  };
  const line = (key: string, date: string | null, amountMinor: number, extra: Partial<ForecastLine> = {}): ForecastLine => ({
    key, date: date as IsoDate | null, amountMinor, description: key, category: 'payment', source: 'ledger', isEstimate: false, ...extra,
  });

  it('keeps undated items and draft invoices out of the running balance, and totals them apart', () => {
    const f = assembleForecast({
      o, currency: 'EUR', opening: { accounts: [], totalMinor: 1_000 }, findings: [], scenarioName: null,
      lines: [
        line('a', '2026-03-02', -300), line('b', '2026-03-09', 500, { category: 'receipt' }),
        line('undated', null, -700), line('draft', '2026-03-03', 200, { isUnconfirmed: true, category: 'receipt' }),
      ],
    });
    expect(f.buckets.map((b) => [b.label, b.closingBalanceMinor, b.closingBalanceWithUnconfirmedMinor])).toEqual([
      ['2026-03-01 to 2026-03-07', 700, 900], ['2026-03-08 to 2026-03-14', 1_200, 1_400],
    ]);
    expect([f.undatedTotalMinor, f.undated.length, f.unconfirmed.length]).toEqual([-700, 1, 1]);
    expect(f.findings.join(' ')).toMatch(/1 item\(s\) totalling -7\.00 have no date/);
    expect([f.lowestPointMinor, f.lowestPointDate]).toEqual([700, '2026-03-07']);
  });
});

describe('schedules', () => {
  it('step by the calendar from the start, not by a fixed number of days', () => {
    expect(occurrences('monthly', d('2026-01-31'), null, d('2026-01-01'), d('2026-05-31')))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(occurrences('quarterly', d('2025-11-15'), d('2026-06-01'), d('2026-01-01'), d('2026-12-31'))).toEqual(['2026-02-15', '2026-05-15']);
    expect(occurrences('weekly', d('2026-03-02'), null, d('2026-03-02'), d('2026-03-20'))).toEqual(['2026-03-09', '2026-03-16']);
  });
});

describe('forecast defaults (decisions on #333)', () => {
  it('start from the built-in defaults; a change is a new version; one forecast can override any of them', () => {
    expect(forecastDefaults(db, companyId)).toMatchObject({ version: 0, receiptBasis: 'due_date', horizonDays: 90, dueDateBasis: 'statutory' });
    setForecastDefaults(db, { companyId, recordedBy: 'owner', changes: { receiptBasis: 'customer_history', horizonDays: 180 } });
    const v2 = setForecastDefaults(db, { companyId, recordedBy: 'owner', changes: { dueDateBasis: 'ros' } });
    expect(v2).toMatchObject({ version: 2, receiptBasis: 'customer_history', horizonDays: 180, dueDateBasis: 'ros' });
    const o = forecastOptions(db, { companyId, asOf: d('2026-03-01') });
    expect([o.receiptBasis, o.horizonEnd, o.dueDateBasis]).toEqual(['customer_history', '2026-08-27', 'ros']);
    const overridden = forecastOptions(db, { companyId, asOf: d('2026-03-01'), overrides: { receiptBasis: 'due_date', horizonDays: 7 } });
    expect([overridden.receiptBasis, overridden.horizonEnd]).toEqual(['due_date', '2026-03-07']);
  });

  it('refuse a horizon out of range and a cash account that is not an asset of this company', () => {
    expect(() => setForecastDefaults(db, { companyId, recordedBy: 'o', changes: { horizonDays: 0 } })).toThrow(/1 to 731/);
    expect(() => setForecastDefaults(db, { companyId, recordedBy: 'o', changes: { cashAccountIds: [byCode['4020']!] } })).toThrow(/asset accounts/);
    expect(() => buildForecast(db, options({ cashAccountIds: ['acc_nope'] }))).toThrow(/not this company's/);
  });

  it('counts only the cash accounts chosen', () => {
    postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-01-03'), narrative: 'Float', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: acc['cash']!, debitMinor: 5_000 }, { accountId: acc['share_capital']!, creditMinor: 5_000 }] });
    expect(buildForecast(db, options()).openingCash.totalMinor).toBe(1_005_000);
    expect(buildForecast(db, options({ cashAccountIds: [acc['cash']!] })).openingCash.totalMinor).toBe(5_000);
  });
});

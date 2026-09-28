import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { companyBudgets, customers, forecastSnapshots, recurringForecastItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany, addBankAccount } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { createInvoice } from '../invoicing/invoices';
import { asIsoDate, type IsoDate } from '../dates';
import * as forecast from '.';
import {
  addScenarioAdjustment, budgetVsActual, buildForecast, compareScenarios, compareWithSnapshot, confirmRecurringPattern, copyBudget,
  createBudget, createScenario, detectRecurringPatterns, dismissRecurringPattern, forecastOptions, importBudgetCsv, listBudgets,
  listForecastSnapshots, saveForecastSnapshot, type ForecastResult,
} from '.';

/** Issues #567 (recurring items), #569 (budget), #570 (scenarios) and saved forecasts (#565). */

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let bankAccountId: string;
let cust: string;
const d = (s: string) => s as IsoDate;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Pleanáil Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
  ({ companyId } = created);
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'] });
  postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-01-02'), narrative: 'Capital', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: acc['bank_control']!, debitMinor: 1_000_000 }, { accountId: acc['share_capital']!, creditMinor: 1_000_000 }] });
  cust = ids.customer();
  db.insert(customers).values({ id: cust, companyId, name: 'Cliant', matchKey: 'cliant', countryCode: 'IE' }).run();
});

const sale = (dueDate: string, netMinor: number) =>
  createInvoice(db, { companyId, direction: 'sales', invoiceDate: d('2026-02-20'), dueDate: d(dueDate), customerId: cust,
    lines: [{ description: 'Work', netMinor, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] });
const options = (overrides: Parameters<typeof forecastOptions>[1]['overrides'] = {}) =>
  forecastOptions(db, { companyId, asOf: d('2026-03-01'), overrides: { horizonDays: 92, granularity: 'monthly', ...overrides } });
const lines = (f: ForecastResult) => f.buckets.flatMap((b) => [...b.inflows, ...b.outflows]);

describe('scenarios (#570)', () => {
  it('a scenario with no adjustments equals the base forecast', () => {
    sale('2026-03-20', 100_000);
    const s = createScenario(db, { companyId, name: 'Nothing changes', recordedBy: 'owner' });
    const base = buildForecast(db, options());
    const same = buildForecast(db, options({ scenarioId: s.id }));
    expect(same.buckets.map((b) => b.closingBalanceMinor)).toEqual(base.buckets.map((b) => b.closingBalanceMinor));
    expect(same.scenarioName).toBe('Nothing changes');
    expect(same.findings).toContain('Scenario "Nothing changes" has no adjustments: it equals the base forecast.');
  });

  it('applies a revenue change, a delay, a one-off, a new hire and a recurring amount, and leaves the base alone', () => {
    sale('2026-03-20', 100_000);
    const s = createScenario(db, {
      companyId, name: 'Hard spring', recordedBy: 'owner', adjustments: [
        { kind: 'revenue_change', description: 'Prices cut', fromDate: '2026-03-01', changeBasisPoints: -1_000 },
        { kind: 'customer_payment_delay', description: 'Cliant slow', fromDate: '2026-03-01', targetId: cust, delayDays: 30 },
        { kind: 'one_off', description: 'Van', fromDate: '2026-04-15', amountMinor: -2_500_000 },
        { kind: 'new_hire', description: 'Engineer', fromDate: '2026-04-01', amountMinor: 450_000 },
        { kind: 'recurring_item', description: 'Grant', fromDate: '2026-03-10', frequency: 'monthly', amountMinor: 50_000, toDate: '2026-04-30' },
      ],
    });
    const f = buildForecast(db, options({ scenarioId: s.id }));
    const receipt = lines(f).find((l) => l.category === 'receipt')!;
    expect(receipt).toMatchObject({ date: '2026-04-19', amountMinor: 110_700, scenarioName: 'Hard spring', isEstimate: true });
    expect(receipt.estimateBasis).toMatch(/Prices cut \(-10%\).*Cliant slow \(30 day\(s\)\)/);
    const added = lines(f).filter((l) => l.category === 'scenario').map((l) => [l.date, l.amountMinor, l.source]);
    expect(added).toEqual(expect.arrayContaining([
      ['2026-04-15', -2_500_000, 'assumption'], ['2026-04-01', -450_000, 'assumption'], ['2026-05-01', -450_000, 'assumption'],
      ['2026-03-10', 50_000, 'assumption'], ['2026-04-10', 50_000, 'assumption'],
    ]));
    expect(added).toHaveLength(5);
    // The base forecast is unchanged by the scenario.
    expect(lines(buildForecast(db, options())).find((l) => l.category === 'receipt')).toMatchObject({ date: '2026-03-20', amountMinor: 123_000 });

    const cmp = compareScenarios(db, { options: options(), scenarioIds: [s.id] });
    expect(cmp.rows.map((r) => r.name)).toEqual(['Base forecast', 'Hard spring']);
    expect(cmp.rows[1]!.closingDifferenceMinor).toBe((110_700 - 123_000) - 2_500_000 - 900_000 + 100_000);
  });

  it('refuses an adjustment it cannot apply', () => {
    const s = createScenario(db, { companyId, name: 'x', recordedBy: 'o' });
    const add = (a: Partial<forecast.ScenarioAdjustmentInput>) =>
      addScenarioAdjustment(db, { companyId, scenarioId: s.id, adjustment: { kind: 'one_off', description: 'x', fromDate: '2026-03-01', ...a } });
    expect(() => add({ amountMinor: 0 })).toThrow(/not zero/);
    expect(() => add({ amountMinor: 1.5 })).toThrow(/whole number/);
    expect(() => add({ kind: 'revenue_change', changeBasisPoints: -20_000 })).toThrow(/below -100%/);
    expect(() => add({ kind: 'recurring_item', amountMinor: 100 })).toThrow(/how often/);
    expect(() => add({ kind: 'customer_payment_delay', delayDays: 5, targetId: 'cus_nope' })).toThrow(/not this company's/);
    expect(() => add({ amountMinor: 100, fromDate: '2026-03-01', toDate: '2026-02-01' })).toThrow(/on or after its start/);
  });
});

describe('saved forecasts', () => {
  it('keep the forecast as computed, whatever changes in the books later, and compare line by line', () => {
    sale('2026-03-20', 100_000);
    const before = buildForecast(db, options());
    const saved = saveForecastSnapshot(db, { name: 'March board pack', savedBy: 'owner', result: before });
    expect(saved.result).toEqual(before);
    const later = sale('2026-04-20', 50_000);
    const now = buildForecast(db, options());
    expect(forecast.getForecastSnapshot(db, { companyId, snapshotId: saved.id }).result).toEqual(before);
    const cmp = compareWithSnapshot(db, { companyId, snapshotId: saved.id, current: now });
    expect(cmp.added.map((l) => l.entityRef?.id)).toContain(later.invoiceId);
    expect(cmp.closing.differenceMinor).toBe(now.closingBalanceMinor - before.closingBalanceMinor);
    expect(listForecastSnapshots(db, companyId).map((s) => [s.name, s.closingBalanceMinor])).toEqual([['March board pack', before.closingBalanceMinor]]);
    // There is no update path: nothing in the module writes to a saved row after insert.
    expect(Object.keys(forecast).filter((k) => /snapshot/i.test(k) && /update|edit|set/i.test(k))).toEqual([]);
    expect(db.select().from(forecastSnapshots).all()).toHaveLength(1);
  });
});

describe('recurring patterns (#567)', () => {
  const monthly = (payee: string, amounts: number[], start = 1) => amounts.forEach((a, i) => insertTestBankTransaction(db, {
    companyId, bankAccountId, amountMinor: a, counterpartyName: payee, description: `${payee.toUpperCase()} REF ${1000 + i}`,
    transactionDate: `2025-${String(start + i).padStart(2, '0')}-05`,
  }));

  it('suggests a regular payee at the median amount, and a person confirms it before it is forecast', () => {
    monthly('Eir', [-6_000, -6_000, -6_500, -6_000, -6_000]);
    monthly('Once Off Ltd', [-90_000]);
    const found = detectRecurringPatterns(db, { companyId, asOf: d('2025-12-31') });
    expect(found.suggested.map((p) => [p.payeePattern, p.detectedFrequency, p.medianAmountMinor, p.amountMinMinor, p.amountMaxMinor, p.occurrenceCount]))
      .toEqual([['Eir', 'monthly', 6_000, 6_000, 6_500, 5]]);
    expect(db.select().from(recurringForecastItems).all()).toEqual([]);
    const item = confirmRecurringPattern(db, { companyId, patternId: found.suggested[0]!.id, confirmedBy: 'owner' });
    expect(item).toMatchObject({ source: 'detected', direction: 'outflow', amountMinor: 6_000, startDate: '2025-06-05', frequency: 'monthly' });
    const f = buildForecast(db, options());
    expect(lines(f).filter((l) => l.category === 'recurring').map((l) => [l.date, l.amountMinor, l.source]))
      .toEqual([['2026-03-05', -6_000, 'ai_suggestion'], ['2026-04-05', -6_000, 'ai_suggestion'], ['2026-05-05', -6_000, 'ai_suggestion']]);
  });

  it('does not suggest a dismissed pattern again, and needs regular intervals', () => {
    monthly('Eir', [-6_000, -6_000, -6_000]);
    const [p] = detectRecurringPatterns(db, { companyId, asOf: d('2025-12-31') }).suggested;
    dismissRecurringPattern(db, { companyId, patternId: p!.id, dismissedBy: 'owner' });
    monthly('Eir', [-6_000], 4);
    const again = detectRecurringPatterns(db, { companyId, asOf: d('2025-12-31') });
    expect([again.suggested, again.alreadyReviewed]).toEqual([[], 1]);
    ['2025-01-02', '2025-01-20', '2025-04-01', '2025-04-03'].forEach((date) =>
      insertTestBankTransaction(db, { companyId, bankAccountId, amountMinor: -1_000, counterpartyName: 'Random', transactionDate: date }));
    expect(detectRecurringPatterns(db, { companyId, asOf: d('2025-12-31') }).suggested).toEqual([]);
  });
});

describe('the budget (#569)', () => {
  it('versions each new budget for the year and keeps the old one', () => {
    const first = createBudget(db, { companyId, financialYearEnd: '2026-12-31', name: 'Plan', recordedBy: 'owner',
      lines: [{ accountId: byCode['4020']!, monthStart: '2026-01-01', amountMinor: 100_000 }] });
    const second = createBudget(db, { companyId, financialYearEnd: '2026-12-31', name: 'Revised', recordedBy: 'owner', reason: 'New contract',
      lines: [{ accountId: byCode['4020']!, monthStart: '2026-01-01', amountMinor: 150_000 }] });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(listBudgets(db, companyId).map((b) => [b.version, b.status])).toEqual([[2, 'current'], [1, 'superseded']]);
    expect(() => createBudget(db, { companyId, financialYearEnd: '2026-12-31', name: 'x', recordedBy: 'o',
      lines: [{ accountId: acc['bank_control']!, monthStart: '2026-01-01', amountMinor: 1 }] })).toThrow(/income or expense/);
    expect(() => createBudget(db, { companyId, financialYearEnd: '2026-12-30', name: 'x', recordedBy: 'o', lines: [] })).toThrow(/last day of a month/);
  });

  it('imports a CSV by account code or name, and refuses an unknown account or amount without saving anything', () => {
    const b = importBudgetCsv(db, { companyId, financialYearEnd: '2026-12-31', name: 'Import', recordedBy: 'owner',
      csv: `account,2026-01,2026-02\n4020,"1,000.00",1200.50\n${'6010'},250,\n` });
    expect(forecast.budgetLines(db, b.id).map((l) => [l.monthStart, l.amountMinor]).sort()).toEqual([
      ['2026-01-01', 100_000], ['2026-01-01', 25_000], ['2026-02-01', 120_050],
    ]);
    const count = db.select().from(companyBudgets).all().length;
    expect(() => importBudgetCsv(db, { companyId, financialYearEnd: '2026-12-31', name: 'Bad', recordedBy: 'o',
      csv: 'account,2026-01\nNo such account,10\n4020,1.234\n' })).toThrow(/Row 2: "No such account"[\s\S]*Row 3, 2026-01/);
    expect(() => importBudgetCsv(db, { companyId, financialYearEnd: '2026-12-31', name: 'Bad', recordedBy: 'o', csv: 'account,2027-01\n4020,10\n' }))
      .toThrow(/not months of the year/);
    expect(db.select().from(companyBudgets).all().length).toBe(count);
  });

  it('copies last year\'s actuals a year on with a percentage change, and compares budget with actual', () => {
    postJournalEntry(db, { companyId, entryDate: asIsoDate('2025-03-10'), narrative: 'Fees', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: acc['bank_control']!, debitMinor: 100_000 }, { accountId: byCode['4020']!, creditMinor: 100_000 }] });
    const b = copyBudget(db, { companyId, financialYearEnd: '2026-12-31', name: 'Last year +10%', recordedBy: 'owner',
      from: { kind: 'actuals' }, adjustments: { allBasisPoints: 1_000 } });
    expect(b.source).toBe('copied_actuals');
    expect(forecast.budgetLines(db, b.id).map((l) => [l.accountId, l.monthStart, l.amountMinor])).toEqual([[byCode['4020'], '2026-03-01', 110_000]]);

    postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-03-12'), narrative: 'Fees', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: acc['bank_control']!, debitMinor: 90_000 }, { accountId: byCode['4020']!, creditMinor: 90_000 }] });
    const bva = budgetVsActual(db, { companyId, budgetId: b.id, asOf: d('2026-03-31') });
    const row = bva.rows.find((r) => r.accountId === byCode['4020'])!;
    expect([row.budgetToDateMinor, row.actualMinor, row.varianceMinor, row.budgetMinor]).toEqual([110_000, 90_000, -20_000, 110_000]);
    expect(row.actualByMonthMinor.slice(0, 4)).toEqual([0, 0, 90_000, null]);

    const copied = copyBudget(db, { companyId, financialYearEnd: '2027-12-31', name: 'Next year', recordedBy: 'owner',
      from: { kind: 'budget', budgetId: b.id }, adjustments: { byAccount: { [byCode['4020']!]: -500 } } });
    expect(forecast.budgetLines(db, copied.id).map((l) => [l.monthStart, l.amountMinor])).toEqual([['2027-03-01', 104_500]]);
    expect(db.select().from(companyBudgets).where(eq(companyBudgets.id, b.id)).get()!.status).toBe('current');
  });
});

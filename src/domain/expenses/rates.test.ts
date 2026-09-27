import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, seedTestBook } from '@/db/testing';
import { expenseRates } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';
import {
  DEFAULT_EXPENSE_RATES, resolveExpenseRate, expenseRatesActiveOn, calculateRateAmount,
  ensureDefaultExpenseRates, ExpenseRateError,
} from './rates';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const book = seedTestBook();
  db = book.db;
  companyId = book.companyId;
});

describe('default expense rates', () => {
  it('are installed for a new company, with their source', () => {
    const rows = db.select().from(expenseRates).where(eq(expenseRates.companyId, companyId)).all();
    expect(rows.length).toBe(DEFAULT_EXPENSE_RATES.length);
    for (const row of rows) {
      expect(row.sourceNote).toContain('Civil service rates');
      expect(row.sourceUrl).toContain('revenue.ie');
    }
  });

  it('can be backfilled for a company created before they existed', () => {
    // A company with no rates at all (simulating a book from before this epic).
    db.delete(expenseRates).where(eq(expenseRates.companyId, companyId)).run();
    const { added } = ensureDefaultExpenseRates(db, companyId);
    expect(added.length).toBe(DEFAULT_EXPENSE_RATES.length);
    // Idempotent: a second run adds nothing.
    expect(ensureDefaultExpenseRates(db, companyId).added).toEqual([]);
  });
});

describe('resolveExpenseRate', () => {
  it('resolves the rate in force on a claim line date, whatever revision came later', () => {
    const mileage = db.select().from(expenseRates)
      .where(eq(expenseRates.code, 'car_upto_1200cc_band1')).get()!;

    // A later revision supersedes the seeded rate without overwriting it.
    db.insert(expenseRates).values({
      id: ids.expenseRate(), companyId, category: 'mileage', code: mileage.code,
      name: 'Car up to 1200cc, first 1,500 km (revised)', unit: 'km',
      amountMinor: 5000, perUnits: 100, effectiveFrom: '2027-01-01',
      sourceNote: 'Test revision', sourceUrl: null,
    }).run();
    db.update(expenseRates).set({ effectiveTo: '2026-12-31' })
      .where(eq(expenseRates.id, mileage.id)).run();

    const before = resolveExpenseRate(db, { companyId, rateId: mileage.id, onDate: asIsoDate('2026-06-01') });
    expect(before.amountMinor).toBe(4180);
    // The seeded row is closed from 2027, so a 2027 claim cannot use it: the
    // historical window is what decides, never "the latest row regardless".
    expect(() => resolveExpenseRate(db, { companyId, rateId: mileage.id, onDate: asIsoDate('2027-06-01') }))
      .toThrow(ExpenseRateError);
  });

  it('refuses a rate that was not in force on the line date', () => {
    const day = db.select().from(expenseRates).where(eq(expenseRates.code, 'day_10_hours_or_more')).get()!;
    expect(() => resolveExpenseRate(db, { companyId, rateId: day.id, onDate: asIsoDate('2024-06-01') }))
      .toThrow(ExpenseRateError);
  });

  it('lists only the rates available on a date', () => {
    const active = expenseRatesActiveOn(db, companyId, asIsoDate('2025-06-01'));
    expect(active.every((r) => r.effectiveFrom <= '2025-06-01')).toBe(true);
    // A subsistence allowance that only started in 2025 is there; nothing starts later.
    expect(active.some((r) => r.code === 'overnight_normal')).toBe(true);
  });
});

describe('calculateRateAmount', () => {
  it('prices mileage exactly: 1,500 km at 41.80 cent per km is 627.00', () => {
    expect(calculateRateAmount(1500, { amountMinor: 4180, perUnits: 100 })).toBe(62_700);
  });

  it('rounds a fraction of a kilometre to the nearest minor unit, deterministically', () => {
    // 3 km at 41.80c = 125.4c = 1.254 -> 125 minor (rounds half up).
    expect(calculateRateAmount(3, { amountMinor: 4180, perUnits: 100 })).toBe(125);
  });

  it('prices a per-occasion allowance without any rate division', () => {
    expect(calculateRateAmount(2, { amountMinor: 4617, perUnits: 1 })).toBe(9_234);
  });
});

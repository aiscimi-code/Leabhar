import { describe, it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeCorporationTax } from './computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { asIsoDate } from '../dates';

/**
 * Benchmark for issue #288: the tax computations recompute every earlier year
 * on each call, so the year-end page gets slower with each year on the books.
 * Seven years of books, each with 240 postings, then the year-end figures for
 * year 7 as the page loads them. The budget is deliberately generous (the
 * assertion guards against an order-of-magnitude regression, not a few
 * percent); the measured time is printed so a trend is visible.
 */
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const POSTINGS_PER_YEAR = 240;
const BUDGET_MS = 5_000;

function seedBooks(entityType: 'company' | 'sole_trader') {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'Bench Ltd', vatRegistrationStatus: 'registered', seedYears: YEARS, entityType,
  });
  const { companyId, accountsByCode: byCode, accountsByKey: byKey } = created;
  for (const year of YEARS) {
    for (let i = 0; i < POSTINGS_PER_YEAR; i++) {
      const month = String((i % 12) + 1).padStart(2, '0');
      const day = String((i % 27) + 1).padStart(2, '0');
      const income = i % 3 === 0;
      const amount = 10_000 + i * 37;
      postJournalEntry(db, {
        companyId, entryDate: asIsoDate(`${year}-${month}-${day}`), narrative: `Bench ${year} ${i}`,
        sourceType: 'bank_transaction', sourceId: `bench-${year}-${i}`, baseCurrency: 'EUR',
        lines: income
          ? [{ accountId: byKey['bank_control']!, debitMinor: amount }, { accountId: byCode['4020']!, creditMinor: amount }]
          : [{ accountId: byCode['6070']!, debitMinor: amount, memo: 'Bench expense' }, { accountId: byKey['bank_control']!, creditMinor: amount }],
      });
    }
  }
  return { db, companyId };
}

const time = <T>(label: string, fn: () => T): { result: T; ms: number } => {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  if (process.env.BENCH_LOG) appendFileSync(process.env.BENCH_LOG, `${label}: ${ms.toFixed(0)} ms\n`);
  return { result, ms };
};

describe('tax computation cost with 7 years of books (issue #288)', () => {
  it('computes corporation tax for year 7 inside the budget', () => {
    const { db, companyId } = seedBooks('company');
    const { result, ms } = time('corporation tax, year 7', () => computeCorporationTax(db, {
      companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31'),
    }));
    expect(result.accountingProfitMinor).not.toBe(0);
    expect(ms).toBeLessThan(BUDGET_MS);
    // For the record: year 1 computes one base, year 7 computes seven, so the
    // ratio shows how the cost grows with the years on the books.
    time('corporation tax, year 1', () => computeCorporationTax(db, {
      companyId, from: asIsoDate('2019-01-01'), to: asIsoDate('2019-12-31'),
    }));
  }, 120_000);

  it('computes income tax for year 7 inside the budget', () => {
    const { db, companyId } = seedBooks('sole_trader');
    const { result, ms } = time('income tax, year 7', () => computeIncomeTax(db, { companyId, year: 2025 }));
    expect(result).toBeDefined();
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 120_000);
});

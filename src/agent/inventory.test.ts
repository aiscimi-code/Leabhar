import { describe, it, expect, beforeEach, vi } from 'vitest';
import { seedTestBook } from '@/db/testing';
import type { AppDatabase } from '@/db';
import { main } from '@/cli/reconcile';
import { parseQuantity } from './inventory';

let db: AppDatabase;
let companyId: string;
beforeEach(() => { ({ db, companyId } = seedTestBook({ seedYears: [2025] })); });

async function run(argv: string[]): Promise<unknown> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  try {
    const code = await main(argv, { db, companyId });
    expect(code, out.join('')).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out.join(''));
}

describe('inventory from the CLI (EPIC 23)', () => {
  it('reads quantities to thousandths and refuses more precision', () => {
    expect([parseQuantity('2'), parseQuantity('1.5'), parseQuantity('0.125')]).toEqual([2000, 1500, 125]);
    expect(() => parseQuantity('1.2345')).toThrow(/three decimal places/);
  });

  it('sets up an item, opens stock, counts it and values it', async () => {
    await run(['add-item', '--code', 'W1', '--name', 'Widget', '--kind', 'stock', '--unit', 'each', '--method', 'weighted_average', '--by', 'owner']);
    await run(['add-location', '--code', 'SHOP', '--name', 'Shop']);
    await run(['opening-stock', '--item', 'W1', '--location', 'SHOP', '--date', '2025-01-01', '--quantity', '10', '--unit-cost', '4.00', '--by', 'owner']);
    const counted = await run(['stocktake', '--location', 'SHOP', '--date', '2025-06-30', '--counted-by', 'Aoife', '--count', 'W1=9.5', '--by', 'owner']) as {
      lines: Array<{ bookQuantityMilli: number; countedQuantityMilli: number }>;
    };
    expect(counted.lines[0]).toMatchObject({ bookQuantityMilli: 10_000, countedQuantityMilli: 9_500 });
    const valued = await run(['stock-valuation', '--as-of', '2025-06-30']) as { totalMinor: number };
    expect(valued.totalMinor).toBe(3_800);
    const plan = await run(['closing-stock', '--date', '2025-06-30']) as { stockAccounts: Array<{ ledgerMinor: number; bookedMinor: number }> };
    // Opening stock recorded, but no opening balance on 1300: the plan shows the difference to resolve first.
    expect(plan.stockAccounts[0]).toMatchObject({ ledgerMinor: 0, bookedMinor: 4_000 });
  });
});

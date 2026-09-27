import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import type { AppDatabase } from '@/db';
import { createCompany } from '@/domain/config/setup';
import { main } from '@/cli/reconcile';
import { parseLivestockValues, parsePercent } from './farm';

let db: AppDatabase;
let companyId: string;
beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Feirm Ltd', chartKind: 'farm', seedYears: [2025] }));
});

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

describe('the farm from the CLI (EPIC 24)', () => {
  it('reads percentages and livestock values', () => {
    expect([parsePercent('100'), parsePercent('62.5'), parsePercent('0.01')]).toEqual([10_000, 6_250, 1]);
    expect(parseLivestockValues('Dairy cows=1100:Market value; Calves=200.50:Cost')).toEqual({
      'Dairy cows': { valuePerHeadMinor: 110_000, basis: 'Market value' }, Calves: { valuePerHeadMinor: 20_050, basis: 'Cost' },
    });
  });

  it('sets up land, an enterprise and a herd, and plans a valuation', async () => {
    await run(['add-parcel', '--ref', 'P1', '--name', 'Home', '--hectares', '20.5', '--tenure', 'owned', '--from', '2010-01-01', '--by', 'o']);
    const area = await run(['farmed-area', '--as-of', '2025-06-30']) as { total: { hectaresHundredths: number } };
    expect(area.total.hectaresHundredths).toBe(2_050);
    await run(['add-enterprise', '--name', 'Beef', '--kind', 'beef', '--from', '2020-01-01', '--by', 'o']);
    await run(['add-animal-group', '--enterprise', 'Beef', '--name', 'Stores', '--species', 'cattle', '--by', 'o']);
    await run(['livestock-event', '--kind', 'purchase', '--group', 'Stores', '--date', '2025-03-01', '--head', '12', '--amount', '14400', '--by', 'o']);
    const counts = await run(['head-counts', '--as-of', '2025-12-31']);
    expect(counts).toEqual([{ group: 'Stores', species: 'cattle', headCount: 12 }]);
    const plan = await run(['value-livestock', '--date', '2025-12-31', '--value', 'Stores=1250:Market value']) as { valueMinor: number };
    expect(plan.valueMinor).toBe(1_500_000);
  });
});

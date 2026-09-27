import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import type { AppDatabase } from '@/db';
import { createCompany } from '@/domain/config/setup';
import { saveFarmProfile } from '@/domain/farm';
import { main } from '@/cli/reconcile';
import { parseSignedEuro } from './farmTax';

let db: AppDatabase;
let companyId: string;
beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, {
    legalName: 'Feirm', entityType: 'sole_trader', chartKind: 'farm', tradeCommencedOn: '2025-01-01', seedYears: [2025],
  }));
  saveFarmProfile(db, { companyId, farmName: 'Gort', recordedBy: 'o' });
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

describe('farm tax from the CLI (EPIC 25)', () => {
  it('reads a loss as a negative amount', () => {
    expect([parseSignedEuro('1500.50'), parseSignedEuro('-18000')]).toEqual([150_050, -1_800_000]);
  });

  it('records a grant, a prior year\'s profit, and summarises the year', async () => {
    const grant = await run(['add-grant', '--scheme', 'BISS', '--payer', 'DAFM', '--kind', 'revenue', '--awarded', '8000', '--date', '2025-10-01', '--by', 'o']) as { id: string };
    expect(grant.id).toMatch(/^grant/);
    await run(['record-farm-profit', '--year', '2024', '--profit', '-18000', '--source', '2024 Form 11', '--by', 'o']);
    await run(['ct-decide', '--subject-type', 'farm_stock_relief', '--subject', companyId, '--period-end', '2025-12-31', '--choice', 'general', '--by', 'o']);
    const summary = await run(['farm-tax-summary', '--year', '2025']) as { entity: string; stockReliefCategory: string; grants: { awardedOutstandingMinor: number } };
    expect(summary).toMatchObject({ entity: 'individual', stockReliefCategory: 'general', grants: { awardedOutstandingMinor: 800_000 } });
  });
});

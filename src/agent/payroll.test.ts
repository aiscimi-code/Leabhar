import { describe, it, expect, beforeEach, vi } from 'vitest';
import { seedTestBook } from '@/db/testing';
import type { AppDatabase } from '@/db';
import { main } from '@/cli/reconcile';
import { parseUscBands } from './payroll';
import { listEmployees, listPayRuns, payslipsOfRun, reconcilePayroll } from '@/domain/payroll';

let db: AppDatabase;
let companyId: string;
beforeEach(() => { ({ db, companyId } = seedTestBook({ seedYears: [2026] })); });

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

describe('payroll from the CLI (EPIC 20)', () => {
  it('reads an RPN\'s USC bands, the last without a limit', () => {
    expect(parseUscBands('0.5:12012,2:16688,3:41344,8')).toEqual([
      { rateBasisPoints: 50, yearlyBandMinor: 1_201_200 }, { rateBasisPoints: 200, yearlyBandMinor: 1_668_800 },
      { rateBasisPoints: 300, yearlyBandMinor: 4_134_400 }, { rateBasisPoints: 800, yearlyBandMinor: null },
    ]);
  });

  it('runs a month end to end: employee, terms, RPN, run, post, pay, remit, reconcile', async () => {
    const e = await run(['add-employee', '--first', 'Aoife', '--last', 'Byrne', '--ref', 'E001', '--start', '2025-06-01',
      '--frequency', 'monthly', '--ppsn', '1234567T', '--by', 'owner']) as { id: string };
    await run(['set-employment-terms', '--employee', e.id, '--from', '2025-06-01', '--salary', '48000', '--by', 'owner']);
    await run(['record-rpn', '--employee', e.id, '--rpn', '1', '--year', '2026', '--from', '2026-01-01', '--basis', 'cumulative',
      '--credits', '4000', '--srcop', '44000', '--usc-bands', '0.5:12012,2:16688,3:41344,8', '--by', 'owner']);
    const created = await run(['create-pay-run', '--frequency', 'monthly', '--pay-date', '2026-01-30', '--weeks', '4', '--by', 'owner']) as { id: string };
    const shown = await run(['show-pay-run', '--run', created.id]) as { totals: { netPayMinor: number; dueToRevenueMinor: number } };
    expect(shown.totals).toMatchObject({ netPayMinor: 321_760, dueToRevenueMinor: 123_240 });
    await run(['post-pay-run', '--run', created.id, '--by', 'owner']);
    await run(['pay-net-wages', '--run', created.id, '--date', '2026-01-30', '--by', 'owner']);
    await run(['pay-payroll-taxes', '--month', '2026-01', '--date', '2026-02-23', '--by', 'owner']);
    const rec = await run(['reconcile-payroll', '--as-of', '2026-02-28']) as ReturnType<typeof reconcilePayroll>;
    expect(rec.accounts.map((a) => a.ledgerMinor)).toEqual([0, 0, 0, 0, 0]);
    expect(listEmployees(db, companyId)).toHaveLength(1);
    expect(payslipsOfRun(db, listPayRuns(db, companyId)[0]!.id)[0]!.taxMinor).toBe(53_333);
  });
});

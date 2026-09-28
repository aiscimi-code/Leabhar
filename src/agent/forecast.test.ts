import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { createInvoice } from '@/domain/invoicing/invoices';
import { asIsoDate } from '@/domain/dates';
import { main } from '@/cli/reconcile';
import { signedPercent } from './forecast';

let db: AppDatabase;
let companyId: string;
let cust: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Réamh Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  ({ companyId } = created);
  addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01', accountId: created.accountsByKey['bank_control'] });
  postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-01-02'), narrative: 'Capital', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: 1_000_000 }, { accountId: created.accountsByKey['share_capital']!, creditMinor: 1_000_000 }] });
  cust = ids.customer();
  db.insert(customers).values({ id: cust, companyId, name: 'Cliant', matchKey: 'cliant', countryCode: 'IE' }).run();
  createInvoice(db, { companyId, direction: 'sales', invoiceDate: asIsoDate('2026-02-20'), dueDate: asIsoDate('2026-03-20'), customerId: cust,
    lines: [{ description: 'Work', netMinor: 100_000, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode['IE_STD']! }] });
});

async function run(argv: string[]) {
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

describe('the forecast from the CLI (EPIC 29)', () => {
  it('builds a forecast with per-forecast options, and saves the company defaults as a new version', async () => {
    const f = await run(['forecast', '--as-of', '2026-03-01', '--days', '31', '--granularity', 'monthly', '--delay', `${cust}=5`, '--format', 'json']);
    expect(f.buckets[0].inflows[0]).toMatchObject({ date: '2026-03-25', amountMinor: 123_000 });
    const v1 = await run(['set-forecast-defaults', '--due-dates', 'ros', '--days', '60', '--by', 'owner', '--format', 'json']);
    expect(v1).toMatchObject({ version: 1, dueDateBasis: 'ros', horizonDays: 60 });
    expect(await run(['forecast-defaults', '--format', 'json'])).toMatchObject({ version: 1, dueDateBasis: 'ros' });
  });

  it('runs a scenario and compares it with the base', async () => {
    const s = await run(['add-scenario', '--name', 'Slow payers', '--by', 'owner', '--format', 'json']);
    await run(['scenario-adjust', '--scenario', s.id, '--kind', 'revenue_change', '--description', 'Down', '--from', '2026-03-01', '--percent', '-10', '--format', 'json']);
    await run(['scenario-adjust', '--scenario', s.id, '--kind', 'one_off', '--description', 'Van', '--from', '2026-03-15', '--amount', '-2500', '--format', 'json']);
    const cmp = await run(['compare-scenarios', '--scenarios', s.id, '--as-of', '2026-03-01', '--days', '31', '--format', 'json']);
    expect(cmp.rows[1].closingDifferenceMinor).toBe(-12_300 - 250_000);
  });

  it('saves a forecast, and imports and copies a budget', async () => {
    const saved = await run(['save-forecast', '--name', 'March', '--as-of', '2026-03-01', '--days', '31', '--by', 'owner', '--format', 'json']);
    expect((await run(['list-saved-forecasts', '--format', 'json'])).map((s: { id: string }) => s.id)).toEqual([saved.id]);
    const file = join(tmpdir(), `budget-${Date.now()}.csv`);
    writeFileSync(file, 'account,2026-01,2026-02\n4020,1000,1200\n');
    const b = await run(['import-budget', '--year-end', '2026-12-31', '--name', 'Plan', '--file', file, '--by', 'owner', '--format', 'json']);
    const copy = await run(['copy-budget', '--year-end', '2027-12-31', '--name', 'Next', '--from', b.id, '--percent', '+5', '--by', 'owner', '--format', 'json']);
    expect(copy).toMatchObject({ source: 'copied_budget', version: 1 });
  });

  it('reads signed percentages exactly', () => {
    expect([signedPercent('-10'), signedPercent('+2.5'), signedPercent('7.25')]).toEqual([-1_000, 250, 725]);
    expect(() => signedPercent('1.234')).toThrow(/not a percentage/);
  });
});

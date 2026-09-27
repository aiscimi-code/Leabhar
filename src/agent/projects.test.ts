import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { journalLines } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { createCompany } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { asIsoDate } from '@/domain/dates';
import { main } from '@/cli/reconcile';

let db: AppDatabase;
let companyId: string;
let lineId: string;
beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Obair Ltd', seedYears: [2026] });
  ({ companyId } = created);
  const entry = postJournalEntry(db, {
    companyId, entryDate: asIsoDate('2026-03-01'), narrative: 'Fees', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: 100_000 }, { accountId: created.accountsByCode['4020']!, creditMinor: 100_000 }],
  });
  lineId = db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id)).all().find((l) => l.creditMinor > 0)!.id;
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

describe('project costing from the CLI (EPIC 27)', () => {
  it('allocates income to a project and reports its result', async () => {
    await run(['add-project', '--code', 'P1', '--name', 'Fit-out', '--from', '2026-01-01', '--by', 'o']);
    await run(['add-job', '--project', 'P1', '--code', 'K', '--name', 'Kitchen', '--by', 'o']);
    await run(['allocate-to-project', '--line', lineId, '--project', 'P1', '--category', 'income', '--percent', '100', '--by', 'o']);
    await run(['project-budget', '--project', 'P1', '--category', 'income', '--amount', '2000', '--from', '2026-01-01', '--by', 'o']);
    const r = await run(['project-result', '--project', 'P1', '--to', '2026-12-31']) as { actual: { income: number }; budget: { income: number } };
    expect([r.actual.income, r.budget.income]).toEqual([100_000, 200_000]);
  });
});

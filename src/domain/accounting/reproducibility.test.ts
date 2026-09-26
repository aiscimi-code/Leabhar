import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { updateAccount } from '../config/mutations';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { closeFinancialYear } from './yearEnd';
import { trialBalance, generalLedger, accountBalance } from './ledger';
import { traceJournalLine } from './traceability';
import { balanceSheet } from '../reports/financial';
import {
  journalEntries, journalLines, accountingPeriods,
} from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

/**
 * Critical test for issue #370: historical transactions remain reproducible.
 *
 * A report for a past date must give the same answer every time it is run,
 * whatever happens to the books afterwards: later postings, later reversals,
 * the year-end close, and later edits to the chart of accounts. Every test
 * here runs a report, changes something that happened *after* the report's
 * date, and asserts the report did not move.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let acc: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  acc = created.accountsByKey;
});

const post = (date: ReturnType<typeof makeDate>, debitCode: string, creditCode: string, amount: number) =>
  postJournalEntry(db, {
    companyId,
    entryDate: date,
    narrative: `Entry on ${date}`,
    sourceType: 'sales_invoice',
    baseCurrency: 'EUR',
    lines: [
      { accountId: byCode[debitCode]!, debitMinor: amount },
      { accountId: byCode[creditCode]!, creditMinor: amount },
    ],
  });

describe('historical transactions remain reproducible', () => {
  it('a trial balance for a past date is unchanged by later postings', () => {
    post(makeDate(2025, 3, 31), '1010', '4000', 500_000);
    post(makeDate(2025, 5, 15), '6070', '1010', 80_000);

    const before = trialBalance(db, { companyId, asOf: makeDate(2025, 6, 30) });

    post(makeDate(2025, 8, 1), '1010', '4000', 250_000);
    post(makeDate(2025, 11, 11), '6000', '1010', 30_000);

    const after = trialBalance(db, { companyId, asOf: makeDate(2025, 6, 30) });
    expect(after).toEqual(before);

    // And the ledger for one account reads identically too.
    const ledgerBefore = generalLedger(db, {
      companyId, accountId: byCode['1010']!, to: makeDate(2025, 6, 30),
    });
    post(makeDate(2025, 9, 9), '6010', '1010', 10_000);
    const ledgerAfter = generalLedger(db, {
      companyId, accountId: byCode['1010']!, to: makeDate(2025, 6, 30),
    });
    expect(ledgerAfter.lines).toEqual(ledgerBefore.lines);
    expect(ledgerAfter.closingBalanceMinor).toBe(ledgerBefore.closingBalanceMinor);
  });

  it('a reversal dated later does not change the original period', () => {
    const entry = post(makeDate(2025, 6, 15), '6070', '1010', 42_000);

    const before = trialBalance(db, { companyId, asOf: makeDate(2025, 6, 30) });
    const reversal = reverseJournalEntry(db, {
      companyId, entryId: entry.id,
      reversalDate: makeDate(2025, 12, 31), reason: 'Posted twice',
    });

    const after = trialBalance(db, { companyId, asOf: makeDate(2025, 6, 30) });
    expect(after).toEqual(before);

    // The reversal takes effect on its own date, not retroactively.
    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2025, 12, 31),
    })).toBe(0);
    expect(reversal.entryNumber).toBeGreaterThan(entry.entryNumber);
  });

  it('a journal line keeps the account code and name it was posted with', () => {
    const entry = post(makeDate(2025, 6, 15), '6070', '1010', 42_000);

    const line = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id)).all()
      .find((l) => l.accountId === byCode['6070'])!;

    // Snapshotted at post time.
    expect(line.accountCode).toBe('6070');
    expect(line.accountName).toBe('Accountancy fees');

    // The account is renamed through the sanctioned path after the posting.
    updateAccount(db, {
      companyId, accountId: byCode['6070']!,
      changes: { name: 'Audit and compliance fees' },
    });

    const reread = db.select().from(journalLines)
      .where(eq(journalLines.id, line.id)).get()!;
    expect(reread.accountName).toBe('Accountancy fees');

    // The audit-facing trace reads the snapshot, not the renamed account.
    const trace = traceJournalLine(db, companyId, line.id);
    expect(trace!.journalLine.accountCode).toBe('6070');
    expect(trace!.journalLine.accountName).toBe('Accountancy fees');
  });

  it('the year-end close does not change a balance sheet dated before it', () => {
    post(makeDate(2025, 3, 31), '1010', '4000', 500_000);
    post(makeDate(2025, 5, 15), '6070', '1010', 80_000);

    const midYear = {
      companyId, asOf: makeDate(2025, 6, 30), financialYearStart: makeDate(2025, 1, 1),
    };
    const before = balanceSheet(db, midYear);

    const fy2025 = db.select().from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.companyId, companyId),
        eq(accountingPeriods.kind, 'financial_year'),
        eq(accountingPeriods.name, 'FY 2025'),
      )).get()!;
    closeFinancialYear(db, { companyId, periodId: fy2025.id });

    const after = balanceSheet(db, midYear);
    expect(after.netAssets.valueMinor).toBe(before.netAssets.valueMinor);
    expect(after.totalEquity.valueMinor).toBe(before.totalEquity.valueMinor);
    expect(after.profitForPeriod.valueMinor).toBe(before.profitForPeriod.valueMinor);
    expect(after.balances).toBe(true);

    // A trial balance taken mid-year is untouched by an entry dated at the
    // year end, and still balances.
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 6, 30) });
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.code === '4000')!.creditMinor).toBe(500_000);
  });

  it('a report re-run for the same date is byte-for-byte stable', () => {
    post(makeDate(2025, 2, 2), '1010', '4010', 120_000);
    post(makeDate(2025, 4, 4), '6000', '1010', 35_000);
    post(makeDate(2025, 10, 10), '6010', '1010', 12_000);

    const first = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    const second = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(second).toEqual(first);
    expect(first.balanced).toBe(true);
    expect(second.differenceMinor).toBe(0);
  });
});

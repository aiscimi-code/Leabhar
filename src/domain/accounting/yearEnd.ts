import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accountingPeriods, journalEntries, journalLines, companies, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate, type IsoDate } from '../dates';
import { postJournalEntry, atomically } from './journal';
import { trialBalance, accountBalance } from './ledger';
import { AccountingError } from './errors';
import { systemAccountId } from '../config/setup';
import type { AccountBalance } from './ledger';

export class YearEndError extends AccountingError {}

/**
 * Year-end closing entries (issue #369).
 *
 * At the end of a financial year the income and expense accounts are emptied
 * into retained earnings, so the next year starts with a clean profit and loss
 * account and the balance sheet carries the result forward in reserves. The
 * balance sheet has been telling the user to "run the year-end close" for
 * exactly this (`src/domain/reports/financial.ts`); this is that close.
 *
 * The close is one journal entry, dated on the year's end date, posted through
 * the ordinary engine — so it balances by construction, it cannot post into a
 * locked period without a deliberate override, and it is immutable like every
 * other posted entry. It is idempotent per year: a second close of the same
 * year is refused, and a wrong close is corrected by reversing the closing
 * entry and running it again, never by editing it.
 */

export interface YearEndCloseResult {
  journalEntryId: string;
  entryNumber: number;
  periodId: string;
  periodName: string;
  /** The accounts emptied, each with the side it closed on. */
  closedAccounts: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    debitMinor: number;
    creditMinor: number;
  }>;
  totalIncomeMinor: number;
  totalExpenseMinor: number;
  /** Profit positive, loss negative. */
  netResultMinor: number;
  /** Retained earnings on the close date, after the close. */
  retainedEarningsBalanceMinor: number;
}

export interface YearEndClose {
  journalEntryId: string;
  entryNumber: number;
  entryDate: IsoDate;
  /** Profit positive, loss negative, as transferred by the close. */
  netResultMinor: number;
  /** True when the closing entry itself has been reversed (the year is open again). */
  reversed: boolean;
}

/**
 * The close recorded for a financial year, or null when none has been run.
 * The profit transferred is read back off the closing entry's retained
 * earnings line, not remembered anywhere, so the query cannot disagree with
 * the books.
 */
export function getYearEndClose(
  db: AppDatabase, params: { companyId: string; periodId: string },
): YearEndClose | null {
  const entry = db.select().from(journalEntries)
    .where(and(
      eq(journalEntries.companyId, params.companyId),
      eq(journalEntries.sourceType, 'year_end_close'),
      eq(journalEntries.sourceId, params.periodId),
      eq(journalEntries.isPosted, true),
    )).get();
  if (!entry) return null;

  const retainedEarnings = systemAccountId(db, params.companyId, 'retained_earnings');
  const retainedLine = db.select().from(journalLines)
    .where(and(
      eq(journalLines.journalEntryId, entry.id),
      eq(journalLines.accountId, retainedEarnings),
    )).get();

  return {
    journalEntryId: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: asIsoDate(entry.entryDate),
    netResultMinor: (retainedLine?.baseCreditMinor ?? 0) - (retainedLine?.baseDebitMinor ?? 0),
    reversed: entry.reversedByEntryId !== null,
  };
}

/**
 * The income and expense balances standing at `asOf`. Income sits as a credit,
 * so it closes with a debit; expenses sit as a debit, so they close with a
 * credit. Accounts with no balance are not touched. Balances from earlier
 * years that were never closed are included — they belong in reserves too.
 */
function balancesToClose(
  db: AppDatabase, companyId: string, asOf: IsoDate, baseCurrency: string,
): Array<AccountBalance> {
  const tb = trialBalance(db, { companyId, asOf, baseCurrency });
  return tb.rows.filter((row) =>
    (row.type === 'income' || row.type === 'expense') && row.netDebitMinor !== 0);
}

/**
 * Close a financial year: post the single entry that empties every income and
 * expense account standing at the year's end date into retained earnings.
 *
 * Refuses to run twice for the same year. If the close was wrong, reverse the
 * closing entry (it is an ordinary entry with an ordinary reversal) and run
 * the close again.
 */
export function closeFinancialYear(
  db: AppDatabase,
  input: {
    companyId: string;
    periodId: string;
    actor?: string;
    requestId?: string;
    /** Post even though the year is closed or locked. Needs its own justification. */
    overrideLock?: { reason: string };
  },
): YearEndCloseResult {
  return atomically(db, () => {
    const company = db.select().from(companies)
      .where(eq(companies.id, input.companyId)).get();
    if (!company) throw new YearEndError(`Company ${input.companyId} not found.`);

    const period = db.select().from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.id, input.periodId),
        eq(accountingPeriods.companyId, input.companyId),
      )).get();
    if (!period) throw new YearEndError(`Accounting period ${input.periodId} not found.`);
    if (period.kind !== 'financial_year') {
      throw new YearEndError(
        `"${period.name}" is a ${period.kind.replace('_', ' ')} period, not a financial year. `
          + "The close transfers a year's result to retained earnings; pick the year.",
        { periodId: period.id, kind: period.kind },
      );
    }

    const existing = db.select().from(journalEntries)
      .where(and(
        eq(journalEntries.companyId, input.companyId),
        eq(journalEntries.sourceType, 'year_end_close'),
        eq(journalEntries.sourceId, period.id),
        eq(journalEntries.isPosted, true),
      )).get();
    if (existing && !existing.reversedByEntryId) {
      throw new YearEndError(
        `"${period.name}" is already closed by entry ${existing.entryNumber}. A second close `
        + "would move the year's result twice. If the close was wrong, reverse entry "
        + `${existing.entryNumber} and run the close again.`,
        { periodId: period.id, entryNumber: existing.entryNumber },
      );
    }

    const toClose = balancesToClose(
      db, input.companyId, asIsoDate(period.endDate), company.baseCurrency,
    );
    if (toClose.length === 0) {
      throw new YearEndError(
        `"${period.name}" has no income or expense balances standing at ${period.endDate}, `
          + 'so there is nothing to close.',
        { periodId: period.id, endDate: period.endDate },
      );
    }

    const retainedEarnings = systemAccountId(db, input.companyId, 'retained_earnings');

    const incomeLines = toClose.filter((row) => row.type === 'income')
      .map((row) => ({ account: row, debitMinor: -row.netDebitMinor }));
    const expenseLines = toClose.filter((row) => row.type === 'expense')
      .map((row) => ({ account: row, creditMinor: row.netDebitMinor }));

    const totalIncomeMinor = incomeLines.reduce((s, l) => s + l.debitMinor, 0);
    const totalExpenseMinor = expenseLines.reduce((s, l) => s + l.creditMinor, 0);
    const netResultMinor = totalIncomeMinor - totalExpenseMinor;

    const lines: Parameters<typeof postJournalEntry>[1]['lines'] = [
      ...incomeLines.map(({ account, debitMinor }) => ({
        accountId: account.accountId,
        debitMinor,
        memo: 'Year-end close',
      })),
      ...expenseLines.map(({ account, creditMinor }) => ({
        accountId: account.accountId,
        creditMinor,
        memo: 'Year-end close',
      })),
    ];

    // The net result lands in retained earnings. When income exactly equals
    // expense there is nothing to transfer and the close stands without the
    // line.
    if (netResultMinor > 0) {
      lines.push({
        accountId: retainedEarnings,
        creditMinor: netResultMinor,
        memo: 'Profit for the year, transferred to reserves',
      });
    } else if (netResultMinor < 0) {
      lines.push({
        accountId: retainedEarnings,
        debitMinor: -netResultMinor,
        memo: 'Loss for the year, transferred to reserves',
      });
    }

    const journal = postJournalEntry(db, {
      companyId: input.companyId,
      entryDate: asIsoDate(period.endDate),
      narrative: `Year-end close — ${period.name}`,
      sourceType: 'year_end_close',
      sourceId: period.id,
      entryType: 'closing',
      baseCurrency: company.baseCurrency,
      createdBy: input.actor ?? 'user',
      createdVia: 'user',
      requestId: input.requestId,
      notes: `Closing entries for ${period.name} (${period.startDate} to ${period.endDate}).`,
      overrideLock: input.overrideLock,
      lines,
    });

    db.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'accounting_period',
      entityId: period.id,
      action: 'year_end_closed',
      newValue: JSON.stringify({
        journalEntryId: journal.id,
        entryNumber: journal.entryNumber,
        closedAccounts: toClose.length,
        totalIncomeMinor,
        totalExpenseMinor,
        netResultMinor,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      requestId: input.requestId ?? null,
    }).run();

    const retainedEarningsBalanceMinor = accountBalance(db, {
      companyId: input.companyId, accountId: retainedEarnings, asOf: asIsoDate(period.endDate),
    });

    return {
      journalEntryId: journal.id,
      entryNumber: journal.entryNumber,
      periodId: period.id,
      periodName: period.name,
      closedAccounts: [
        ...incomeLines.map(({ account, debitMinor }) => ({
          accountId: account.accountId,
          accountCode: account.code,
          accountName: account.name,
          debitMinor,
          creditMinor: 0,
        })),
        ...expenseLines.map(({ account, creditMinor }) => ({
          accountId: account.accountId,
          accountCode: account.code,
          accountName: account.name,
          debitMinor: 0,
          creditMinor,
        })),
      ],
      totalIncomeMinor,
      totalExpenseMinor,
      netResultMinor,
      retainedEarningsBalanceMinor,
    };
  });
}

/**
 * Reconciliation verification tests (Work Package 11).
 *
 * These tests verify independent reconciliation between subsystems:
 *
 * 1. Bank-to-statement: the bank closing balance equals ledger opening +
 *    movements, and every difference is explained.
 *
 * 2. Transaction-to-journal: sum of classified bank transaction amounts equals
 *    sum of posted journal movements on the bank account.
 *
 * 3. Trial balance: SUM(debits) == SUM(credits) across all posted journal lines.
 *
 * 4. Opening + movements = closing for a bank account.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import {
  journalLines, journalEntries, bankTransactions,
} from '@/db/schema';
import { eq, and, sql, desc, ne } from 'drizzle-orm';
import { makeDate } from '@/domain/dates';
import { reconcileBankAccount } from '@/domain/banking/reconciliation';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let bankAccountLedgerId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Reconciliation Ltd',
    vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2025],
    baseCurrency: 'EUR',
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;

  bankAccountId = addBankAccount(db, {
    companyId,
    bankName: 'Test Bank',
    accountName: 'Business Account',
    iban: 'IE12345678',
    currency: 'EUR',
    openingBalanceMinor: 100_000,
    openingDate: makeDate(2025, 1, 1),
  });
  bankAccountLedgerId = byKey['bank_control']! ?? byCode['0100']!;
});

const BANK = () => bankAccountLedgerId;
const VAT_INPUT = () => byKey['vat_on_purchases']!;
const VAT_OUTPUT = () => byKey['vat_on_sales']!;
const EXPENSE = () => byCode['6120']!;
const INCOME = () => byCode['4000']!;

const PERIOD_START = makeDate(2025, 1, 1);
const PERIOD_END = makeDate(2025, 1, 31);

/**
 * Helper: import a bank transaction and post a classifying journal entry.
 * Mirrors the real path: import → classify → journal posted.
 */
function importAndClassify(
  amount: number, description: string, date: string,
  debitAccount: string, creditAccount: string,
): string {
  const txId = insertTestBankTransaction(db, {
    companyId, bankAccountId, amountMinor: amount, description, transactionDate: date,
  });

  postJournalEntry(db, {
    companyId,
    entryDate: date as never,
    narrative: `Classified: ${description}`,
    sourceType: 'payment',
    baseCurrency: 'EUR',
    lines: amount > 0
      ? [
          { accountId: debitAccount, debitMinor: amount },
          { accountId: creditAccount, creditMinor: amount },
        ]
      : [
          { accountId: debitAccount, debitMinor: -amount },
          { accountId: creditAccount, creditMinor: -amount },
        ],
  });

  // Link the transaction to its journal (the latest posted entry)
  const entryId = db.select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, companyId))
    .orderBy(desc(journalEntries.entryNumber))
    .limit(1).get()!.id;

  db.update(bankTransactions)
    .set({ journalEntryId: entryId, status: 'posted' })
    .where(eq(bankTransactions.id, txId))
    .run();

  return txId;
}

// --- Reconciliation #1: Bank-to-statement ---

describe('reconciliation #1 — bank-to-statement', () => {
  it('reconciles when all statement lines are classified', () => {
    importAndClassify(100_000, 'Customer payment', PERIOD_START, BANK(), INCOME());
    importAndClassify(-30_000, 'Office supplies', makeDate(2025, 1, 15), EXPENSE(), BANK());

    // Opening 100,000 + 100,000 (deposit) - 30,000 (withdrawal) = 170,000
    const result = reconcileBankAccount(db, {
      companyId, bankAccountId,
      periodStart: PERIOD_START, periodEnd: PERIOD_END,
      statementClosingBalanceMinor: 170_000,
    });

    expect(result.reconciled).toBe(true);
    expect(result.unexplainedMinor).toBe(0);
    expect(result.differenceMinor).toBe(0);
    expect(result.counts.transactionsInPeriod).toBe(2);
    expect(result.counts.unposted).toBe(0);
  });

  it('flags unexplained difference when a statement line is missing from ledger', () => {
    // Only classify one transaction
    importAndClassify(50_000, 'Customer payment', PERIOD_START, BANK(), INCOME());

    // Bank says 170,000 (100 opening + 100 - 30) but ledger only has 50,000 movement
    const result = reconcileBankAccount(db, {
      companyId, bankAccountId,
      periodStart: PERIOD_START, periodEnd: PERIOD_END,
      statementClosingBalanceMinor: 170_000,
    });

    expect(result.reconciled).toBe(false);
    expect(result.unexplainedMinor).toBe(20_000);
  });
});

// --- Reconciliation #2: Transaction-to-journal ---

describe('reconciliation #2 — transaction-to-journal', () => {
  it('sum of classified transaction amounts equals ledger movements on bank account', () => {
    importAndClassify(100_000, 'Customer payment', PERIOD_START, BANK(), INCOME());
    importAndClassify(-30_000, 'Office supplies', makeDate(2025, 1, 15), EXPENSE(), BANK());

    // Sum of bank transactions on this account
    const txSum = db.select({
      total: sql<number>`COALESCE(SUM(${bankTransactions.amountMinor}), 0)`,
    }).from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, bankAccountId))
      .get()!.total;

    // Sum of posted journal movements on the bank ledger account,
    // excluding the opening-balance entry (which reconcileBankAccount also
    // excludes in its own movementsMinor calculation).
    const ledgerSum = db.select({
      debit: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(and(
        eq(journalLines.accountId, BANK()),
        eq(journalEntries.isPosted, true),
        ne(journalEntries.sourceType, 'opening_balance'),
      ))
      .get();

    const movementsMinor = ledgerSum!.debit - ledgerSum!.credit;
    expect(movementsMinor).toBe(txSum);
  });
});

// --- Reconciliation #3: Trial balance integrity (global) ---

describe('reconciliation #3 — trial balance integrity', () => {
  it('SUM(debits) == SUM(credits) across all posted journal lines', () => {
    postJournalEntry(db, {
      companyId, entryDate: PERIOD_START as never, narrative: 'Sale',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: BANK(), debitMinor: 123_000 },
        { accountId: INCOME(), creditMinor: 100_000 },
        { accountId: VAT_OUTPUT(), creditMinor: 23_000 },
      ],
    });
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 1, 16) as never, narrative: 'Purchase',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 50_000 },
        { accountId: VAT_INPUT(), debitMinor: 11_500 },
        { accountId: BANK(), creditMinor: 61_500 },
      ],
    });

    const totals = db.select({
      totalDebit: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
      totalCredit: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(eq(journalEntries.isPosted, true))
      .get();

    // Opening balance entry (100,000 Dr BANK / 100,000 Cr RE) is posted by
    // addBankAccount; include it in the total.
    const expectedTotal = 100_000 + 123_000 + 50_000 + 11_500;
    expect(totals!.totalDebit).toBe(totals!.totalCredit);
    expect(totals!.totalDebit).toBe(expectedTotal);
  });
});

// --- Reconciliation #4: Opening + movements = closing ---

describe('reconciliation #4 — opening + movements = closing', () => {
  it('ledger balance equals opening balance plus movements', () => {
    const opening = 100_000;

    importAndClassify(50_000, 'Customer payment', PERIOD_START, BANK(), INCOME());
    importAndClassify(-20_000, 'Office supplies', makeDate(2025, 1, 15), EXPENSE(), BANK());

    const result = reconcileBankAccount(db, {
      companyId, bankAccountId,
      periodStart: PERIOD_START, periodEnd: PERIOD_END,
      statementClosingBalanceMinor: opening + 50_000 - 20_000,
    });

    expect(result.openingBalanceMinor).toBe(opening);
    const expectedClosing = opening + result.movementsMinor;
    expect(result.ledgerBalanceMinor).toBe(expectedClosing);
    expect(result.ledgerBalanceMinor).toBe(130_000);
    expect(result.reconciled).toBe(true);
  });
});

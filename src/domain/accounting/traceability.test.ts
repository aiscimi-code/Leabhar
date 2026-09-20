/**
 * Source-to-ledger traceability tests (Work Package 05).
 *
 * Proves that traceability survives import → classification → posting →
 * reconciliation → reporting.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { postJournalEntry } from './journal';
import { traceJournalLine, traceBankTransaction } from './traceability';
import { journalEntries, journalLines, bankTransactions, statementImports } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate } from '@/domain/dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;
let bankAccountId: string;

function debit(cents: number) { return { debitMinor: cents }; }
function credit(cents: number) { return { creditMinor: cents }; }

const EXPENSE = () => byCode['6120']!;
const VAT_INPUT = () => byKey['vat_on_purchases']!;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Traceability Ltd',
    vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;
  bankAccountId = addBankAccount(db, {
    companyId,
    bankName: 'BOI',
    accountName: 'Current',
    openingDate: '2025-01-01',
    accountId: byKey['bank_control'],
  });
});

function insertBankTx(description: string, amountMinor: number, fingerprint: string): string {
  const bankTxId = ids.bankTransaction();
  db.insert(bankTransactions).values({
    id: bankTxId,
    companyId,
    bankAccountId,
    transactionDate: '2025-06-15',
    description,
    amountMinor,
    currency: 'EUR',
    fingerprint,
    occurrenceIndex: 0,
    source: 'import',
    provenanceStatus: 'imported',
  }).run();
  return bankTxId;
}

describe('traceability — import → posting → ledger', () => {
  it('traces a journal line back through its entry to the source bank transaction', () => {
    const bankTxId = insertBankTx('Purchase from Irish supplier', -12_300, 'trace-0');

    const entry = postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Purchase from Irish supplier',
      sourceType: 'bank_transaction',
      sourceId: bankTxId,
      baseCurrency: 'EUR',
      createdVia: 'rule',
      lines: [
        { accountId: EXPENSE(), ...debit(10_000) },
        { accountId: VAT_INPUT(), ...debit(2_300) },
        { accountId: byKey['bank_control']!, ...credit(12_300) },
      ],
    });

    const expenseLine = db
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .limit(1)
      .get();

    const trace = traceJournalLine(db, companyId, expenseLine!.id);

    expect(trace).not.toBeNull();
    expect(trace!.journalLine.accountCode).toBe('6120');
    expect(trace!.journalEntry.entryNumber).toBe(1);
    expect(trace!.journalEntry.sourceType).toBe('bank_transaction');
    expect(trace!.journalEntry.sourceId).toBe(bankTxId);
    expect(trace!.journalEntry.provenanceStatus).toBe('system_rule');
    expect(trace!.sourceTransaction).toBeDefined();
    expect(trace!.sourceTransaction!.id).toBe(bankTxId);
    expect(trace!.sourceTransaction!.description).toBe('Purchase from Irish supplier');
    expect(trace!.sourceTransaction!.amountMinor).toBe(-12_300);
  });

  it('traces forward from a bank transaction to its ledger lines', () => {
    const bankTxId = insertBankTx('Office supplies', -50_000, 'trace-1');

    postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Office supplies purchase',
      sourceType: 'bank_transaction',
      sourceId: bankTxId,
      baseCurrency: 'EUR',
      createdVia: 'rule',
      lines: [
        { accountId: EXPENSE(), ...debit(50_000) },
        { accountId: byKey['bank_control']!, ...credit(50_000) },
      ],
    });

    const trace = traceBankTransaction(db, companyId, bankTxId);

    expect(trace).not.toBeNull();
    expect(trace!.bankTransaction.id).toBe(bankTxId);
    expect(trace!.journalEntries).toHaveLength(1);
    expect(trace!.journalEntries[0]!.lines).toHaveLength(2);
    expect(trace!.journalEntries[0]!.lines.some((l) => l.accountCode === '6120')).toBe(true);
    expect(trace!.journalEntries[0]!.lines.some((l) => l.accountCode === '1000')).toBe(true); // bank_control
  });
});

describe('traceability — survives posting', () => {
  it('journal entry id is stable and queryable after posting', () => {
    const entry = postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Test entry',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), ...debit(10_000) },
        { accountId: byKey['bank_control']!, ...credit(10_000) },
      ],
    });

    const saved = db
      .select({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        isPosted: journalEntries.isPosted,
        sourceType: journalEntries.sourceType,
      })
      .from(journalEntries)
      .where(eq(journalEntries.id, entry.id))
      .get();

    expect(saved).toBeDefined();
    expect(saved!.isPosted).toBe(true);
    expect(saved!.entryNumber).toBeGreaterThan(0);

    const lines = db
      .select({ id: journalLines.id, journalEntryId: journalLines.journalEntryId })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .all();

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.journalEntryId === entry.id)).toBe(true);
  });
});

describe('traceability — survives reconciliation', () => {
  it('reconciled bank transaction links back to journal entry', () => {
    const bankTxId = insertBankTx('Payment to supplier', -12_300, 'trace-2');

    const entry = postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Supplier payment',
      sourceType: 'bank_transaction',
      sourceId: bankTxId,
      baseCurrency: 'EUR',
      createdVia: 'rule',
      lines: [
        { accountId: EXPENSE(), ...debit(10_000) },
        { accountId: VAT_INPUT(), ...debit(2_300) },
        { accountId: byKey['bank_control']!, ...credit(12_300) },
      ],
    });

    // "Reconcile" the bank transaction by marking it posted and linking the journal.
    db.update(bankTransactions)
      .set({ status: 'reconciled', journalEntryId: entry.id, reconciledAt: '2025-06-20' })
      .where(eq(bankTransactions.id, bankTxId))
      .run();

    // Trace forward: bank transaction → journal entry
    const trace = traceBankTransaction(db, companyId, bankTxId);
    expect(trace).not.toBeNull();
    expect(trace!.journalEntries).toHaveLength(1);
    expect(trace!.journalEntries[0]!.lines).toHaveLength(3);

    // Trace backward: journal line → bank transaction
    const line = db
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .get();

    const backwardTrace = traceJournalLine(db, companyId, line!.id);
    expect(backwardTrace).not.toBeNull();
    expect(backwardTrace!.sourceTransaction).toBeDefined();
    expect(backwardTrace!.sourceTransaction!.id).toBe(bankTxId);
  });
});

describe('traceability — survives reporting', () => {
  it('ledger entries from reports can be traced back to source documents', () => {
    const bankTxId = insertBankTx('Software license', -123_000, 'trace-3');

    const entry = postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Annual software license',
      sourceType: 'bank_transaction',
      sourceId: bankTxId,
      baseCurrency: 'EUR',
      createdVia: 'rule',
      lines: [
        { accountId: byCode['6000']!, ...debit(100_000) }, // Software
        { accountId: VAT_INPUT(), ...debit(23_000) },       // VAT input
        { accountId: byKey['bank_control']!, ...credit(123_000) }, // Bank
      ],
    });

    // Simulate a report query: find all journal lines for a source transaction.
    const reportLines = db
      .select({ lineId: journalLines.id, entryId: journalLines.journalEntryId })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(eq(journalEntries.sourceId, bankTxId))
      .all();

    for (const rl of reportLines) {
      const trace = traceJournalLine(db, companyId, rl.lineId);
      expect(trace).not.toBeNull();
      expect(trace!.sourceTransaction).toBeDefined();
      expect(trace!.sourceTransaction!.id).toBe(bankTxId);
      expect(trace!.journalEntry.id).toBe(entry.id);
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { recordManualTransaction } from './import';
import { classifyTransaction } from './classify';
import { reconcileBankAccount } from './reconciliation';
import { linkBankTransactionToJournal, suggestJournalMatches, JournalLinkError } from './journalLink';
import { reverseJournalEntry } from '../accounting/journal';
import { bankAccounts, bankTransactions } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let current: string;
let saver: string;
let treatments: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] });
  companyId = created.companyId;
  treatments = created.treatmentsByCode;
  current = addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01' });
  saver = addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Saver', accountType: 'savings', openingDate: '2025-01-01' });
});

const ledgerOf = (bankAccountId: string) =>
  db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get()!.accountId!;

/** Move 500.00 from the current account to the saver: two statement lines, one journal. */
function transfer() {
  const out = recordManualTransaction(db, {
    companyId, bankAccountId: current, transactionDate: '2025-04-01',
    description: 'Transfer to saver', amountMinor: -50_000, recordedBy: 'joseph',
  });
  const inbound = recordManualTransaction(db, {
    companyId, bankAccountId: saver, transactionDate: '2025-04-02',
    description: 'Transfer from current', amountMinor: 50_000, recordedBy: 'joseph',
  });
  const posted = classifyTransaction(db, {
    companyId, bankTransactionId: out.transactionId,
    accountId: ledgerOf(saver), vatTreatmentId: treatments['OUT_OF_SCOPE']!,
  });
  return { out: out.transactionId, inbound: inbound.transactionId, journalEntryId: posted.journalEntryId };
}

const reconcile = (bankAccountId: string, statementClosingBalanceMinor: number) => reconcileBankAccount(db, {
  companyId, bankAccountId, periodStart: makeDate(2025, 4, 1), periodEnd: makeDate(2025, 4, 30),
  statementClosingBalanceMinor,
});

describe('a line whose movement is already a posted journal (#385)', () => {
  it('suggests the transfer journal and, once linked, both accounts reconcile', () => {
    const { inbound, journalEntryId } = transfer();

    // Before linking: the saver shows the journal as ledger-only and the line as unposted.
    const before = reconcile(saver, 50_000);
    expect(before.counts.ledgerOnly).toBe(1);
    expect(before.counts.unposted).toBe(1);

    const suggestions = suggestJournalMatches(db, { companyId, bankTransactionId: inbound });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ journalEntryId, amountMinor: 50_000, transferFromBankAccount: current });

    linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: inbound, journalEntryId, actor: 'joseph', reason: 'Transfer from current',
    });
    expect(db.select().from(bankTransactions).where(eq(bankTransactions.id, inbound)).get())
      .toMatchObject({ journalEntryId, status: 'posted' });

    expect(reconcile(saver, 50_000)).toMatchObject({ differenceMinor: 0, counts: expect.objectContaining({ ledgerOnly: 0, unposted: 0 }) });
    expect(reconcile(current, -50_000)).toMatchObject({ differenceMinor: 0, counts: expect.objectContaining({ ledgerOnly: 0, unposted: 0 }) });
    // Linked once, it is no longer suggested.
    expect(suggestJournalMatches(db, { companyId, bankTransactionId: inbound })).toEqual([]);
  });

  it('refuses a journal that does not move exactly the line\'s amount on this account', () => {
    const { journalEntryId } = transfer();
    const other = recordManualTransaction(db, {
      companyId, bankAccountId: saver, transactionDate: '2025-04-02',
      description: 'Something else', amountMinor: 49_999, recordedBy: 'joseph',
    });
    expect(() => linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: other.transactionId, journalEntryId, actor: 'joseph', reason: 'x',
    })).toThrow(/exactly/);
  });

  it('refuses a reversed journal, a second link, and a link with no reason', () => {
    const { inbound, journalEntryId } = transfer();
    expect(() => linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: inbound, journalEntryId, actor: 'joseph', reason: ' ',
    })).toThrow(JournalLinkError);

    linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: inbound, journalEntryId, actor: 'joseph', reason: 'Transfer',
    });
    const second = recordManualTransaction(db, {
      companyId, bankAccountId: saver, transactionDate: '2025-04-02',
      description: 'Transfer from current', amountMinor: 50_000, recordedBy: 'joseph',
    });
    expect(() => linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: second.transactionId, journalEntryId, actor: 'joseph', reason: 'Again',
    })).toThrow(/already evidences/);

    const { journalEntryId: another } = transfer();
    reverseJournalEntry(db, { companyId, entryId: another, reversalDate: makeDate(2025, 4, 3), reason: 'Wrong' });
    expect(() => linkBankTransactionToJournal(db, {
      companyId, bankTransactionId: second.transactionId, journalEntryId: another, actor: 'joseph', reason: 'x',
    })).toThrow(/reversed/);
  });
});

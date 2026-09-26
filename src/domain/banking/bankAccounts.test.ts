import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount, addLoan } from '../config/setup';
import { classifyTransaction } from './classify';
import { recordManualTransaction } from './import';
import { reconcileBankAccount } from './reconciliation';
import { accountBalance } from '../accounting/ledger';
import { accounts, bankAccounts, bankTransactions, statementImports } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let treatments: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  treatments = created.treatmentsByCode;
});

const ledgerOf = (bankAccountId: string) => {
  const bank = db.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).get()!;
  return db.select().from(accounts).where(eq(accounts.id, bank.accountId!)).get()!;
};

const add = (accountName: string, accountType: Parameters<typeof addBankAccount>[1]['accountType'], extra = {}) =>
  addBankAccount(db, {
    companyId, bankName: 'AIB', accountName, accountType, openingDate: '2025-01-01', ...extra,
  });

describe('each bank account posts to its own ledger account (#376)', () => {
  it('uses the seeded account for the first of each kind, then creates one per account', () => {
    expect(ledgerOf(add('Current', 'current')).code).toBe('1000');
    const second = ledgerOf(add('Second current', 'current'));
    expect(second.code).toBe('1001');
    expect(second).toMatchObject({ type: 'asset', reportSection: 'current_assets', name: 'Bank — AIB Second current' });

    expect(ledgerOf(add('Saver', 'savings')).code).toBe('1020');
    expect(ledgerOf(add('Deposit', 'deposit')).code).toBe('1021');
  });

  it('reconciles each account against its own movements only', () => {
    const first = add('Current', 'current');
    const second = add('Second current', 'current');
    const one = recordManualTransaction(db, {
      companyId, bankAccountId: first, transactionDate: '2025-03-01',
      description: 'Office supplies', amountMinor: -12_300, recordedBy: 'joseph',
    });
    const two = recordManualTransaction(db, {
      companyId, bankAccountId: second, transactionDate: '2025-03-02',
      description: 'Stationery', amountMinor: -4_500, recordedBy: 'joseph',
    });
    for (const { transactionId } of [one, two]) {
      classifyTransaction(db, {
        companyId, bankTransactionId: transactionId,
        accountId: byCode['6010']!, vatTreatmentId: treatments['OUT_OF_SCOPE']!,
      });
    }

    const recOne = reconcileBankAccount(db, {
      companyId, bankAccountId: first, periodStart: makeDate(2025, 1, 1), periodEnd: makeDate(2025, 12, 31),
      statementClosingBalanceMinor: -12_300,
    });
    const recTwo = reconcileBankAccount(db, {
      companyId, bankAccountId: second, periodStart: makeDate(2025, 1, 1), periodEnd: makeDate(2025, 12, 31),
      statementClosingBalanceMinor: -4_500,
    });
    expect(recOne).toMatchObject({ ledgerBalanceMinor: -12_300, differenceMinor: 0, warnings: [] });
    expect(recTwo).toMatchObject({ ledgerBalanceMinor: -4_500, differenceMinor: 0, warnings: [] });
  });

  it('warns, rather than repairs, when an older book has two accounts on one ledger account', () => {
    const first = add('Current', 'current');
    const shared = addBankAccount(db, {
      companyId, bankName: 'BOI', accountName: 'Business', openingDate: '2025-01-01',
      accountId: ledgerOf(first).id,
    });
    const rec = reconcileBankAccount(db, {
      companyId, bankAccountId: shared, periodStart: makeDate(2025, 1, 1), periodEnd: makeDate(2025, 12, 31),
      statementClosingBalanceMinor: 0,
    });
    expect(rec.warnings).toHaveLength(1);
    expect(rec.warnings[0]).toContain('AIB Current');
  });
});

describe('credit card, cash and loan accounts (#377)', () => {
  it('gives a credit card a current liability, and card spending increases what is owed', () => {
    const card = add('Visa', 'credit_card', { openingBalanceMinor: -50_000 });
    const ledger = ledgerOf(card);
    expect(ledger).toMatchObject({
      code: '2150', type: 'liability', subtype: 'current_liability', reportSection: 'current_liabilities',
    });

    const spend = recordManualTransaction(db, {
      companyId, bankAccountId: card, transactionDate: '2025-04-10',
      description: 'Software subscription', amountMinor: -10_000, recordedBy: 'joseph',
    });
    classifyTransaction(db, {
      companyId, bankTransactionId: spend.transactionId,
      accountId: byCode['6010']!, vatTreatmentId: treatments['OUT_OF_SCOPE']!,
    });
    // Owed on the card: the 500.00 brought in plus 100.00 spent. A liability's
    // balance reads positive on its normal (credit) side.
    expect(accountBalance(db, { companyId, accountId: ledger.id, asOf: makeDate(2025, 12, 31) }))
      .toBe(60_000);
  });

  it('gives cash the seeded Cash account first, then one per cash account', () => {
    const tin = ledgerOf(add('Petty cash', 'cash'));
    expect(tin).toMatchObject({ code: '1010', type: 'asset' });
    expect(ledgerOf(add('Till', 'cash')).code).toBe('1011');
  });

  it('posts a loan account to the loan\'s own liability, or to a new non-current one', () => {
    const loanId = addLoan(db, {
      companyId, lenderName: 'SBCI', openingPrincipalMinor: 0, openingDate: '2025-01-01',
    });
    const loanLedger = db.select().from(accounts).where(eq(accounts.code, '2211')).get()!;
    expect(ledgerOf(add('SBCI loan', 'loan', { loanId })).id).toBe(loanLedger.id);

    const other = ledgerOf(add('Van loan', 'loan'));
    expect(other).toMatchObject({ code: '2212', type: 'liability', reportSection: 'long_term_liabilities' });
  });
});

describe('recording a movement by hand (#377)', () => {
  it('records the line as manual evidence traced to a manual import', () => {
    const tin = add('Petty cash', 'cash');
    const { importId, transactionId } = recordManualTransaction(db, {
      companyId, bankAccountId: tin, transactionDate: '2025-05-02',
      description: 'Milk and tea', amountMinor: -650, recordedBy: 'joseph',
    });
    const line = db.select().from(bankTransactions).where(eq(bankTransactions.id, transactionId)).get()!;
    expect(line).toMatchObject({
      statementImportId: importId, source: 'user', provenanceStatus: 'manually_entered',
      status: 'unclassified', amountMinor: -650, currency: 'EUR',
    });
    const run = db.select().from(statementImports).where(eq(statementImports.id, importId)).get()!;
    expect(run).toMatchObject({ fileFormat: 'manual', importedBy: 'joseph', status: 'completed' });
  });

  it('keeps two identical entries, and refuses one with no person, description or amount', () => {
    const tin = add('Petty cash', 'cash');
    const entry = {
      companyId, bankAccountId: tin, transactionDate: '2025-05-02',
      description: 'Parking', amountMinor: -300, recordedBy: 'joseph',
    };
    const a = recordManualTransaction(db, entry);
    const b = recordManualTransaction(db, entry);
    const rows = [a, b].map(({ transactionId }) =>
      db.select().from(bankTransactions).where(eq(bankTransactions.id, transactionId)).get()!);
    expect(rows.map((r) => r.occurrenceIndex)).toEqual([0, 1]);

    expect(() => recordManualTransaction(db, { ...entry, recordedBy: ' ' })).toThrow(/who is recording/);
    expect(() => recordManualTransaction(db, { ...entry, description: '' })).toThrow(/Describe/);
    expect(() => recordManualTransaction(db, { ...entry, amountMinor: 0 })).toThrow(/not zero/);
  });
});

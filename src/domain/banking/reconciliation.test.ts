import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from './import';
import { classifyTransaction } from './classify';
import { reconcileBankAccount, completeReconciliation, ReconciliationError } from './reconciliation';
import { postJournalEntry } from '../accounting/journal';
import { bankTransactions, reconciliations, auditEvents } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

const STATEMENT = [
  'Date,Description,Amount,Balance',
  '05/01/2025,OPENING TRANSFER,1000.00,1000.00',
  '15/01/2025,VERCEL INC,-42.17,957.83',
  '20/01/2025,BYRNE ACCOUNTANCY,-615.00,342.83',
].join('\n');

const COLUMNS = {
  Date: 'transaction_date' as const,
  Description: 'description' as const,
  Amount: 'amount' as const,
  Balance: 'balance' as const,
};

const PERIOD = { periodStart: makeDate(2025, 1, 1), periodEnd: makeDate(2025, 1, 31) };

beforeEach(async () => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
  await importStatement(db, {
    companyId, bankAccountId, filename: 'jan.csv',
    content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
  });
});

const classifyAll = () => {
  for (const transaction of db.select().from(bankTransactions).all()) {
    if (transaction.journalEntryId) continue;
    classifyTransaction(db, {
      companyId, bankTransactionId: transaction.id,
      accountId: transaction.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
      vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });
  }
};

const reconcile = (over: Record<string, unknown> = {}) =>
  reconcileBankAccount(db, { companyId, bankAccountId, ...PERIOD, ...over });

describe('reconcileBankAccount', () => {
  it('reads the statement balance from the statement, not from the ledger', () => {
    const result = reconcile();
    expect(result.statementBalanceMinor).toBe(34_283);
    expect(result.statementBalanceSource).toBe('statement_running_balance');
  });

  it('agrees exactly once everything is classified', () => {
    classifyAll();
    const result = reconcile();
    expect(result.ledgerBalanceMinor).toBe(34_283);
    expect(result.differenceMinor).toBe(0);
    expect(result.unexplainedMinor).toBe(0);
    expect(result.reconciled).toBe(true);
    expect(result.summary).toContain('agree exactly');
  });

  it('explains a difference caused by unclassified lines', () => {
    // Classify only the first transaction.
    const first = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'OPENING TRANSFER')).get()!;
    classifyTransaction(db, {
      companyId, bankTransactionId: first.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });

    const result = reconcile();
    expect(result.differenceMinor).toBe(-65_717);
    // Fully explained by the two unclassified lines, so still reconciled.
    expect(result.unexplainedMinor).toBe(0);
    expect(result.reconciled).toBe(true);
    expect(result.counts.unposted).toBe(2);
    expect(result.summary).toContain('not yet classified');

    const items = result.items.filter((i) => i.kind === 'statement_not_in_ledger');
    expect(items).toHaveLength(2);
    expect(items[0]!.explanation).toContain('Classify it to remove this difference');
  });

  it('explains a ledger entry with no statement line behind it', () => {
    classifyAll();
    // A payment recorded in the books before it cleared the bank.
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 1, 28),
      narrative: 'Supplier payment not yet cleared',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6070']!, debitMinor: 20_000 },
        { accountId: acc['bank_control']!, creditMinor: 20_000 },
      ],
    });

    const result = reconcile();
    expect(result.differenceMinor).toBe(20_000);
    expect(result.unexplainedMinor).toBe(0);
    expect(result.reconciled).toBe(true);

    const item = result.items.find((i) => i.kind === 'ledger_not_on_statement')!;
    expect(item.amountMinor).toBe(-20_000);
    expect(item.explanation).toContain('has not cleared yet');
  });

  // The case reconciliation exists to catch.
  it('refuses to call an unexplained difference reconciled', () => {
    classifyAll();
    const result = reconcile({ statementClosingBalanceMinor: 99_999 });

    expect(result.reconciled).toBe(false);
    expect(result.unexplainedMinor).not.toBe(0);
    expect(result.summary).toContain('nothing accounts for');
    expect(result.summary).toContain('missing, duplicated or miscoded');
    expect(result.summary).toContain('do not treat these figures as final');
  });

  it('warns when the statement balance had to be derived from movements', async () => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] });
    companyId = created.companyId;
    acc = created.accountsByKey;
    bankAccountId = addBankAccount(db, {
      companyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: acc['bank_control'],
    });
    await importStatement(db, {
      companyId, bankAccountId, filename: 'nobalance.csv',
      content: 'Date,Description,Amount\n15/01/2025,VERCEL,-42.17',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });

    const result = reconcile();
    expect(result.statementBalanceSource).toBe('derived_from_movements');
    expect(result.summary).toContain('cannot detect a statement line that was never imported');
  });

  it('prefers a supplied closing balance over the imported one', () => {
    const result = reconcile({ statementClosingBalanceMinor: 34_283 });
    expect(result.statementBalanceSource).toBe('supplied');
    expect(result.statementBalanceMinor).toBe(34_283);
  });

  it('flags same-day identical charges without treating them as an error', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'dupes.csv',
      content: [
        'Date,Description,Amount,Balance',
        '25/01/2025,APP STORE,-9.99,332.84',
        '25/01/2025,APP STORE,-9.99,322.85',
      ].join('\n'),
      fileFormat: 'csv', columnMap: COLUMNS,
    });

    const result = reconcile();
    expect(result.counts.suspectedDuplicates).toBe(2);
    const item = result.items.find((i) => i.kind === 'suspected_duplicate')!;
    expect(item.explanation).toContain('That can be genuine');
    expect(item.explanation).toContain('reclaim the same VAT twice');
  });

  it('does not flag duplicates the bank gave distinct ids', async () => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] });
    companyId = created.companyId;
    acc = created.accountsByKey;
    bankAccountId = addBankAccount(db, {
      companyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: acc['bank_control'],
    });
    await importStatement(db, {
      companyId, bankAccountId, filename: 'ids.csv',
      content: [
        'Date,Description,Amount,TxId',
        '25/01/2025,APP STORE,-9.99,A1',
        '25/01/2025,APP STORE,-9.99,A2',
      ].join('\n'),
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', TxId: 'bank_transaction_id',
      },
    });
    expect(reconcile().counts.suspectedDuplicates).toBe(0);
  });

  it('ignores transactions outside the period', () => {
    classifyAll();
    const result = reconcile({ periodStart: makeDate(2025, 1, 16), periodEnd: makeDate(2025, 1, 31) });
    expect(result.counts.transactionsInPeriod).toBe(1);
  });
});

describe('completeReconciliation', () => {
  it('records the reconciliation and marks the transactions', () => {
    classifyAll();
    const { reconciliationId, result } = completeReconciliation(db, {
      companyId, bankAccountId, ...PERIOD, actor: 'joseph',
    });

    expect(result.reconciled).toBe(true);
    const record = db.select().from(reconciliations)
      .where(eq(reconciliations.id, reconciliationId)).get()!;
    expect(record.status).toBe('balanced');
    expect(record.statementClosingBalanceMinor).toBe(34_283);
    expect(record.ledgerBalanceMinor).toBe(34_283);

    const transactions = db.select().from(bankTransactions).all();
    expect(transactions.every((t) => t.status === 'reconciled')).toBe(true);
    expect(transactions.every((t) => t.reconciliationId === reconciliationId)).toBe(true);
  });

  it('never alters the imported evidence', () => {
    classifyAll();
    const before = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;

    completeReconciliation(db, { companyId, bankAccountId, ...PERIOD });

    const after = db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, before.id)).get()!;
    expect(after.amountMinor).toBe(before.amountMinor);
    expect(after.transactionDate).toBe(before.transactionDate);
    expect(after.description).toBe(before.description);
    expect(after.balanceAfterMinor).toBe(before.balanceAfterMinor);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('refuses to complete with an unexplained difference', () => {
    classifyAll();
    expect(() => completeReconciliation(db, {
      companyId, bankAccountId, ...PERIOD, statementClosingBalanceMinor: 99_999,
    })).toThrow(ReconciliationError);
    expect(() => completeReconciliation(db, {
      companyId, bankAccountId, ...PERIOD, statementClosingBalanceMinor: 99_999,
    })).toThrow(/NOT RECONCILED/);
    expect(db.select().from(reconciliations).all()).toHaveLength(0);
  });

  it('allows completing with a difference when the reason is recorded', () => {
    classifyAll();
    const { reconciliationId } = completeReconciliation(db, {
      companyId, bankAccountId, ...PERIOD,
      statementClosingBalanceMinor: 99_999,
      acceptDifference: { reason: 'Bank error, raised with BOI, credit expected next month' },
    });

    const record = db.select().from(reconciliations)
      .where(eq(reconciliations.id, reconciliationId)).get()!;
    expect(record.status).toBe('unbalanced');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'reconciled')).get()!;
    expect(audit.reason).toContain('Bank error');
  });

  it('leaves unclassified transactions unreconciled', () => {
    const first = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'OPENING TRANSFER')).get()!;
    classifyTransaction(db, {
      companyId, bankTransactionId: first.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });

    completeReconciliation(db, { companyId, bankAccountId, ...PERIOD });

    const transactions = db.select().from(bankTransactions).all();
    expect(transactions.filter((t) => t.status === 'reconciled')).toHaveLength(1);
    expect(transactions.filter((t) => t.status === 'unclassified')).toHaveLength(2);
  });
});

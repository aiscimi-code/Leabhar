import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount, systemAccountId } from '../config/setup';
import { classifyTransaction, reclassifyTransaction, recordDirectorPaidExpense } from './classify';
import { importStatement } from './import';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { buildVat3Return } from '../vat/report';
import {
  bankTransactions, journalEntries, journalLines, vatEntries, vatPeriods,
  companyOfficers, auditEvents,
} from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

const importOne = async (description: string, amount: string, date = '15/03/2025') => {
  await importStatement(db, {
    companyId, bankAccountId, filename: `${description}.csv`,
    content: `Date,Description,Amount\n${date},${description},${amount}`,
    fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return db.select().from(bankTransactions)
    .where(eq(bankTransactions.description, description)).get()!;
};

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Ltd', vatRegistrationStatus: 'registered',
    vatNumber: 'IE1234567T', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
    accountId: acc['bank_control'],
  });
});

describe('classifyTransaction — domestic purchase', () => {
  it('splits a VAT-inclusive payment into net expense, VAT and bank', async () => {
    const tx = await importOne('IRISH SUPPLIER', '-123.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });

    expect(result.netMinor).toBe(10_000);
    expect(result.vatMinor).toBe(2_300);
    expect(result.grossMinor).toBe(12_300);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ accountId: byCode['6010'], debitMinor: 10_000 });
    expect(lines[1]).toMatchObject({ accountId: acc['vat_on_purchases'], debitMinor: 2_300 });
    expect(lines[2]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 12_300 });
  });

  it('leaves the books balanced', async () => {
    const tx = await importOne('IRISH SUPPLIER', '-123.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('does not mutate the imported evidence', async () => {
    const tx = await importOne('IRISH SUPPLIER', '-123.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });
    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.amountMinor).toBe(tx.amountMinor);
    expect(after.description).toBe(tx.description);
    expect(after.transactionDate).toBe(tx.transactionDate);
    expect(after.fingerprint).toBe(tx.fingerprint);
    // Only the classification columns moved.
    expect(after.status).toBe('posted');
    expect(after.accountId).toBe(byCode['6010']);
  });

  it('refuses to post the same transaction twice', async () => {
    const tx = await importOne('IRISH SUPPLIER', '-123.00');
    const args = {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    };
    classifyTransaction(db, args);
    expect(() => classifyTransaction(db, args)).toThrow(/already been posted/);
  });
});

describe('classifyTransaction — reverse charge', () => {
  it('treats the payment as net and self-accounts the VAT', async () => {
    // A $120 Anthropic invoice carries no VAT. 120 is the NET.
    const tx = await importOne('ANTHROPIC', '-120.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });

    expect(result.netMinor).toBe(12_000);
    expect(result.vatMinor).toBe(2_760);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    // Expense at net, input VAT debited, output VAT credited, bank credited
    // with only what actually left the account.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ accountId: byCode['6000'], debitMinor: 12_000 });
    expect(lines[1]).toMatchObject({ accountId: acc['vat_on_purchases'], debitMinor: 2_760 });
    expect(lines[2]).toMatchObject({ accountId: acc['vat_on_sales'], creditMinor: 2_760 });
    expect(lines[3]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 12_000 });
  });

  it('balances, and nets to zero on the VAT return', async () => {
    const tx = await importOne('ANTHROPIC', '-120.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(2_760);
    expect(report.T2.amountMinor).toBe(2_760);
    expect(report.netPositionMinor).toBe(0);
  });

  it('charges the bank only what actually left the account', async () => {
    const tx = await importOne('ANTHROPIC', '-120.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(-12_000);
  });
});

describe('classifyTransaction — income', () => {
  it('splits a receipt into bank, income at net and VAT owed', async () => {
    const tx = await importOne('CUSTOMER PAYMENT', '1230.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!,
    });

    expect(result.netMinor).toBe(100_000);
    expect(result.vatMinor).toBe(23_000);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();
    expect(lines[0]).toMatchObject({ accountId: acc['bank_control'], debitMinor: 123_000 });
    expect(lines[1]).toMatchObject({ accountId: byCode['4000'], creditMinor: 100_000 });
    expect(lines[2]).toMatchObject({ accountId: acc['vat_on_sales'], creditMinor: 23_000 });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('puts the VAT in T1', async () => {
    const tx = await importOne('CUSTOMER PAYMENT', '1230.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!,
    });
    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T1.amountMinor)
      .toBe(23_000);
  });
});

describe('classifyTransaction — non-recoverable VAT', () => {
  it('charges irrecoverable VAT to the expense rather than reclaiming it', async () => {
    const tx = await importOne('ENTERTAINMENT', '-123.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6110']!, vatTreatmentId: tr['NON_DEDUCTIBLE']!,
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    // The whole 123.00 is a cost; nothing goes to VAT recoverable.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: byCode['6110'], debitMinor: 12_300 });
    expect(lines[1]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 12_300 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(0);
  });
});

describe('classifyTransaction — outside scope', () => {
  it('posts with no VAT at all', async () => {
    const tx = await importOne('TRANSFER TO SAVINGS', '-500.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['1010']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });
    expect(result.vatMinor).toBe(0);
    const entries = db.select().from(vatEntries)
      .where(eq(vatEntries.sourceId, tx.id)).all();
    expect(entries).toHaveLength(0);
  });
});

describe('foreign currency', () => {
  it('refuses a foreign transaction with no rate', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'usd.csv',
      content: 'Date,Description,Amount,Currency\n15/03/2025,US SUPPLIER,-120.00,USD',
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', Currency: 'currency',
      },
    });
    const tx = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'US SUPPLIER')).get()!;

    expect(() => classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
    })).toThrow(/never an assumed 1\.0/);
  });

  it('converts using the supplied rate and keeps the original amount', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'usd.csv',
      content: 'Date,Description,Amount,Currency\n15/03/2025,US SUPPLIER,-120.00,USD',
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', Currency: 'currency',
      },
    });
    const tx = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'US SUPPLIER')).get()!;

    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
      fxRate: { numerator: 92, denominator: 100, source: 'ecb', date: '2025-03-15' },
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId)).all();
    const expense = lines.find((l) => l.accountId === byCode['6000'])!;
    expect(expense.debitMinor).toBe(12_000);
    expect(expense.currency).toBe('USD');
    expect(expense.baseDebitMinor).toBe(11_040);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });
});

describe('reclassifyTransaction', () => {
  it('reverses the original and posts a new classification', async () => {
    const tx = await importOne('MISCODED', '-123.00');
    const first = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });

    const second = reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
      reason: 'Should have been software, not hosting',
    });

    // Original entry survives, flagged as reversed.
    const original = db.select().from(journalEntries)
      .where(eq(journalEntries.id, first.journalEntryId)).get()!;
    expect(original.reversedByEntryId).toBeTruthy();

    // Net effect: hosting back to zero, software carries the cost.
    expect(accountBalance(db, { companyId, accountId: byCode['6010']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byCode['6000']! })).toBe(10_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
  });

  it('removes the superseded VAT entries from the return', async () => {
    const tx = await importOne('MISCODED', '-123.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });
    reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_ZERO']!,
      reason: 'Zero rated after all',
    });

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    // Only the new zero-rated entry counts; the superseded 23% one does not.
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T2.amountMinor).toBe(0);
  });

  it('records the reason in the audit trail', async () => {
    const tx = await importOne('MISCODED', '-123.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });
    reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
      reason: 'Agreed with accountant',
    });
    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'vat_changed')).all();
    expect(audit[0]!.reason).toBe('Agreed with accountant');
  });
});

describe('director-paid expenses', () => {
  it('credits the director’s current account instead of the bank', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({
      id: officerId, companyId, name: 'A. Director', role: 'director',
    }).run();

    const result = recordDirectorPaidExpense(db, {
      companyId, officerId, date: makeDate(2025, 3, 15),
      description: 'Conference ticket', accountId: byCode['6140']!,
      vatTreatmentId: tr['IE_STD']!, grossMinor: 24_600,
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines[0]).toMatchObject({ accountId: byCode['6140'], debitMinor: 20_000 });
    expect(lines[1]).toMatchObject({ accountId: acc['vat_on_purchases'], debitMinor: 4_600 });
    expect(lines[2]).toMatchObject({
      accountId: acc['directors_current_account'], creditMinor: 24_600, officerId,
    });

    // The company now owes the director, and the bank is untouched.
    expect(accountBalance(db, { companyId, accountId: acc['directors_current_account']! }))
      .toBe(24_600);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('still claims the input VAT', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({
      id: officerId, companyId, name: 'A. Director', role: 'director',
    }).run();
    recordDirectorPaidExpense(db, {
      companyId, officerId, date: makeDate(2025, 3, 15),
      description: 'Laptop bag', accountId: byCode['6120']!,
      vatTreatmentId: tr['IE_STD']!, grossMinor: 12_300,
    });
    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T2.amountMinor).toBe(2_300);
  });
});

describe('director-paid reverse charge', () => {
  it('balances when a director personally pays a reverse-charge supplier', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({
      id: officerId, companyId, name: 'A. Director', role: 'director',
    }).run();

    // A domain renewal on a personal card: no VAT charged by the supplier,
    // but the VAT is still self-accounted.
    const result = recordDirectorPaidExpense(db, {
      companyId, officerId, date: makeDate(2025, 3, 6),
      description: 'Domain renewals paid on personal card',
      accountId: byCode['6020']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
      grossMinor: 8_400,
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ accountId: byCode['6020'], debitMinor: 8_400 });
    expect(lines[1]).toMatchObject({ accountId: acc['vat_on_purchases'], debitMinor: 1_932 });
    expect(lines[2]).toMatchObject({ accountId: acc['vat_on_sales'], creditMinor: 1_932 });
    // The director is owed only what they actually paid out.
    expect(lines[3]).toMatchObject({
      accountId: acc['directors_current_account'], creditMinor: 8_400, officerId,
    });

    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
    expect(accountBalance(db, { companyId, accountId: acc['directors_current_account']! }))
      .toBe(8_400);
  });

  it('nets the reverse charge to zero on the VAT return', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({
      id: officerId, companyId, name: 'A. Director', role: 'director',
    }).run();
    recordDirectorPaidExpense(db, {
      companyId, officerId, date: makeDate(2025, 3, 6),
      description: 'Domain renewals', accountId: byCode['6020']!,
      vatTreatmentId: tr['NON_EU_SERVICES_RCV']!, grossMinor: 8_400,
    });
    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(1_932);
    expect(report.T2.amountMinor).toBe(1_932);
    expect(report.netPositionMinor).toBe(0);
  });
});

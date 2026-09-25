import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount, systemAccountId } from '../config/setup';
import {
  classifyTransaction, reclassifyTransaction, recordDirectorPaidExpense,
  postBankTransactionJournal, ClassificationError,
} from './classify';
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
  it('claims no input VAT without an invoice: the whole payment is the cost (issue #203)', async () => {
    const tx = await importOne('IRISH SUPPLIER', '-123.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });

    // The invoice is the only proof of input VAT; a bank amount is never split.
    expect(result.netMinor).toBe(12_300);
    expect(result.vatMinor).toBe(0);
    expect(result.vatEntryIds).toEqual([]);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: byCode['6010'], debitMinor: 12_300 });
    expect(lines[1]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 12_300 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(0);
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
  it('without the invoice, self-assesses nothing and flags it (issue #203)', async () => {
    // The reverse-charge net comes from the supplier's invoice, not the bank line.
    const tx = await importOne('ANTHROPIC', '-120.00');
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });

    expect(result.vatMinor).toBe(0);
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: byCode['6000'], debitMinor: 12_000 });
    expect(lines[1]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 12_000 });
  });

  it('balances, and puts nothing on the VAT return until the invoice is posted', async () => {
    const tx = await importOne('ANTHROPIC', '-120.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(0);
    expect(report.T2.amountMinor).toBe(0);
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

describe('foreign currency with a statement-provided rate', () => {
  it('classifies without a manual rate and balances in base at the bank rate', async () => {
    const usdAccount = addBankAccount(db, {
      companyId, bankName: 'Revolut', accountName: 'USD',
      currency: 'USD', openingDate: '2025-01-01',
    });
    await importStatement(db, {
      companyId, bankAccountId: usdAccount, filename: 'usd.csv',
      content: [
        'Date,Description,Amount,Settled Amount,Currency',
        '15/03/2025,US SUPPLIER,-120.00,-110.40,USD',
      ].join('\n'),
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', 'Settled Amount': 'base_amount', Currency: 'currency',
      },
    });
    const tx = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'US SUPPLIER')).get()!;

    // No fxRate supplied — the statement rate should be used.
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId)).all();
    const expense = lines.find((l) => l.accountId === byCode['6000'])!;
    expect(expense.debitMinor).toBe(12_000);
    expect(expense.baseDebitMinor).toBe(11_040);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.fxRateSource).toBe('bank_statement');
    expect(after.baseAmountMinor).toBe(-11040);
  });

  it('still throws when there is no statement rate and no manual rate', async () => {
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

    // Net effect: hosting back to zero, software carries the cost — all of it,
    // since without an invoice no input VAT is claimed (issue #203).
    expect(accountBalance(db, { companyId, accountId: byCode['6010']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byCode['6000']! })).toBe(12_300);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
  });

  it('removes the superseded VAT entries from the return', async () => {
    // A receipt: output VAT is posted on it, so there is an entry to supersede.
    const tx = await importOne('MISCODED', '123.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!,
    });
    reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['IE_ZERO']!,
      reason: 'Zero rated after all',
    });

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    // Only the new zero-rated entry counts; the superseded 23% one does not.
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T1.amountMinor).toBe(0);
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

// Issue #158: a Stripe payout net of fees, or a loan repayment's
// capital/interest split, is one statement amount that needs posting to more
// than one account. `classifyTransaction` is deliberately one account + one
// VAT treatment; this is the explicit, caller-driven alternative for a split.
describe('postBankTransactionJournal', () => {
  it('posts a loan repayment split with no VAT involved', async () => {
    const tx = await importOne('LOAN REPAYMENT', '-603.92');
    const result = postBankTransactionJournal(db, {
      companyId, bankTransactionId: tx.id,
      lines: [
        { accountId: byCode['2300']!, debitMinor: 51_225, memo: 'Capital' },
        { accountId: byCode['6100']!, debitMinor: 9_167, memo: 'Interest' },
        { accountId: acc['bank_control']!, creditMinor: 60_392 },
      ],
    });

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))
      .orderBy(journalLines.lineNumber).all();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ accountId: acc['bank_control'], creditMinor: 60_392 });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.journalEntryId).toBe(result.journalEntryId);
    expect(after.status).toBe('posted');
    // The evidence itself is untouched.
    expect(after.amountMinor).toBe(tx.amountMinor);
    expect(after.description).toBe(tx.description);
  });

  it('posts a Stripe payout split and records output VAT on the gross, not the net that hit the bank', async () => {
    const tx = await importOne('STRIPE PAYOUT', '2107.34');
    const result = postBankTransactionJournal(db, {
      companyId, bankTransactionId: tx.id,
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 210_734, memo: 'Stripe net payout' },
        { accountId: byCode['6100']!, debitMinor: 3_894, memo: 'Stripe processing fees' },
        { accountId: byCode['4000']!, creditMinor: 174_494, memo: 'Card sales (net)' },
        { accountId: acc['vat_on_sales']!, creditMinor: 40_134, memo: 'Output VAT on card sales' },
      ],
      vat: {
        direction: 'sales', treatmentId: tr['IE_STD']!,
        netMinor: 174_494, statedVatMinor: 40_134,
      },
    });

    expect(result.vatEntryIds).toHaveLength(1);
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId)).all();
    expect(lines).toHaveLength(4);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    // The gross card sales VAT (40,134), not the net that settled to the bank.
    expect(report.T1.amountMinor).toBe(40_134);
  });

  it('refuses a transaction that has already been posted', async () => {
    const tx = await importOne('STRIPE PAYOUT', '2107.34');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });
    expect(() => postBankTransactionJournal(db, {
      companyId, bankTransactionId: tx.id,
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 210_734 },
        { accountId: byCode['4000']!, creditMinor: 210_734 },
      ],
    })).toThrow(/already been posted/);
  });

  it('refuses fewer than two lines', async () => {
    const tx = await importOne('LOAN REPAYMENT', '-603.92');
    expect(() => postBankTransactionJournal(db, {
      companyId, bankTransactionId: tx.id,
      lines: [{ accountId: acc['bank_control']!, creditMinor: 60_392 }],
    })).toThrow(/at least two lines/);
  });

  it('refuses a missing transaction', () => {
    expect(() => postBankTransactionJournal(db, {
      companyId, bankTransactionId: 'btx_missing',
      lines: [
        { accountId: acc['bank_control']!, creditMinor: 100 },
        { accountId: byCode['4000']!, debitMinor: 100 },
      ],
    })).toThrow(ClassificationError);
  });
});

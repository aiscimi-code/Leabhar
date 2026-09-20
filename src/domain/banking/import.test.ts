import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement, saveImportProfile, findMatchingProfile } from './import';
import { proposeColumnMapping } from './statementParser';
import { bankTransactions, statementImports } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;

const STATEMENT = [
  'Date,Description,Amount',
  '15/03/2025,VERCEL INC,-42.17',
  '16/03/2025,ANTHROPIC,-120.00',
  '17/03/2025,CUSTOMER PAYMENT,1500.00',
].join('\n');

const columnMap = {
  Date: 'transaction_date' as const,
  Description: 'description' as const,
  Amount: 'amount' as const,
};

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Test Ltd', seedYears: [2025] });
  companyId = created.companyId;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'Bank of Ireland', accountName: 'Current',
    currency: 'EUR', openingDate: '2025-01-01',
  });
});

const doImport = (content: string, over: Record<string, unknown> = {}) =>
  importStatement(db, {
    companyId, bankAccountId, filename: 'statement.csv',
    content, fileFormat: 'csv', columnMap, ...over,
  });

describe('importStatement', () => {
  it('imports transactions and records the run', async () => {
    const result = await doImport(STATEMENT);
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.statementStartDate).toBe('2025-03-15');
    expect(result.statementEndDate).toBe('2025-03-17');

    const rows = db.select().from(bankTransactions).all();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.status).toBe('unclassified');
    expect(rows[0]!.provenanceStatus).toBe('imported');
  });

  it('assigns each transaction to its accounting period automatically', async () => {
    await doImport(STATEMENT);
    const rows = db.select().from(bankTransactions).all();
    for (const row of rows) expect(row.accountingPeriodId).toBeTruthy();
  });

  // README §13: "If the same statement is imported twice: No duplicate
  // transactions imported."
  it('imports nothing when the same statement file is imported twice', async () => {
    const first = await doImport(STATEMENT);
    expect(first.imported).toBe(3);

    const second = await doImport(STATEMENT);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(second.warnings.join(' ')).toContain('No duplicate transactions imported');

    expect(db.select().from(bankTransactions).all()).toHaveLength(3);
  });

  it('imports nothing on a re-import even under a different filename', async () => {
    await doImport(STATEMENT, { filename: 'jan.csv' });
    const second = await doImport(STATEMENT, { filename: 'jan-again.csv' });
    expect(second.imported).toBe(0);
    expect(db.select().from(bankTransactions).all()).toHaveLength(3);
  });

  it('imports only the new rows from an overlapping statement', async () => {
    await doImport(STATEMENT);

    // A second download covering March and April: two rows overlap.
    const overlapping = [
      'Date,Description,Amount',
      '16/03/2025,ANTHROPIC,-120.00',
      '17/03/2025,CUSTOMER PAYMENT,1500.00',
      '02/04/2025,AWS,-88.40',
      '05/04/2025,STRIPE PAYOUT,920.00',
    ].join('\n');

    const result = await doImport(overlapping, { filename: 'mar-apr.csv' });
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(2);
    expect(db.select().from(bankTransactions).all()).toHaveLength(5);
  });

  it('keeps two genuinely identical same-day charges', async () => {
    const twice = [
      'Date,Description,Amount',
      '15/03/2025,APP STORE,-9.99',
      '15/03/2025,APP STORE,-9.99',
    ].join('\n');
    const result = await doImport(twice);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(0);

    // ...and re-importing that same file still adds nothing.
    const again = await doImport(twice);
    expect(again.imported).toBe(0);
    expect(db.select().from(bankTransactions).all()).toHaveLength(2);
  });

  it('adds a third identical charge that appears in a later statement', async () => {
    await doImport([
      'Date,Description,Amount',
      '15/03/2025,APP STORE,-9.99',
      '15/03/2025,APP STORE,-9.99',
    ].join('\n'));

    const result = await doImport([
      'Date,Description,Amount',
      '15/03/2025,APP STORE,-9.99',
      '15/03/2025,APP STORE,-9.99',
      '15/03/2025,APP STORE,-9.99',
    ].join('\n'), { filename: 'corrected.csv' });

    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(2);
    expect(db.select().from(bankTransactions).all()).toHaveLength(3);
  });

  it('allows a deliberate re-import when the user insists', async () => {
    await doImport(STATEMENT);
    const result = await doImport(STATEMENT, { allowReimport: true });
    // The file-hash short circuit is bypassed, but the fingerprints still hold.
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(3);
  });

  it('imports the good rows and reports the bad ones', async () => {
    const messy = [
      'Date,Description,Amount',
      '15/03/2025,GOOD,-42.17',
      'garbage,BAD,-1.00',
      '17/03/2025,ALSO GOOD,-5.00',
    ].join('\n');
    const result = await doImport(messy);
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.rowNumber).toBe(2);

    const run = db.select().from(statementImports).get()!;
    expect(run.status).toBe('completed_with_errors');
    expect(run.errors).toHaveLength(1);
  });

  it('never mutates an imported transaction on a later import', async () => {
    await doImport(STATEMENT);
    const before = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;

    await doImport(STATEMENT, { filename: 'again.csv' });
    const after = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;

    expect(after.id).toBe(before.id);
    expect(after.amountMinor).toBe(before.amountMinor);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('writes an audit row for the import', async () => {
    const result = await doImport(STATEMENT);
    const run = db.select().from(statementImports)
      .where(eq(statementImports.id, result.importId)).get()!;
    expect(run.rowsImported).toBe(3);
    expect(run.fileHash).toHaveLength(64);
  });

  it('uses the bank’s own transaction id to distinguish lookalikes', async () => {
    const csv = [
      'Date,Description,Amount,TxId',
      '15/03/2025,APP STORE,-9.99,A1',
      '15/03/2025,APP STORE,-9.99,A2',
    ].join('\n');
    const result = await doImport(csv, {
      columnMap: { ...columnMap, TxId: 'bank_transaction_id' },
    });
    expect(result.imported).toBe(2);

    const rows = db.select().from(bankTransactions).all();
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
  });

  it('keeps two separate bank accounts independent', async () => {
    const second = addBankAccount(db, {
      companyId, bankName: 'Revolut', accountName: 'EUR', openingDate: '2025-01-01',
    });
    await doImport(STATEMENT);
    const result = await importStatement(db, {
      companyId, bankAccountId: second, filename: 'statement.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap,
    });
    // The same lines on a different account are different transactions.
    expect(result.imported).toBe(3);
    expect(db.select().from(bankTransactions).all()).toHaveLength(6);
  });

  // Issue #158: a Stripe payout's fee breakdown or a loan's capital/interest
  // split already sits in the statement's own remark column — it should
  // survive the import rather than being dropped on the floor.
  it('imports a Notes column onto the transaction, separate from its description', async () => {
    const content = [
      'Date,Description,Amount,Notes',
      '05/05/2025,STRIPE PAYOUT,2107.34,gross card sales 2146.28 less processing fees 38.94',
      '06/05/2025,LOAN REPAYMENT,-603.92,capital EUR 512.25 / interest EUR 91.67',
    ].join('\n');
    await doImport(content, {
      columnMap: { ...columnMap, Notes: 'notes' as const },
    });

    const rows = db.select().from(bankTransactions).orderBy(bankTransactions.transactionDate).all();
    expect(rows[0]).toMatchObject({
      description: 'STRIPE PAYOUT',
      notes: 'gross card sales 2146.28 less processing fees 38.94',
    });
    expect(rows[1]).toMatchObject({
      description: 'LOAN REPAYMENT',
      notes: 'capital EUR 512.25 / interest EUR 91.67',
    });
  });

  it('auto-proposes a column literally named Notes onto the notes field', () => {
    const { mapping } = proposeColumnMapping(['Date', 'Description', 'Amount', 'Notes']);
    expect(mapping.Notes).toBe('notes');
    expect(mapping.Description).toBe('description');
  });
});

describe('import profiles', () => {
  it('remembers a mapping and matches it by header signature', async () => {
    const id = saveImportProfile(db, {
      companyId, name: 'Bank of Ireland CSV', bankAccountId,
      headers: ['Date', 'Description', 'Amount'], columnMap,
    });
    const found = findMatchingProfile(db, companyId, ['date', ' Description ', 'AMOUNT']);
    expect(found?.id).toBe(id);
    expect(findMatchingProfile(db, companyId, ['Completely', 'Different'])).toBeUndefined();
  });

  it('imports using a saved profile without re-supplying the mapping', async () => {
    const profileId = saveImportProfile(db, {
      companyId, name: 'BOI', bankAccountId,
      headers: ['Date', 'Description', 'Amount'], columnMap,
    });
    const result = await importStatement(db, {
      companyId, bankAccountId, filename: 'statement.csv',
      content: STATEMENT, fileFormat: 'csv', importProfileId: profileId,
    });
    expect(result.imported).toBe(3);
  });

  it('falls back to a proposed mapping for an unfamiliar format', async () => {
    const result = await importStatement(db, {
      companyId, bankAccountId, filename: 'unknown.csv',
      content: STATEMENT, fileFormat: 'csv',
    });
    expect(result.imported).toBe(3);
  });
});

describe('foreign-currency statement with a settled (base) amount', () => {
  it('populates the base amount and derives the bank rate from the two figures', async () => {
    // A USD charge whose statement also reports the EUR amount the bank charged.
    const usdAccount = addBankAccount(db, {
      companyId, bankName: 'Revolut', accountName: 'USD',
      currency: 'USD', openingDate: '2025-01-01',
    });
    await importStatement(db, {
      companyId, bankAccountId: usdAccount, filename: 'usd-statement.csv',
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

    const tx = db.select().from(bankTransactions).get()!;
    expect(tx.currency).toBe('USD');
    expect(tx.baseAmountMinor).toBe(-11040);
    expect(tx.baseCurrency).toBe('EUR');
    // Rate derived from |11040| / |12000|.
    expect(tx.fxRateNumerator).toBe(11040);
    expect(tx.fxRateDenominator).toBe(12000);
    expect(tx.fxRateSource).toBe('bank_statement');
  });

  it('leaves the base amount null when the statement has no settled-amount column', async () => {
    await doImport(STATEMENT);
    const tx = db.select().from(bankTransactions).get()!;
    expect(tx.baseAmountMinor).toBeNull();
    expect(tx.fxRateSource).toBeNull();
  });

  it('does not derive a rate when the transaction is already in the base currency', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'eur-statement.csv',
      content: [
        'Date,Description,Amount,Settled Amount',
        '15/03/2025,IRISH SUPPLIER,-42.17,-42.17',
      ].join('\n'),
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', 'Settled Amount': 'base_amount',
      },
    });
    const tx = db.select().from(bankTransactions).get()!;
    // Same currency as base — no rate needed, and the base amount column is
    // just a duplicate of the amount, so we do not store it.
    expect(tx.baseAmountMinor).toBeNull();
    expect(tx.fxRateSource).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { importStatement } from '@/domain/banking/import';
import { bankTransactions } from '@/db/schema';
import type { AppDatabase } from '@/db';

/**
 * The committed sample statements under fixtures/bank (issue #476): each one
 * parses in its own format, the known overlap between the OFX and CAMT files
 * is flagged as a duplicate rather than imported twice, and re-importing a
 * file is refused as the same file. A fixture that stops parsing fails here
 * rather than in a person's hands.
 */
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'bank');

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Fixture Ltd', seedYears: [2025] });
  companyId = created.companyId;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'AIB', accountName: 'Current', currency: 'EUR', openingDate: '2025-01-01',
  });
});

const importFixture = (filename: string) =>
  importStatement(db, {
    companyId, bankAccountId, filename,
    content: readFileSync(join(FIXTURES, filename), 'utf8'),
    ...(filename.endsWith('.csv')
      ? {
          fileFormat: 'csv' as const,
          columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' } as const,
        }
      : { fileFormat: filename.endsWith('.ofx') ? ('ofx' as const) : ('camt053' as const) }),
  });

describe('the sample bank statements (fixtures/bank)', () => {
  it('imports the CSV statement with the documented column mapping', async () => {
    const result = await importFixture('january-february.csv');
    expect(result.imported).toBe(9);
    expect(result.failed).toBe(0);
  });

  it('imports the OFX statement, and the CAMT file flags only the overlapping entry', async () => {
    const ofx = await importFixture('march.ofx');
    expect(ofx.imported).toBe(4);
    expect(ofx.failed).toBe(0);

    // The CAMT file repeats the OFX statement's 28 March AIB-0004 entry: the
    // same bank transaction id, so it is a counted duplicate, not a second
    // copy of the money in the books.
    const camt = await importFixture('april-camt.053.xml');
    expect(camt.imported).toBe(3);
    expect(camt.duplicates).toBe(1);
    expect(camt.failed).toBe(0);

    const rows = db.select().from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, bankAccountId)).all();
    expect(rows.filter((r) => r.bankTransactionId === 'AIB-0004')).toHaveLength(1);
  });

  it('refuses a re-import of the same file as a duplicate, importing nothing', async () => {
    await importFixture('january-february.csv');
    const again = await importFixture('january-february.csv');
    expect(again.imported).toBe(0);
    expect(again.duplicateOfImportId).toBeDefined();
    expect(again.warnings.join(' ')).toMatch(/already imported/);
  });
});

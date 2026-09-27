import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openSqlite } from './index';
import * as schema from './schema';
import { ids } from '@/lib/ids';
import { createCompany, addBankAccount, type CreateCompanyInput } from '@/domain/config/setup';

/**
 * An in-memory database with the real migrations applied. Tests run against the
 * same schema the application runs against; no hand-maintained test DDL that
 * could drift from production.
 */
export function createTestDatabase() {
  const sqlite = openSqlite(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  return { db, sqlite };
}

type BankTransactionInsert = typeof schema.bankTransactions.$inferInsert;

/**
 * Insert one bank transaction for a test (issue #189). Only the company, bank
 * account and signed amount are required; every other column gets a plain
 * default an import would produce, and any column can be overridden. Returns
 * the transaction's id.
 */
export function insertTestBankTransaction(
  db: ReturnType<typeof createTestDatabase>['db'],
  values: Pick<BankTransactionInsert, 'companyId' | 'bankAccountId' | 'amountMinor'> & Partial<BankTransactionInsert>,
): string {
  const id = values.id ?? ids.bankTransaction();
  db.insert(schema.bankTransactions).values({
    transactionDate: '2025-01-15',
    description: 'TEST TRANSACTION',
    currency: 'EUR',
    fingerprint: `fp-${id}`,
    occurrenceIndex: 0,
    source: 'import',
    provenanceStatus: 'imported',
    ...values,
    id,
  }).run();
  return id;
}

export interface SeededBook {
  db: ReturnType<typeof createTestDatabase>['db'];
  sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
  companyId: string;
  /** Account ids by system key, e.g. `accountsByKey['sales']`. */
  accountsByKey: Record<string, string>;
  /** Account ids by code, e.g. `accountsByCode['4020']`. */
  accountsByCode: Record<string, string>;
  /** Tax-rate ids by code, e.g. `ratesByCode['STD23']`. */
  ratesByCode: Record<string, string>;
  /** VAT-treatment ids by code, e.g. `treatmentsByCode['IE_STD']`. */
  treatmentsByCode: Record<string, string>;
  bankAccountId: string;
}

/**
 * The standard book for a test that needs a company ready to post: a company
 * with its default chart of accounts, tax rates and VAT treatments, financial
 * years and VAT periods for 2025, and one bank account (issue #296). Built on
 * the domain's own `createCompany`/`addBankAccount`, so a fixture's data
 * passes through the same validation as production data. Any `CreateCompanyInput`
 * can be overridden.
 */
export function seedTestBook(options: Partial<CreateCompanyInput> = {}): SeededBook {
  const { db, sqlite } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'Test Book Ltd',
    vatRegistrationStatus: 'registered',
    seedYears: [2025],
    ...options,
  });
  const bankAccountId = addBankAccount(db, {
    companyId: created.companyId,
    bankName: 'Test Bank',
    accountName: 'Current account',
    openingDate: '2025-01-01',
  });
  return {
    db,
    sqlite,
    companyId: created.companyId,
    accountsByKey: created.accountsByKey,
    accountsByCode: created.accountsByCode,
    ratesByCode: created.ratesByCode,
    treatmentsByCode: created.treatmentsByCode,
    bankAccountId,
  };
}

/**
 * A confirmed supplier document for a test purchase invoice (issue #234):
 * input VAT is recovered only on a purchase posted from one. A bare row, not
 * a stored file — the tests that use it exercise VAT, not ingest.
 */
export function insertConfirmedDocument(
  db: ReturnType<typeof createTestDatabase>['db'],
  companyId: string,
  values: Partial<typeof schema.documents.$inferInsert> = {},
): string {
  const id = ids.document();
  db.insert(schema.documents).values({
    id, companyId, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, storagePath: `test/${id}.pdf`,
    mimeType: 'application/pdf', fileSizeBytes: 1, sha256: id.padEnd(64, '0').slice(0, 64),
    uploadedAt: new Date().toISOString(), documentType: 'supplier_invoice', reviewStatus: 'confirmed',
    ...values,
  }).run();
  return id;
}

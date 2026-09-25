import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openSqlite } from './index';
import * as schema from './schema';
import { ids } from '@/lib/ids';

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

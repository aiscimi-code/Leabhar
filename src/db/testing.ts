import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openSqlite } from './index';
import * as schema from './schema';

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

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  try {
    migrate(db, { migrationsFolder: './drizzle' });
  } catch {
    // The migrator needs a real folder; fall back to applying the SQL directly.
    for (const file of readdirSync('./drizzle').filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join('./drizzle', file), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
    }
  }
  return { db, sqlite };
}

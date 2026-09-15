import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export type AppDatabase = ReturnType<typeof createDatabase>;

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? './data/accounting.db');
}

/**
 * Open a SQLite database with the pragmas an accounting system needs.
 *
 * `foreign_keys` is not on by default in SQLite, which would let orphaned
 * accounting records exist. `journal_mode = WAL` and `synchronous = FULL`
 * together mean a committed transaction survives a crash or power loss — which
 * for a local-first book of account is the difference between a durable record
 * and a hopeful one.
 */
export function openSqlite(path: string = databasePath()): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export function createDatabase(path: string = databasePath()) {
  return drizzle(openSqlite(path), { schema });
}

let cached: AppDatabase | undefined;

/** Process-wide connection for the Next.js server. */
export function getDb(): AppDatabase {
  if (!cached) cached = createDatabase();
  return cached;
}

export { schema };

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';
import { databasePath } from '@/lib/paths';
import { runMigrations } from './migrate';

export type AppDatabase = ReturnType<typeof createDatabase>;

export { databasePath };

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
let migrationsApplied = false;

/**
 * Process-wide connection for the Next.js server.
 *
 * On first call the database is opened and any pending migrations are applied
 * automatically. In a packaged install there is no `npm run db:migrate` step the
 * user can run, so migrations must run before the first request is served. The
 * guard avoids re-running on every request.
 */
export function getDb(): AppDatabase {
  if (!cached) {
    cached = createDatabase();
  }
  if (!migrationsApplied) {
    ensureMigrations(cached);
    migrationsApplied = true;
  }
  return cached;
}

/**
 * Run migrations. drizzle's migrate() is idempotent: it tracks which
 * migrations have been applied in the __drizzle_migrations table and
 * only runs new ones. Calling it on every startup is safe and ensures
 * upgrades apply automatically without the user running a command.
 */
function ensureMigrations(db: AppDatabase): void {
  runMigrations(db);
}

export { schema };

/**
 * Close the cached database connection and discard it, so the next `getDb()`
 * call opens a fresh handle.
 *
 * Needed after `restoreBackup` replaces the database file on disk: the open
 * better-sqlite3 handle still points at the old file (or its deleted inode),
 * and WAL mode means the old journal may have stale entries. Closing and
 * reopening gives a clean handle on the restored file.
 */
export function resetDatabase(): void {
  if (cached) {
    const client = (cached as unknown as { $client?: Database.Database }).$client;
    client?.close();
    cached = undefined;
    migrationsApplied = false;
  }
}

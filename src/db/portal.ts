import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { runMigrations } from './migrate';
import type { AppDatabase } from './index';

/**
 * Ephemeral, in-memory databases for the portal (issue #166).
 *
 * Every other entry point in this app opens one database file on disk and
 * keeps it open for the life of the process (`getDb()`). The portal must do
 * the opposite: nothing it touches may persist server-side, so each request
 * opens a fresh SQLite database that lives only in this process's memory —
 * either empty, or reconstituted from bytes the caller decrypted from the
 * user's own uploaded vault — does its work, and is closed before the
 * request returns. Nothing here ever calls `databasePath()` or touches disk.
 */

function client(db: AppDatabase): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

/**
 * Open a database from a previously serialized vault, or a brand new one
 * when `bytes` is omitted. Migrations run either way: on a fresh database
 * they create the schema; on a reopened one they are a no-op unless the
 * vault predates a migration this build has since added, in which case they
 * bring it forward — the same guarantee `getDb()` gives the packaged app.
 */
export function createPortalDatabase(bytes?: Buffer): AppDatabase {
  const sqlite = bytes ? new Database(bytes) : new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  runMigrations(db);
  return db;
}

/** The database's current bytes, ready to be encrypted and handed back to the user. */
export function serializePortalDatabase(db: AppDatabase): Buffer {
  return client(db).serialize();
}

/** Release the in-memory database. Always call this before a request returns. */
export function closePortalDatabase(db: AppDatabase): void {
  client(db).close();
}

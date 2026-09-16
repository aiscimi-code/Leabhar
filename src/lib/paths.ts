import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Centralised, packaging-aware path resolution.
 *
 * In development every path resolves relative to the project root (cwd).
 * When packaged (`LEABHAR_PACKAGED=1`) the defaults move to the install
 * directory — the folder the installer extracted to — so the app finds its
 * database, documents, migrations and backups regardless of the user's
 * current working directory. Explicit env vars still override the defaults
 * in both modes.
 */

const PACKAGED = process.env.LEABHAR_PACKAGED === '1';

// Install directory = where node.exe / server.js live.
const APP_ROOT = process.env.LEABHAR_APP_ROOT
  ?? (PACKAGED ? join(homedir(), 'AppData', 'Local', 'Leabhar') : process.cwd());

export function appRoot(): string {
  return APP_ROOT;
}

export function dataDir(): string {
  return resolve(process.env.LEABHAR_DATA_DIR ?? join(APP_ROOT, 'data'));
}

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? join(dataDir(), 'accounting.db'));
}

export function storageRoot(): string {
  return resolve(process.env.DOCUMENT_STORAGE_PATH ?? join(APP_ROOT, 'storage', 'documents'));
}

export function backupRoot(): string {
  return resolve(process.env.BACKUP_PATH ?? join(APP_ROOT, 'backups'));
}

export function migrationsFolder(): string {
  return resolve(process.env.LEABHAR_MIGRATIONS ?? join(APP_ROOT, 'drizzle'));
}

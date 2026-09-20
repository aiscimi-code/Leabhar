import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * Centralised, packaging-aware path resolution.
 *
 * In development every path resolves relative to the project root (cwd).
 * When packaged (`LEABHAR_PACKAGED=1`) the defaults move to two different
 * roots — see below — so the app finds its database, documents, migrations
 * and backups regardless of the user's current working directory. Explicit
 * env vars still override the defaults in both modes.
 *
 * ## App root vs. data root (issue #59)
 *
 * The installer (`scripts/installer.nsi`) extracts the app's binaries to
 * `<install dir>\app`, and its uninstaller removes ONLY that `app`
 * subfolder — never the parent install directory, where the user's
 * database, documents and backups actually live. Before this split, both
 * lived in the exact same directory (`%LOCALAPPDATA%\Leabhar`), so
 * uninstalling deleted the user's accounting data with no warning and no
 * way back.
 *
 * `APP_ROOT` (the binaries the installer owns — replaced on every upgrade,
 * removed entirely on uninstall) and `DATA_ROOT` (the user's mutable data,
 * which install/uninstall must never touch) are therefore two separate
 * constants, not one. `DATA_ROOT` defaults to `APP_ROOT`'s own parent
 * directory rather than a second hardcoded guess, so it stays correct
 * however the user launches the app — the default `%LOCALAPPDATA%\Leabhar`
 * location, or a custom directory chosen in the installer's directory
 * page — as long as the on-disk layout is "binaries in `app/`, data
 * alongside it", which the installer guarantees.
 */

const PACKAGED = process.env.LEABHAR_PACKAGED === '1';

// Install directory = where node.exe / server.js / migrations live. Owned
// by the installer: replaced wholesale on upgrade, removed wholesale on
// uninstall (scripts/installer.nsi's "Uninstall" section RMDir /r's only
// this folder, never DATA_ROOT below).
const APP_ROOT = process.env.LEABHAR_APP_ROOT
  ?? (PACKAGED ? join(homedir(), 'AppData', 'Local', 'Leabhar', 'app') : process.cwd());

// User data root = the database, documents and backups. Never touched by
// install or uninstall. Defaults to APP_ROOT's own parent (see header
// comment) rather than a second independent guess, so it can never drift
// out of sync with wherever the app binaries actually are.
const DATA_ROOT = process.env.LEABHAR_DATA_ROOT
  ?? (PACKAGED ? dirname(APP_ROOT) : process.cwd());

export function appRoot(): string {
  return APP_ROOT;
}

export function dataRoot(): string {
  return DATA_ROOT;
}

export function dataDir(): string {
  return resolve(process.env.LEABHAR_DATA_DIR ?? join(DATA_ROOT, 'data'));
}

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? join(dataDir(), 'accounting.db'));
}

export function storageRoot(): string {
  return resolve(process.env.DOCUMENT_STORAGE_PATH ?? join(DATA_ROOT, 'storage', 'documents'));
}

export function backupRoot(): string {
  return resolve(process.env.BACKUP_PATH ?? join(DATA_ROOT, 'backups'));
}

export function migrationsFolder(): string {
  return resolve(process.env.LEABHAR_MIGRATIONS ?? join(APP_ROOT, 'drizzle'));
}

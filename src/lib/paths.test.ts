import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * paths.ts computes its module-level constants (PACKAGED/APP_ROOT/DATA_ROOT)
 * once, from process.env, at import time; every exported function then
 * re-reads process.env for its own override at CALL time. So env vars must
 * stay set for the whole test, not just across the import — restored by the
 * `afterEach` below, not by this helper.
 */
const ENV_KEYS = [
  'LEABHAR_PACKAGED', 'LEABHAR_APP_ROOT', 'LEABHAR_DATA_ROOT', 'LEABHAR_DATA_DIR',
  'DATABASE_PATH', 'DOCUMENT_STORAGE_PATH', 'BACKUP_PATH', 'LEABHAR_MIGRATIONS', 'LEABHAR_LOG_DIR',
] as const;

async function loadPaths(env: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  return (await import('./paths')) as typeof import('./paths');
}

describe('paths.ts', () => {
  const original: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) original[key] = process.env[key];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('in dev (unpackaged), every root resolves to cwd, unchanged from before the app/data split', async () => {
    const paths = await loadPaths({});
    expect(paths.appRoot()).toBe(process.cwd());
    expect(paths.dataRoot()).toBe(process.cwd());
    expect(paths.dataDir()).toBe(join(process.cwd(), 'data'));
  });

  it('when packaged with no overrides, the app root and data root are DIFFERENT directories (issue #59)', async () => {
    const paths = await loadPaths({ LEABHAR_PACKAGED: '1' });
    const expectedAppRoot = join(homedir(), 'AppData', 'Local', 'Leabhar', 'app');
    const expectedDataRoot = join(homedir(), 'AppData', 'Local', 'Leabhar');

    expect(paths.appRoot()).toBe(expectedAppRoot);
    expect(paths.dataRoot()).toBe(expectedDataRoot);
    expect(paths.appRoot()).not.toBe(paths.dataRoot());

    // The database/documents/backups must sit under the DATA root, never
    // under the app root the installer's uninstaller wipes out.
    expect(paths.dataDir()).toBe(join(expectedDataRoot, 'data'));
    expect(paths.storageRoot()).toBe(join(expectedDataRoot, 'storage', 'documents'));
    expect(paths.backupRoot()).toBe(join(expectedDataRoot, 'backups'));
    // Logs are user-relevant runtime data (issue #61), so DATA_ROOT too — never wiped by uninstall.
    expect(paths.logDirectory()).toBe(join(expectedDataRoot, 'logs'));
    // Migrations ship with the binaries, so they stay under the app root.
    expect(paths.migrationsFolder()).toBe(join(expectedAppRoot, 'drizzle'));
  });

  it('data root always derives from the actual app root, even at a custom install location', async () => {
    // The NSIS installer lets a user pick a custom directory; launcher.cjs
    // then sets LEABHAR_APP_ROOT to wherever it is actually running from
    // (dirname(process.execPath)) — dataRoot must still land one level up
    // from THAT, not from a second, independently-guessed default. Uses a
    // POSIX-absolute fake path so node:path's resolve() (platform-neutral
    // here, run under Linux) doesn't rebase a non-absolute drive-letter path
    // against cwd — the join/dirname logic under test is platform-agnostic.
    const customAppRoot = '/custom/install/Leabhar/app';
    const paths = await loadPaths({ LEABHAR_PACKAGED: '1', LEABHAR_APP_ROOT: customAppRoot });
    expect(paths.appRoot()).toBe(customAppRoot);
    expect(paths.dataRoot()).toBe('/custom/install/Leabhar');
  });

  it('an explicit LEABHAR_DATA_ROOT overrides the derived default', async () => {
    const paths = await loadPaths({ LEABHAR_PACKAGED: '1', LEABHAR_DATA_ROOT: '/custom/data-root' });
    expect(paths.dataRoot()).toBe('/custom/data-root');
    expect(paths.dataDir()).toBe('/custom/data-root/data');
  });

  it('every existing env var override still works exactly as before (backward compatible)', async () => {
    const paths = await loadPaths({
      LEABHAR_PACKAGED: '1',
      DATABASE_PATH: '/custom/db.sqlite',
      DOCUMENT_STORAGE_PATH: '/custom/docs',
      BACKUP_PATH: '/custom/backups',
      LEABHAR_DATA_DIR: '/custom/data',
      LEABHAR_MIGRATIONS: '/custom/migrations',
      LEABHAR_LOG_DIR: '/custom/logs',
    });
    expect(paths.databasePath()).toBe('/custom/db.sqlite');
    expect(paths.storageRoot()).toBe('/custom/docs');
    expect(paths.backupRoot()).toBe('/custom/backups');
    expect(paths.dataDir()).toBe('/custom/data');
    expect(paths.migrationsFolder()).toBe('/custom/migrations');
    expect(paths.logDirectory()).toBe('/custom/logs');
  });
});

import { createHash } from 'node:crypto';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync,
  statSync, copyFileSync, cpSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { backups, auditEvents, companies } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { databasePath } from '@/db';
import { storageRoot } from '../documents/storage';

/**
 * Backup and restore (README §45).
 *
 * Backups are versioned, never overwritten. A backup that overwrites the
 * previous one is a single point of failure: a corrupted database backed up
 * once destroys the only good copy. Each backup is a numbered directory
 * containing the database, the documents and a manifest with hashes, so a
 * restore can be verified before it is trusted.
 */

export function backupRoot(): string {
  return resolve(process.env.BACKUP_PATH ?? './backups');
}

export interface BackupManifest {
  version: number;
  createdAt: string;
  companyId: string | null;
  companyName: string | null;
  databaseFile: string;
  databaseSha256: string;
  documentCount: number;
  documentBytes: number;
  documents: Array<{ path: string; sha256: string; bytes: number }>;
  application: string;
}

export interface BackupResult {
  backupId: string;
  version: number;
  path: string;
  sizeBytes: number;
  documentCount: number;
  sha256: string;
}

export async function createBackup(
  db: AppDatabase,
  params: { companyId?: string; root?: string; dbPath?: string; documentsPath?: string } = {},
): Promise<BackupResult> {
  const root = params.root ?? backupRoot();
  const sourceDb = params.dbPath ?? databasePath();
  const sourceDocs = params.documentsPath ?? storageRoot();

  mkdirSync(root, { recursive: true });

  const existing = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(1)));
  const version = (existing.length > 0 ? Math.max(...existing) : 0) + 1;

  const target = join(root, `v${version}`);
  if (existsSync(target)) {
    // Should be impossible given the version scan, but never overwrite.
    throw new Error(`Backup directory ${target} already exists. Refusing to overwrite it.`);
  }
  mkdirSync(target, { recursive: true });

  // ---- Database ----
  // Checkpoint the write-ahead log first, otherwise a copy of the .db file
  // alone can be missing the most recent committed transactions.
  try {
    (db as unknown as { $client?: { pragma: (s: string) => unknown } }).$client
      ?.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* a database without WAL needs no checkpoint */ }

  const databaseFile = 'database.db';
  let databaseSha256 = '';
  if (existsSync(sourceDb)) {
    copyFileSync(sourceDb, join(target, databaseFile));
    databaseSha256 = createHash('sha256')
      .update(readFileSync(join(target, databaseFile))).digest('hex');
  }

  // ---- Documents ----
  const documents: BackupManifest['documents'] = [];
  let documentBytes = 0;

  if (existsSync(sourceDocs)) {
    cpSync(sourceDocs, join(target, 'documents'), { recursive: true });
    for (const file of walk(join(target, 'documents'))) {
      const content = readFileSync(file);
      documents.push({
        path: file.slice(join(target, 'documents').length + 1),
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
      });
      documentBytes += content.length;
    }
  }

  const company = params.companyId
    ? db.select().from(companies).where(eq(companies.id, params.companyId)).get()
    : undefined;

  const manifest: BackupManifest = {
    version,
    createdAt: nowIso(),
    companyId: company?.id ?? null,
    companyName: company?.legalName ?? null,
    databaseFile,
    databaseSha256,
    documentCount: documents.length,
    documentBytes,
    documents,
    application: 'leabhar',
  };

  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const sizeBytes = documentBytes
    + (existsSync(join(target, databaseFile)) ? statSync(join(target, databaseFile)).size : 0);

  const backupId = ids.backup();
  db.transaction((tx) => {
    tx.insert(backups).values({
      id: backupId,
      companyId: params.companyId ?? null,
      version,
      path: target,
      sizeBytes,
      sha256: databaseSha256,
      documentCount: documents.length,
      status: 'completed',
    }).run();

    if (params.companyId) {
      tx.insert(auditEvents).values({
        id: ids.audit(),
        companyId: params.companyId,
        occurredAt: nowIso(),
        entityType: 'backup',
        entityId: backupId,
        action: 'backup_created',
        newValue: JSON.stringify({ version, path: target, sizeBytes }),
        source: 'user',
        actor: 'user',
      }).run();
    }
  });

  return {
    backupId, version, path: target, sizeBytes,
    documentCount: documents.length, sha256: databaseSha256,
  };
}

export interface BackupVerification {
  version: number;
  path: string;
  manifestPresent: boolean;
  databasePresent: boolean;
  databaseIntact: boolean;
  documentsChecked: number;
  documentsIntact: number;
  corrupted: string[];
  usable: boolean;
  summary: string;
}

/**
 * Verify a backup before trusting it.
 *
 * An unverified backup is a hope, not a backup. Every file's hash is re-checked
 * against the manifest written when it was created.
 */
export function verifyBackup(path: string): BackupVerification {
  const manifestPath = join(path, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      version: 0, path, manifestPresent: false, databasePresent: false,
      databaseIntact: false, documentsChecked: 0, documentsIntact: 0,
      corrupted: [], usable: false,
      summary: 'No manifest found. This directory is not a backup this application created.',
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  const databaseFile = join(path, manifest.databaseFile);
  const databasePresent = existsSync(databaseFile);
  const databaseIntact = databasePresent
    && createHash('sha256').update(readFileSync(databaseFile)).digest('hex') === manifest.databaseSha256;

  const corrupted: string[] = [];
  let documentsIntact = 0;

  for (const document of manifest.documents) {
    const file = join(path, 'documents', document.path);
    if (!existsSync(file)) { corrupted.push(`${document.path} (missing)`); continue; }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual === document.sha256) documentsIntact += 1;
    else corrupted.push(`${document.path} (changed)`);
  }

  const usable = databaseIntact && corrupted.length === 0;

  return {
    version: manifest.version,
    path,
    manifestPresent: true,
    databasePresent,
    databaseIntact,
    documentsChecked: manifest.documents.length,
    documentsIntact,
    corrupted,
    usable,
    summary: usable
      ? `Backup v${manifest.version} is complete: the database and all `
        + `${manifest.documents.length} documents match the hashes recorded when it was made.`
      : !databasePresent ? 'The database file is missing from this backup.'
      : !databaseIntact ? 'The database file does not match its recorded hash. Do not restore from it.'
      : `${corrupted.length} document${corrupted.length === 1 ? '' : 's'} `
        + 'missing or altered. Restoring would lose evidence behind reported figures.',
  };
}

export function listBackups(root = backupRoot()): BackupVerification[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name))
    .map((entry) => verifyBackup(join(root, entry.name)))
    .sort((a, b) => b.version - a.version);
}

/**
 * Restore from a backup.
 *
 * The current database and documents are moved aside into a pre-restore backup
 * first, never deleted. Restoring over a live database is exactly when a person
 * discovers the backup was incomplete, and at that point the thing they need
 * most is the state they just replaced.
 */
export async function restoreBackup(
  params: { path: string; dbPath?: string; documentsPath?: string; force?: boolean },
): Promise<{ restored: boolean; preRestoreCopy: string; verification: BackupVerification }> {
  const verification = verifyBackup(params.path);
  if (!verification.usable && !params.force) {
    throw new Error(
      `This backup did not verify: ${verification.summary} `
        + 'Restoring it anyway requires an explicit override.',
    );
  }

  const targetDb = params.dbPath ?? databasePath();
  const targetDocs = params.documentsPath ?? storageRoot();

  const preRestoreCopy = join(
    backupRoot(), `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(preRestoreCopy, { recursive: true });

  if (existsSync(targetDb)) copyFileSync(targetDb, join(preRestoreCopy, 'database.db'));
  if (existsSync(targetDocs)) {
    cpSync(targetDocs, join(preRestoreCopy, 'documents'), { recursive: true });
  }

  const manifest = JSON.parse(
    readFileSync(join(params.path, 'manifest.json'), 'utf8'),
  ) as BackupManifest;

  mkdirSync(dirname(targetDb), { recursive: true });
  // Remove stale WAL and shared-memory files, which would otherwise be replayed
  // over the restored database and reintroduce the state being replaced.
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${targetDb}${suffix}`)) rmSync(`${targetDb}${suffix}`);
  }
  copyFileSync(join(params.path, manifest.databaseFile), targetDb);

  if (existsSync(join(params.path, 'documents'))) {
    cpSync(join(params.path, 'documents'), targetDocs, { recursive: true });
  }

  return { restored: true, preRestoreCopy, verification };
}

function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

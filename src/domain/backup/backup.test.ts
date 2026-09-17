import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  createBackup, verifyBackup, restoreBackup,
  type BackupManifest,
} from './backup';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppDatabase } from '@/db';
import { createHash } from 'node:crypto';

let db: AppDatabase;
let companyId: string;
let root: string;
let docsRoot: string;
let dbFile: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  root = join(tmpdir(), `backup-test-${Math.random().toString(36).slice(2)}`);
  docsRoot = join(tmpdir(), `backup-docs-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(docsRoot, { recursive: true });
  // A real database file on disk, so the backup has something to copy and hash.
  dbFile = join(root, 'source.db');
  writeFileSync(dbFile, Buffer.from('database content'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(docsRoot, { recursive: true, force: true });
});

describe('createBackup + verifyBackup', () => {
  it('stores POSIX-style paths in the manifest, even when the OS uses backslashes', async () => {
    // Create a document in a subdirectory so the path has a separator.
    const subDir = join(docsRoot, '02');
    mkdirSync(subDir, { recursive: true });
    const content = Buffer.from('invoice pdf');
    writeFileSync(join(subDir, 'doc.pdf'), content);

    const result = await createBackup(db, {
      companyId, root, dbPath: dbFile, documentsPath: docsRoot,
    });

    // Re-read the manifest to inspect the stored paths.
    const manifest = JSON.parse(
      readFileSync(join(result.path, 'manifest.json'), 'utf8'),
    ) as BackupManifest;

    // No backslash should appear in any stored document path.
    for (const doc of manifest.documents) {
      expect(doc.path).not.toContain('\\');
      expect(doc.path).toMatch(/\//);
    }

    // And the backup should verify as usable.
    const verification = verifyBackup(result.path);
    expect(verification.usable).toBe(true);
    expect(verification.documentsIntact).toBe(manifest.documents.length);
  });

  it('verifies a backup with backslash paths in the manifest (Windows-created)', () => {
    // Build a backup by hand with a Windows-style manifest, then verify it.
    const backupDir = join(root, 'v1');
    mkdirSync(join(backupDir, 'documents', '02'), { recursive: true });
    const content = Buffer.from('windows backup doc');
    writeFileSync(join(backupDir, 'documents', '02', 'doc.pdf'), content);
    const sha = createHash('sha256').update(content).digest('hex');

    // The manifest stores the path with a backslash, as a Windows backup would.
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      companyId: null,
      companyName: null,
      databaseFile: 'database.db',
      databaseSha256: '',
      documentCount: 1,
      documentBytes: content.length,
      documents: [{ path: '02\\doc.pdf', sha256: sha, bytes: content.length }],
      application: 'leabhar',
    };
    writeFileSync(join(backupDir, 'database.db'), Buffer.alloc(0));
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const verification = verifyBackup(backupDir);
    // The backslash path should be normalized to a forward-slash path, and the
    // document should be found and verified.
    expect(verification.documentsIntact).toBe(1);
    expect(verification.corrupted).toHaveLength(0);
    // usable is false because the database hash is empty — that's expected;
    // the point here is that documents are found despite backslash paths.
    expect(verification.documentsChecked).toBe(1);
  });

  it('reports a genuinely missing document as corrupted', async () => {
    const subDir = join(docsRoot, '02');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'doc.pdf'), Buffer.from('present'));

    const result = await createBackup(db, {
      companyId, documentsPath: docsRoot,
    });

    // Delete the document from the backup after creation.
    rmSync(join(result.path, 'documents', '02', 'doc.pdf'));

    const verification = verifyBackup(result.path);
    expect(verification.usable).toBe(false);
    expect(verification.corrupted.length).toBe(1);
    expect(verification.corrupted[0]).toContain('missing');
  });
});

describe('restoreBackup', () => {
  it('restores documents and database from a verified backup', async () => {
    const subDir = join(docsRoot, '03');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'doc.pdf'), Buffer.from('restore me'));

    const result = await createBackup(db, {
      companyId, root, dbPath: dbFile, documentsPath: docsRoot,
    });

    const targetDb = join(root, 'target.db');
    const targetDocs = join(root, 'target-docs');

    const outcome = await restoreBackup({
      path: result.path, dbPath: targetDb, documentsPath: targetDocs,
    });

    expect(outcome.restored).toBe(true);
    expect(existsSync(join(targetDocs, '03', 'doc.pdf'))).toBe(true);
    expect(existsSync(targetDb)).toBe(true);
  });

  it('restores a backup with backslash paths in the manifest', async () => {
    const backupDir = join(root, 'v1');
    mkdirSync(join(backupDir, 'documents', '04'), { recursive: true });
    const content = Buffer.from('cross-platform restore');
    writeFileSync(join(backupDir, 'documents', '04', 'doc.pdf'), content);
    const sha = createHash('sha256').update(content).digest('hex');

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      companyId: null,
      companyName: null,
      databaseFile: 'database.db',
      databaseSha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      documentCount: 1,
      documentBytes: content.length,
      documents: [{ path: '04\\doc.pdf', sha256: sha, bytes: content.length }],
      application: 'leabhar',
    };
    writeFileSync(join(backupDir, 'database.db'), Buffer.alloc(0));
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const targetDocs = join(root, 'target-docs');
    const targetDb = join(root, 'target.db');

    const outcome = await restoreBackup({
      path: backupDir, dbPath: targetDb, documentsPath: targetDocs,
    });

    expect(outcome.restored).toBe(true);
    expect(existsSync(join(targetDocs, '04', 'doc.pdf'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { documents } from '@/db/schema';
import type { AppDatabase } from '@/db';
import {
  scanWatchFolder, isCandidate, moveToProcessed, ACCEPTED_EXTENSIONS,
  PROCESSED_SUBFOLDER, type WatchFileSystem,
} from './watch';

let db: AppDatabase;
let companyId: string;
let storageRoot: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Software Limited', seedYears: [2025] }).companyId;
  storageRoot = mkdtempSync(join(tmpdir(), 'docs-storage-'));
});

afterEach(() => { rmSync(storageRoot, { recursive: true, force: true }); });

const INVOICE_TEXT = [
  'Byrne Accountancy Services Limited',
  'VAT Number: IE9876543W',
  'INVOICE',
  'Invoice Number: INV-2025-0041',
  'Invoice Date: 15/03/2025',
  'Subtotal    1,000.00',
  'VAT @ 23%     230.00',
  'Total Due   1,230.00',
  'Currency: EUR',
].join('\n');

/**
 * A fake filesystem that holds an in-memory folder of files. It records stat
 * samples so a test can make a file look "still being written" by changing its
 * content between the two stability samples.
 */
function fakeFs(files: Map<string, Buffer>): WatchFileSystem & {
  mtimeFor: (path: string) => number;
  setMtime: (path: string, ms: number) => void;
  grow: (path: string, extra: string) => void;
  statCalls: number;
} {
  const mtimes = new Map<string, number>();
  let statCalls = 0;
  return {
    statCalls: 0,
    readdir: (p) => [...files.keys()]
      .filter((k) => k.startsWith(p + sep) || k.startsWith(p + '/'))
      .map((k) => k.slice(p.length + 1).split(sep)[0]!)
      .filter((v, i, a) => a.indexOf(v) === i),
    readFile: (p) => {
      const buf = files.get(p);
      if (!buf) throw new Error(`fake: ${p} not found`);
      return buf;
    },
    stat: (p) => {
      statCalls += 1;
      const buf = files.get(p);
      if (!buf) throw new Error(`fake: ${p} not found`);
      return { size: buf.length, mtimeMs: mtimes.get(p) ?? 1000 };
    },
    exists: (p) => files.has(p)
      || [...files.keys()].some((k) => k.startsWith(p + sep) || k.startsWith(p + '/')),
    mkdir: (p) => { mtimes.set(p + sep, 0); },
    rename: (from, to) => {
      const buf = files.get(from);
      if (!buf) throw new Error(`fake: cannot rename missing ${from}`);
      files.delete(from);
      files.set(to, buf);
    },
    mtimeFor: (p) => mtimes.get(p) ?? 1000,
    setMtime: (p, ms) => { mtimes.set(p, ms); },
    grow: (p, extra) => {
      const buf = files.get(p);
      if (buf) files.set(p, Buffer.concat([buf, Buffer.from(extra)]));
    },
  };
}

describe('isCandidate', () => {
  it('accepts the same extensions as the upload form', () => {
    expect(isCandidate('invoice.pdf')).toBe(true);
    expect(isCandidate('scan.JPG')).toBe(true);
    expect(isCandidate('receipt.xlsx')).toBe(true);
    expect(isCandidate('notes.txt')).toBe(true);
  });

  it('rejects hidden, temp and lock files', () => {
    expect(isCandidate('.DS_Store')).toBe(false);
    expect(isCandidate('.gitkeep')).toBe(false);
    expect(isCandidate('~$invoice.xlsx')).toBe(false);
    expect(isCandidate('download.crdownload')).toBe(false);
    expect(isCandidate('partial.part')).toBe(false);
    expect(isCandidate('scratch.tmp')).toBe(false);
  });

  it('rejects unsupported extensions', () => {
    expect(isCandidate('readme.md')).toBe(false);
    expect(isCandidate('archive.zip')).toBe(false);
    expect(isCandidate('movie.mov')).toBe(false);
  });

  it('the accepted list matches the upload form', () => {
    expect(ACCEPTED_EXTENSIONS).toEqual([
      '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
      '.tif', '.tiff', '.heic', '.txt', '.csv', '.xlsx',
    ]);
  });
});

describe('scanWatchFolder', () => {
  it('ingests a stable file, stores it, and moves the original to processed/', async () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      writeFileSync(join(watch, 'invoice.txt'), INVOICE_TEXT);

      const fs = fakeFs(new Map([[join(watch, 'invoice.txt'), Buffer.from(INVOICE_TEXT)]]));
      const outcome = await scanWatchFolder(db, {
        companyId, watchPath: watch, storageRootPath: storageRoot,
        fs, stabilityMs: 0, delay: async () => {},
      });

      expect(outcome.ingested).toBe(1);
      expect(outcome.duplicates).toBe(0);
      expect(outcome.inProgress).toBe(0);
      expect(outcome.processedFiles).toEqual(['invoice.txt']);

      // The document was stored and read.
      const rows = db.select().from(documents).where(eq(documents.companyId, companyId)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.uploadedBy).toBe('auto-watch');
      expect(rows[0]!.grossMinor).toBe(123_000);
      expect(rows[0]!.provenanceStatus).toBe('ai_suggestion');
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });

  it('skips a file that is still being written', async () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      const path = join(watch, 'growing.txt');
      const fs = fakeFs(new Map([[path, Buffer.from(INVOICE_TEXT)]]));
      // Grow the file between the two stat samples so size differs.
      let sampleCount = 0;
      const trackingFs: WatchFileSystem = {
        ...fs,
        stat: (p) => {
          sampleCount += 1;
          if (sampleCount === 2) (fs as any).grow(p, '\nmore bytes');
          return fs.stat(p);
        },
      };

      const outcome = await scanWatchFolder(db, {
        companyId, watchPath: watch, storageRootPath: storageRoot,
        fs: trackingFs, stabilityMs: 1, delay: async () => {},
      });

      expect(outcome.inProgress).toBe(1);
      expect(outcome.ingested).toBe(0);
      expect(db.select().from(documents).all()).toHaveLength(0);
      expect(outcome.notes[0]).toContain('still being written');
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });

  it('flags a duplicate rather than re-ingesting identical content', async () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      writeFileSync(join(watch, 'invoice.txt'), INVOICE_TEXT);
      const fs = fakeFs(new Map([
        [join(watch, 'invoice.txt'), Buffer.from(INVOICE_TEXT)],
      ]));

      await scanWatchFolder(db, {
        companyId, watchPath: watch, storageRootPath: storageRoot,
        fs, stabilityMs: 0, delay: async () => {},
      });

      // Second pass: the file is gone from the fake fs (moved to processed/),
      // so simulate a re-uploaded copy by putting it back with the same content.
      fs.rename(join(watch, 'processed', 'invoice.txt'), join(watch, 'invoice.txt'));
      const second = await scanWatchFolder(db, {
        companyId, watchPath: watch, storageRootPath: storageRoot,
        fs, stabilityMs: 0, delay: async () => {},
      });

      expect(second.ingested).toBe(0);
      expect(second.duplicates).toBe(1);
      // Two metadata rows now exist, one a flagged duplicate.
      expect(db.select().from(documents).all()).toHaveLength(2);
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the watch path does not exist', async () => {
    await expect(scanWatchFolder(db, {
      companyId, watchPath: '/no/such/folder/here', storageRootPath: storageRoot,
      stabilityMs: 0, delay: async () => {},
    })).rejects.toThrow(/does not exist or is not readable/);
  });

  it('respects the per-scan file cap', async () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      const files = new Map<string, Buffer>();
      for (let i = 0; i < 5; i++) {
        const content = `${INVOICE_TEXT}\n# ${i}`;
        files.set(join(watch, `inv-${i}.txt`), Buffer.from(content));
      }
      const fs = fakeFs(files);

      const outcome = await scanWatchFolder(db, {
        companyId, watchPath: watch, storageRootPath: storageRoot,
        fs, stabilityMs: 0, delay: async () => {}, maxFiles: 3,
      });

      expect(outcome.ingested).toBe(3);
      expect(db.select().from(documents).all()).toHaveLength(3);
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });
});

describe('moveToProcessed', () => {
  const realFs: WatchFileSystem = {
    readdir: (p) => readdirSync(p),
    readFile: (p) => readFileSync(p),
    stat: (p) => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; },
    exists: (p) => existsSync(p),
    mkdir: (p, opts) => mkdirSync(p, opts),
    rename: (from, to) => renameSync(from, to),
  };

  it('creates the processed subfolder and moves the file', () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      writeFileSync(join(watch, 'a.txt'), 'hello');

      const moved = moveToProcessed(realFs, watch, 'a.txt');
      expect(moved).toBe(true);
      expect(existsSync(join(watch, PROCESSED_SUBFOLDER, 'a.txt'))).toBe(true);
      expect(existsSync(join(watch, 'a.txt'))).toBe(false);
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });

  it('appends a suffix on a name collision', () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      mkdirSync(join(watch, PROCESSED_SUBFOLDER));
      writeFileSync(join(watch, PROCESSED_SUBFOLDER, 'a.txt'), 'first');
      writeFileSync(join(watch, 'a.txt'), 'second');

      const moved = moveToProcessed(realFs, watch, 'a.txt');
      expect(moved).toBe(true);
      expect(readFileSync(join(watch, PROCESSED_SUBFOLDER, 'a-1.txt'), 'utf8')).toBe('second');
      expect(readFileSync(join(watch, PROCESSED_SUBFOLDER, 'a.txt'), 'utf8')).toBe('first');
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });

  it('returns false when the rename fails, leaving the original in place', () => {
    const watch = mkdtempSync(join(tmpdir(), 'watch-'));
    try {
      writeFileSync(join(watch, 'a.txt'), 'hello');
      const failingFs: WatchFileSystem = {
        ...realFs,
        rename: () => { throw new Error('locked'); },
      };

      const moved = moveToProcessed(failingFs, watch, 'a.txt');
      expect(moved).toBe(false);
      // The original is untouched.
      expect(existsSync(join(watch, 'a.txt'))).toBe(true);
    } finally {
      rmSync(watch, { recursive: true, force: true });
    }
  });
});

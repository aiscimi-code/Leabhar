import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  storeDocument, readDocument, verifyDocumentIntegrity, findNewFiles,
  documentAbsolutePath, mimeTypeFor,
} from './storage';
import { extractDocument } from '../extraction/service';
import { LocalExtractionProvider } from '../extraction/localProvider';
import { documents, reviewItems, documentExtractions } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let root: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Software Limited', seedYears: [2025] }).companyId;
  root = mkdtempSync(join(tmpdir(), 'docs-'));
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const store = (filename: string, content: string) =>
  storeDocument(db, {
    companyId, filename, content: Buffer.from(content, 'utf8'), root,
  });

describe('storeDocument', () => {
  it('stores a document and records its hash', () => {
    const result = store('invoice.pdf', 'pretend pdf bytes');
    expect(result.sha256).toHaveLength(64);
    expect(result.isDuplicate).toBe(false);
    expect(existsSync(join(root, result.storagePath))).toBe(true);

    const row = db.select().from(documents).where(eq(documents.id, result.documentId)).get()!;
    expect(row.originalFilename).toBe('invoice.pdf');
    expect(row.mimeType).toBe('application/pdf');
    expect(row.fileSizeBytes).toBe(17);
  });

  it('flags a duplicate and never overwrites the original', () => {
    const first = store('invoice.pdf', 'identical content');
    const originalBytes = readFileSync(join(root, first.storagePath));

    const second = store('invoice-copy.pdf', 'identical content');
    expect(second.isDuplicate).toBe(true);
    expect(second.duplicateOfId).toBe(first.documentId);
    expect(second.duplicateOfFilename).toBe('invoice.pdf');
    // Nothing was written the second time.
    expect(second.bytesWritten).toBe(0);
    expect(readFileSync(join(root, first.storagePath))).toEqual(originalBytes);

    // Both metadata rows exist: the same invoice can genuinely arrive twice.
    expect(db.select().from(documents).all()).toHaveLength(2);
  });

  it('keeps different content separate even under the same filename', () => {
    const first = store('invoice.pdf', 'content A');
    const second = store('invoice.pdf', 'content B');
    expect(second.isDuplicate).toBe(false);
    expect(second.storagePath).not.toBe(first.storagePath);
    expect(readFileSync(join(root, first.storagePath), 'utf8')).toBe('content A');
    expect(readFileSync(join(root, second.storagePath), 'utf8')).toBe('content B');
  });

  it('shards storage so one directory never fills up', () => {
    const result = store('invoice.pdf', 'x');
    expect(result.storagePath.startsWith(result.sha256.slice(0, 2))).toBe(true);
  });

  it('recognises common file types', () => {
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('a.PNG')).toBe('image/png');
    expect(mimeTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.xlsx')).toContain('spreadsheet');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});

describe('readDocument', () => {
  it('reads a stored document back unchanged', () => {
    const stored = store('invoice.pdf', 'original bytes');
    const { content } = readDocument(db, companyId, stored.documentId, root);
    expect(content.toString('utf8')).toBe('original bytes');
  });

  it('says plainly when the evidence is missing', () => {
    const stored = store('invoice.pdf', 'bytes');
    rmSync(join(root, stored.storagePath));
    expect(() => readDocument(db, companyId, stored.documentId, root))
      .toThrow(/the evidence behind it does not/);
  });
});

describe('verifyDocumentIntegrity', () => {
  it('confirms an untouched document', () => {
    const stored = store('invoice.pdf', 'bytes');
    const check = verifyDocumentIntegrity(db, companyId, stored.documentId, root);
    expect(check.intact).toBe(true);
    expect(check.actual).toBe(check.expected);
  });

  it('detects an externally modified document', () => {
    const stored = store('invoice.pdf', 'bytes');
    writeFileSync(join(root, stored.storagePath), 'tampered');
    const check = verifyDocumentIntegrity(db, companyId, stored.documentId, root);
    expect(check.intact).toBe(false);
    expect(check.reason).toContain('never modified by this application');
  });

  it('detects a missing document', () => {
    const stored = store('invoice.pdf', 'bytes');
    rmSync(join(root, stored.storagePath));
    const check = verifyDocumentIntegrity(db, companyId, stored.documentId, root);
    expect(check.intact).toBe(false);
    expect(check.actual).toBeNull();
  });
});

describe('findNewFiles', () => {
  it('distinguishes new files from ones already stored', () => {
    store('existing.pdf', 'already here');
    const found = findNewFiles(db, companyId, [
      { name: 'existing.pdf', content: Buffer.from('already here') },
      { name: 'new.pdf', content: Buffer.from('brand new') },
    ]);
    expect(found[0]!.alreadyStored).toBe(true);
    expect(found[1]!.alreadyStored).toBe(false);
  });
});

describe('extractDocument', () => {
  const INVOICE = [
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

  it('extracts and writes the figures as suggestions', async () => {
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.txt', content: Buffer.from(INVOICE), root,
    });
    const result = await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [new LocalExtractionProvider()],
    });

    expect(result.applied).toBe(true);
    const row = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(row.grossMinor).toBe(123_000);
    expect(row.vatMinor).toBe(23_000);
    expect(row.netMinor).toBe(100_000);
    expect(row.documentDate).toBe('2025-03-15');
    expect(row.invoiceNumber).toBe('INV-2025-0041');
    expect(row.currency).toBe('EUR');

    // Crucially: a suggestion, not a decision.
    expect(row.provenanceStatus).toBe('ai_suggestion');
    expect(row.classificationStatus).toBe('suggested');
    expect(row.extractionStatus).toBe('extracted');
  });

  it('keeps the full extraction for inspection', async () => {
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.txt', content: Buffer.from(INVOICE), root,
    });
    await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [new LocalExtractionProvider()],
    });
    const extraction = db.select().from(documentExtractions).get()!;
    expect(extraction.provider).toBe('local');
    expect(extraction.extractedText).toContain('Byrne Accountancy');
    expect(extraction.overallConfidence).toBeGreaterThan(60);
  });

  it('sends a low-confidence document to review instead of filling fields', async () => {
    const stored = storeDocument(db, {
      companyId, filename: 'vague.txt',
      content: Buffer.from('Just some text with no figures at all.'), root,
    });
    const result = await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [new LocalExtractionProvider()],
    });

    // Every extraction is a draft awaiting a person's confirmation; with no
    // figures to read, the draft carries no total.
    expect(result.needsReview).toBe(true);

    const row = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(row.reviewStatus).toBe('unreviewed');
    expect(row.grossMinor).toBeNull();
    expect(row.classificationStatus).toBe('needs_review');

    const items = db.select().from(reviewItems).all();
    expect(items.some((i) => i.kind === 'unresolved_ai_suggestion')).toBe(true);
  });

  it('raises a review item for a duplicate document', async () => {
    storeDocument(db, { companyId, filename: 'a.txt', content: Buffer.from(INVOICE), root });
    const second = storeDocument(db, {
      companyId, filename: 'a-copy.txt', content: Buffer.from(INVOICE), root,
    });
    await extractDocument(db, {
      companyId, documentId: second.documentId, storageRootPath: root,
      providers: [new LocalExtractionProvider()],
    });
    const items = db.select().from(reviewItems).all();
    const duplicate = items.find((i) => i.kind === 'suspected_duplicate')!;
    expect(duplicate.detail).toContain('has not been touched');
  });

  it('never modifies the source document', async () => {
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.txt', content: Buffer.from(INVOICE), root,
    });
    const before = readFileSync(join(root, stored.storagePath));
    await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [new LocalExtractionProvider()],
    });
    expect(readFileSync(join(root, stored.storagePath))).toEqual(before);
    expect(verifyDocumentIntegrity(db, companyId, stored.documentId, root).intact).toBe(true);
  });

  it('falls back to the local provider when the configured one is unavailable', async () => {
    const unavailable = {
      name: 'anthropic', version: '1.0.0',
      isAvailable: () => false,
      extract: async () => { throw new Error('should never be called'); },
    };
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.txt', content: Buffer.from(INVOICE), root,
    });
    const result = await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [unavailable, new LocalExtractionProvider()],
    });
    expect(result.result.provider).toBe('local');
    expect(result.applied).toBe(true);
  });

  it('falls back when the configured provider fails at run time', async () => {
    const failing = {
      name: 'anthropic', version: '1.0.0',
      isAvailable: () => true,
      extract: async () => ({
        provider: 'anthropic', providerVersion: '1.0.0',
        textExtractionMethod: 'none' as const, extractedText: '',
        fields: (await import('../extraction/types')).emptyFields(),
        overallConfidence: 0, status: 'failed' as const,
        errorMessage: 'network down', durationMs: 1, observations: ['network down'],
        lines: [], vatTotals: [], vatLegends: [],
      }),
    };
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.txt', content: Buffer.from(INVOICE), root,
    });
    const result = await extractDocument(db, {
      companyId, documentId: stored.documentId, storageRootPath: root,
      providers: [failing, new LocalExtractionProvider()],
    });
    // Bookkeeping continues without the network.
    expect(result.result.provider).toBe('local');
    expect(result.applied).toBe(true);
  });
});

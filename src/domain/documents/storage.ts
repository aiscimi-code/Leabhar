import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { documents, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { storageRoot as storageRootFromPaths } from '@/lib/paths';
import { nowIso } from '../dates';

/**
 * Local document repository (README §11).
 *
 * Two rules govern this module and both are absolute:
 *
 *  - Never silently overwrite an existing document. A file whose hash already
 *    exists is recorded as a duplicate and flagged; the original stays where it
 *    is. Overwriting would destroy the evidence behind a figure that has
 *    already been reported.
 *  - Never modify a stored document. Extraction reads; it does not write back.
 *
 * Storage is content-addressed by SHA-256, so identical content is physically
 * stored once no matter how many times it is uploaded, while each upload still
 * gets its own metadata row.
 */

export function storageRoot(): string {
  return storageRootFromPaths();
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
};

export function mimeTypeFor(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function isExtractable(mimeType: string): boolean {
  return mimeType === 'application/pdf'
    || mimeType.startsWith('image/')
    || mimeType === 'text/plain';
}

export interface StoreDocumentInput {
  companyId: string;
  filename: string;
  content: Buffer;
  documentType?: typeof documents.$inferInsert['documentType'];
  documentDate?: string | null;
  supplierId?: string | null;
  customerId?: string | null;
  /** The invoice this document is evidence for (issue #160). */
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  currency?: string | null;
  netMinor?: number | null;
  vatMinor?: number | null;
  grossMinor?: number | null;
  notes?: string | null;
  /**
   * Set only when the header values above were entered by a person (a CSV of
   * their own invoices, say) rather than read from the file. The document is
   * then recorded as confirmed by them; otherwise it waits for confirmation.
   */
  confirmedBy?: string;
  uploadedBy?: string;
  root?: string;
  requestId?: string;
}

export interface StoredDocument {
  documentId: string;
  sha256: string;
  storagePath: string;
  isDuplicate: boolean;
  duplicateOfId?: string;
  duplicateOfFilename?: string;
  bytesWritten: number;
}

/**
 * Store a document and record its metadata.
 *
 * A duplicate still gets its own metadata row — the same invoice can legitimately
 * arrive twice, once by email and once in a bulk folder — but it is flagged, and
 * the review queue asks the user which one is real rather than deciding for them.
 */
export function storeDocument(db: AppDatabase, input: StoreDocumentInput): StoredDocument {
  const root = input.root ?? storageRoot();
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const existing = db.select().from(documents)
    .where(and(
      eq(documents.companyId, input.companyId),
      eq(documents.sha256, sha256),
      eq(documents.archived, false),
    )).get();

  // Content-addressed path: shard by the first two hex characters so a single
  // directory never accumulates tens of thousands of entries.
  const extension = extname(input.filename).toLowerCase();
  const relativePath = join(sha256.slice(0, 2), `${sha256}${extension}`);
  const absolutePath = join(root, relativePath);

  let bytesWritten = 0;
  if (!existsSync(absolutePath)) {
    mkdirSync(join(root, sha256.slice(0, 2)), { recursive: true });
    writeFileSync(absolutePath, input.content, { flag: 'wx' });
    bytesWritten = input.content.length;
  } else {
    // The file is already there and, being content-addressed, is byte-identical.
    // Writing again could only ever destroy it, so we do not.
    bytesWritten = 0;
  }

  const documentId = ids.document();
  const timestamp = nowIso();
  const mimeType = mimeTypeFor(input.filename);

  db.transaction((tx) => {
    tx.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      filename: `${sha256.slice(0, 12)}${extension}`,
      originalFilename: input.filename,
      storagePath: relativePath,
      mimeType,
      fileSizeBytes: input.content.length,
      sha256,
      documentType: input.documentType ?? 'unknown',
      uploadedAt: timestamp,
      uploadedBy: input.uploadedBy ?? 'user',
      documentDate: input.documentDate ?? null,
      supplierId: input.supplierId ?? null,
      customerId: input.customerId ?? null,
      invoiceId: input.invoiceId ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      currency: input.currency ?? null,
      netMinor: input.netMinor ?? null,
      vatMinor: input.vatMinor ?? null,
      grossMinor: input.grossMinor ?? null,
      extractionStatus: isExtractable(mimeType) ? 'pending' : 'skipped',
      isDuplicateOf: existing?.id ?? null,
      notes: input.notes ?? null,
      reviewStatus: input.confirmedBy ? 'confirmed' : 'unreviewed',
      reviewedAt: input.confirmedBy ? timestamp : null,
      reviewedBy: input.confirmedBy ?? null,
      reviewNote: input.confirmedBy ? 'Values entered by the user, not read from the file.' : null,
      source: input.confirmedBy ? 'user' : 'import',
      provenanceStatus: input.confirmedBy ? 'user_confirmed' : 'imported',
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'document',
      entityId: documentId,
      action: 'created',
      newValue: JSON.stringify({
        originalFilename: input.filename, sha256,
        sizeBytes: input.content.length,
        duplicateOf: existing?.id ?? null,
      }),
      source: 'import',
      actor: input.uploadedBy ?? 'user',
      reason: existing ? `Duplicate of ${existing.originalFilename}` : null,
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    documentId,
    sha256,
    storagePath: relativePath,
    isDuplicate: existing !== undefined,
    duplicateOfId: existing?.id,
    duplicateOfFilename: existing?.originalFilename,
    bytesWritten,
  };
}

/** Read a stored document back. Read-only by construction. */
export function readDocument(
  db: AppDatabase, companyId: string, documentId: string, root = storageRoot(),
): { content: Buffer; document: typeof documents.$inferSelect } {
  const document = db.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
    .get();
  if (!document) throw new Error(`Document ${documentId} not found.`);

  const absolutePath = join(root, document.storagePath);
  if (!existsSync(absolutePath)) {
    throw new Error(
      `The stored file for document ${documentId} is missing from ${document.storagePath}. `
        + 'The accounting record survives, but the evidence behind it does not — restore '
        + 'from a backup before relying on any figure that depends on it.',
    );
  }
  return { content: readFileSync(absolutePath), document };
}

/**
 * Verify that a stored file still matches the hash recorded at ingest.
 * This is what lets the year-end pack assert that the evidence behind a figure
 * is the same evidence that was there when it was classified.
 */
export function verifyDocumentIntegrity(
  db: AppDatabase, companyId: string, documentId: string, root = storageRoot(),
): { intact: boolean; expected: string; actual: string | null; reason?: string } {
  const document = db.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
    .get();
  if (!document) throw new Error(`Document ${documentId} not found.`);

  const absolutePath = join(root, document.storagePath);
  if (!existsSync(absolutePath)) {
    return {
      intact: false, expected: document.sha256, actual: null,
      reason: 'The stored file is missing.',
    };
  }

  const actual = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  return {
    intact: actual === document.sha256,
    expected: document.sha256,
    actual,
    reason: actual === document.sha256 ? undefined
      : 'The stored file has changed since it was recorded. Documents are never '
        + 'modified by this application, so this indicates an external change.',
  };
}

export function documentAbsolutePath(
  document: Pick<typeof documents.$inferSelect, 'storagePath'>, root = storageRoot(),
): string {
  return join(root, document.storagePath);
}

/** Scan a folder for files not yet in the repository (README §14). */
export function findNewFiles(
  db: AppDatabase, companyId: string, files: Array<{ name: string; content: Buffer }>,
): Array<{ name: string; sha256: string; alreadyStored: boolean; existingId?: string }> {
  return files.map((file) => {
    const sha256 = createHash('sha256').update(file.content).digest('hex');
    const existing = db.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.sha256, sha256)))
      .get();
    return {
      name: file.name,
      sha256,
      alreadyStored: existing !== undefined,
      existingId: existing?.id,
    };
  });
}

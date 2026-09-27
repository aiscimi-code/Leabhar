import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, ne, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  documents, documentExtractions, documentLines, documentVatTotals, documentMatches,
  invoices, fixedAssets, expenseClaimLines, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { storageRoot } from './storage';
import { nowIso, today } from '../dates';
import { retentionEndsOn } from './retention';
import { AccountingError } from '../accounting/errors';

/**
 * Retiring a document from the repository (issue #430).
 *
 * The stored file itself is never modified (invariant #5), but a book also
 * accumulates documents that were filed by mistake or are past retention, and
 * a person must be able to take them out of the working set. Three rules make
 * that safe:
 *
 *  - **Archive before anything else.** Archiving removes a document from the
 *    working lists and is reversible; it is refused while the document
 *    supports an invoice or a linked bank transaction, because the figures
 *    behind those rest on it.
 *  - **Hard delete is a second, deliberate step** on an already-archived
 *    document that supports nothing, and it is refused if any other document
 *    points at it (as a duplicate).
 *  - **The file is content-addressed and shared** by byte-identical documents:
 *    the file is only removed when no other row uses the same hash. Deleting a
 *    row therefore never deletes someone else's evidence.
 *
 * Every step is audited, and every refusal throws rather than guessing.
 */

export class DocumentLifecycleError extends AccountingError {}

export interface LifecycleActorInput {
  companyId: string;
  documentId: string;
  actor: string;
  reason: string;
  requestId?: string;
}

/** Everything in the books that rests on this document. Empty means it may be retired. */
export function documentDependencies(
  db: AppDatabase,
  companyId: string,
  documentId: string,
): Array<{ what: string; detail: string }> {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId))).get();
  if (!doc) throw new DocumentLifecycleError(`Document ${documentId} not found.`);

  const dependencies: Array<{ what: string; detail: string }> = [];

  if (doc.invoiceId) {
    const invoice = db.select().from(invoices).where(eq(invoices.id, doc.invoiceId)).get();
    dependencies.push({
      what: 'invoice',
      detail: invoice
        ? `Posted as invoice ${invoice.invoiceNumber ?? invoice.id}.`
        : `Posted as invoice ${doc.invoiceId}.`,
    });
  }
  // An invoice created with this document as its evidence — how input VAT is
  // proven (issue #234) — rests on it whether or not the document row
  // records the invoice back.
  for (const invoice of db.select({ id: invoices.id, number: invoices.invoiceNumber }).from(invoices)
    .where(and(eq(invoices.documentId, documentId), eq(invoices.companyId, companyId))).all()) {
    if (invoice.id === doc.invoiceId) continue;
    dependencies.push({ what: 'invoice', detail: `It is the evidence for invoice ${invoice.number ?? invoice.id}.` });
  }
  for (const asset of db.select({ id: fixedAssets.id, name: fixedAssets.name }).from(fixedAssets)
    .where(and(eq(fixedAssets.documentId, documentId), eq(fixedAssets.companyId, companyId))).all()) {
    dependencies.push({ what: 'fixed_asset', detail: `It is the evidence for the fixed asset "${asset.name}".` });
  }
  if (db.select({ id: expenseClaimLines.id }).from(expenseClaimLines)
    .where(and(eq(expenseClaimLines.documentId, documentId), eq(expenseClaimLines.companyId, companyId))).get()) {
    dependencies.push({ what: 'expense_claim', detail: 'It is the receipt behind an expense claim line.' });
  }
  if (doc.matchedTransactionId) {
    dependencies.push({
      what: 'bank_transaction',
      detail: `Linked to bank transaction ${doc.matchedTransactionId}. Unlink it first.`,
    });
  }
  const acceptedMatch = db.select({ id: documentMatches.id, decision: documentMatches.decision })
    .from(documentMatches)
    .where(and(
      eq(documentMatches.documentId, documentId),
      // A pending, rejected or superseded candidate is an offer that was never
      // taken up; an accepted one is a recorded decision the trace shows.
      inArray(documentMatches.decision, ['accepted', 'auto_accepted']),
    ))
    .get();
  if (acceptedMatch) {
    dependencies.push({
      what: 'match',
      detail: 'A match decision has been recorded against it. Withdraw the match first.',
    });
  }
  return dependencies;
}

/**
 * Take a document out of the working lists. Reversible (`restoreDocument`),
 * and refused while anything in the books rests on the document.
 */
export function archiveDocument(db: AppDatabase, input: LifecycleActorInput): void {
  assertReason(input.reason);
  const doc = requireDocument(db, input.companyId, input.documentId);
  if (doc.archived) return; // idempotent: archiving twice is the same state

  const dependencies = documentDependencies(db, input.companyId, input.documentId);
  if (dependencies.length > 0) {
    throw new DocumentLifecycleError(
      `${doc.originalFilename} cannot be archived: ${dependencies.map((d) => d.detail).join(' ')}`,
    );
  }

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(documents).set({ archived: true, updatedAt: timestamp })
      .where(eq(documents.id, doc.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'document', entityId: doc.id, action: 'voided',
      field: 'archived', previousValue: JSON.stringify(false), newValue: JSON.stringify(true),
      source: 'user', actor: input.actor, reason: input.reason, requestId: input.requestId ?? null,
    }).run();
  });
}

/** Bring an archived document back into the working lists. */
export function restoreDocument(db: AppDatabase, input: LifecycleActorInput): void {
  assertReason(input.reason);
  const doc = requireDocument(db, input.companyId, input.documentId);
  if (!doc.archived) return;

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(documents).set({ archived: false, updatedAt: timestamp })
      .where(eq(documents.id, doc.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'document', entityId: doc.id, action: 'updated',
      field: 'archived', previousValue: JSON.stringify(true), newValue: JSON.stringify(false),
      source: 'user', actor: input.actor, reason: input.reason, requestId: input.requestId ?? null,
    }).run();
  });
}

export interface DeleteDocumentResult {
  documentId: string;
  removedFile: boolean;
}

/**
 * Remove a document from the repository for good: its metadata, the drafts
 * read from it, and — only when no other stored document shares the same
 * bytes — the file itself.
 *
 * Two-step by construction: the document must already be archived, must
 * support nothing, and no other document may point at it as a duplicate.
 */
export function deleteDocument(
  db: AppDatabase,
  input: LifecycleActorInput & { storageRootPath?: string },
): DeleteDocumentResult {
  assertReason(input.reason);
  const doc = requireDocument(db, input.companyId, input.documentId);
  if (!doc.archived) {
    throw new DocumentLifecycleError(
      'Archive the document first. Deletion is permanent, so it is a second, deliberate step.',
    );
  }
  const dependencies = documentDependencies(db, input.companyId, input.documentId);
  if (dependencies.length > 0) {
    throw new DocumentLifecycleError(
      `${doc.originalFilename} cannot be deleted: ${dependencies.map((d) => d.detail).join(' ')}`,
    );
  }
  // Records must be kept for the retention period (the owner's policy; the
  // statutory minimum is six years, TCA 1997 s.886 and VATCA 2010 s.84).
  // Deleting is refused until it has run out; archiving stays available.
  const retention = retentionEndsOn(db, input.companyId, doc);
  if (retention && retention.eligibleFrom > today()) {
    throw new DocumentLifecycleError(
      `${doc.originalFilename} is kept under a ${retention.retainYears}-year retention policy until `
      + `${retention.eligibleFrom}. It stays archived until then; it cannot be deleted before.`,
    );
  }
  const duplicates = db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.isDuplicateOf, doc.id), ne(documents.id, doc.id))).all();
  if (duplicates.length > 0) {
    throw new DocumentLifecycleError(
      `${duplicates.length} other document${duplicates.length === 1 ? ' is' : 's are'} flagged as a `
      + 'duplicate of this one. Resolve those first: their record points at this document.',
    );
  }

  // Content-addressed storage: another row with the same hash is byte-identical
  // evidence of its own, so the file stays for it.
  const sharesFile = db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.storagePath, doc.storagePath), ne(documents.id, doc.id))).all().length > 0;

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.delete(documentExtractions).where(eq(documentExtractions.documentId, doc.id)).run();
    tx.delete(documentLines).where(eq(documentLines.documentId, doc.id)).run();
    tx.delete(documentVatTotals).where(eq(documentVatTotals.documentId, doc.id)).run();
    tx.delete(documentMatches).where(eq(documentMatches.documentId, doc.id)).run();
    tx.delete(documents).where(eq(documents.id, doc.id)).run();
    // The audit row outlives the document: it says what was removed and why,
    // which is the only trace left once the evidence is gone.
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'document', entityId: doc.id, action: 'deleted',
      previousValue: JSON.stringify({
        filename: doc.originalFilename, sha256: doc.sha256, documentType: doc.documentType,
        documentDate: doc.documentDate, uploadedAt: doc.uploadedAt,
      }),
      source: 'user', actor: input.actor, reason: input.reason, requestId: input.requestId ?? null,
    }).run();
  });

  let removedFile = false;
  if (!sharesFile) {
    try {
      unlinkSync(join(input.storageRootPath ?? storageRoot(), doc.storagePath));
      removedFile = true;
    } catch {
      // The file is already gone (or the storage is offline). The rows were
      // removed; the audit note says what was intended. Nothing is guessed.
    }
  }
  return { documentId: doc.id, removedFile };
}

function requireDocument(
  db: AppDatabase, companyId: string, documentId: string,
): typeof documents.$inferSelect {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId))).get();
  if (!doc) throw new DocumentLifecycleError(`Document ${documentId} not found.`);
  return doc;
}

function assertReason(reason: string): void {
  if (!reason.trim()) {
    throw new DocumentLifecycleError('Say why: retiring or deleting a document is a decision, and the reason is recorded.');
  }
}

/**
 * Human confirmation of an extracted document (issue #202).
 *
 * Extraction is best effort — the local scripts read a PDF's text layer or run
 * OCR over an image, and either can misread a figure. Nothing may use a
 * document until a person has compared what was extracted with the page and
 * confirmed it: matching, VAT, suggestions and reports all require
 * `reviewStatus === 'confirmed'` (see `isDocumentConfirmed`).
 *
 * Confirming writes the person's values — every header field, every line, the
 * VAT total per rate — onto the document, replacing the extraction draft. The
 * extraction run itself is never altered, and every field the person changed
 * is recorded in the audit trail with the extracted value it replaced, so what
 * was read and what was confirmed can always be told apart (AGENTS.md #8).
 *
 * Arithmetic that does not add up is reported, never repaired (AGENTS.md #7):
 * `checkDocumentValues` lists each problem, and confirmation refuses to proceed
 * until every warning has been acknowledged. Errors (a missing date or total)
 * cannot be acknowledged — the missing value has to be entered.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  documents, documentExtractions, documentLines, documentVatTotals, auditEvents,
  reviewItems, suppliers, customers, bankTransactions,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { asMinor } from '../money';
import { AccountingError } from '../accounting/errors';
import { normaliseName, upsertReviewItem } from '../extraction/service';
import {
  checkDocumentValues, type ReviewedDocumentValues, type ReviewedLine, type ReviewedVatTotal,
} from './checks';

export * from './checks';

export class DocumentReviewError extends AccountingError {}

function assertMoney(label: string, value: number | null): void {
  if (value === null) return;
  try {
    asMinor(value);
  } catch {
    throw new DocumentReviewError(`${label} must be a whole number of cents, got ${value}.`);
  }
}

function assertValuesAreMoney(values: ReviewedDocumentValues): void {
  assertMoney('Net', values.netMinor);
  assertMoney('VAT', values.vatMinor);
  assertMoney('Total', values.grossMinor);
  values.lines.forEach((l, i) => {
    for (const [k, v] of Object.entries({
      unitPrice: l.unitPriceMinor, net: l.netMinor, vat: l.vatMinor, gross: l.grossMinor,
    })) assertMoney(`Line ${i + 1} ${k}`, v);
    if (l.vatRateBasisPoints !== null && !Number.isInteger(l.vatRateBasisPoints)) {
      throw new DocumentReviewError(`Line ${i + 1} rate must be whole basis points.`);
    }
  });
  values.vatTotals.forEach((b, i) => {
    assertMoney(`VAT total ${i + 1} net`, b.netMinor);
    assertMoney(`VAT total ${i + 1} VAT`, b.vatMinor);
  });
}

/** True when a person has confirmed this document. Everything downstream checks this. */
export function isDocumentConfirmed(document: { reviewStatus: string }): boolean {
  return document.reviewStatus === 'confirmed';
}

/** Throw unless the document is confirmed — for the paths that must never use a draft. */
export function assertDocumentConfirmed(
  document: { id: string; reviewStatus: string; originalFilename?: string },
  purpose: string,
): void {
  if (!isDocumentConfirmed(document)) {
    throw new DocumentReviewError(
      `"${document.originalFilename ?? document.id}" has not been confirmed. Check the extracted details `
      + `against the document and confirm them before ${purpose}.`,
      { documentId: document.id, reviewStatus: document.reviewStatus },
    );
  }
}

/** The document's current values, in the shape the review screen edits. */
export function documentReviewValues(db: AppDatabase, params: { companyId: string; documentId: string }): {
  values: ReviewedDocumentValues;
  reviewStatus: string;
} {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) throw new DocumentReviewError(`Document ${params.documentId} not found.`);
  const lines = db.select().from(documentLines).where(eq(documentLines.documentId, doc.id))
    .orderBy(documentLines.lineNumber).all();
  const totals = db.select().from(documentVatTotals).where(eq(documentVatTotals.documentId, doc.id)).all();
  return {
    reviewStatus: doc.reviewStatus,
    values: {
      documentType: doc.documentType,
      invoiceNumber: doc.invoiceNumber,
      documentDate: doc.documentDate,
      dueDate: doc.dueDate,
      supplyDate: doc.supplyDate,
      currency: doc.currency,
      supplierNameStated: doc.supplierNameStated,
      supplierAddress: doc.supplierAddress,
      supplierVatNumber: doc.supplierVatNumber,
      supplierCountry: doc.supplierCountry,
      customerNameStated: doc.customerNameStated,
      customerAddress: doc.customerAddress,
      customerVatNumber: doc.customerVatNumber,
      customerCountry: doc.customerCountry,
      vatLegends: doc.vatLegends,
      paymentTerms: doc.paymentTerms,
      originalDocumentNumber: doc.originalDocumentNumber,
      netMinor: doc.netMinor,
      vatMinor: doc.vatMinor,
      grossMinor: doc.grossMinor,
      lines: lines.map((l) => ({
        description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
        netMinor: l.netMinor, vatRateBasisPoints: l.vatRateBasisPoints, vatMinor: l.vatMinor, grossMinor: l.grossMinor,
      })),
      vatTotals: totals.map((t) => ({
        rateBasisPoints: t.rateBasisPoints, label: t.label, netMinor: t.netMinor, vatMinor: t.vatMinor,
      })),
    },
  };
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * Write draft values onto an unconfirmed document — used by extraction. Never
 * touches a confirmed document: a person's confirmed values are not overwritten
 * by a re-extraction (AGENTS.md #8).
 */
export function writeDocumentDraft(
  tx: Tx | AppDatabase,
  params: {
    companyId: string;
    documentId: string;
    values: Partial<Omit<ReviewedDocumentValues, 'lines' | 'vatTotals'>>;
    lines: ReviewedLine[];
    vatTotals: ReviewedVatTotal[];
    source: 'derived' | 'ai';
    confidence: number;
  },
): void {
  const doc = tx.select({ reviewStatus: documents.reviewStatus }).from(documents)
    .where(eq(documents.id, params.documentId)).get();
  if (!doc) throw new DocumentReviewError(`Document ${params.documentId} not found.`);
  if (doc.reviewStatus === 'confirmed') {
    throw new DocumentReviewError('A confirmed document cannot be overwritten by extraction. Reopen it first.');
  }
  replaceLinesAndTotals(tx, {
    ...params,
    provenance: { source: params.source, confidence: params.confidence, provenanceStatus: 'ai_suggestion' },
  });
  const update: Partial<typeof documents.$inferInsert> = { updatedAt: nowIso() };
  for (const [key, value] of Object.entries(params.values)) {
    if (value !== undefined && value !== null) (update as Record<string, unknown>)[key] = value;
  }
  tx.update(documents).set(update).where(eq(documents.id, params.documentId)).run();
}

function replaceLinesAndTotals(
  tx: Tx | AppDatabase,
  params: {
    companyId: string; documentId: string; lines: ReviewedLine[]; vatTotals: ReviewedVatTotal[];
    provenance: {
      source: 'derived' | 'ai' | 'user' | 'import';
      confidence: number | null;
      provenanceStatus: 'ai_suggestion' | 'user_confirmed' | 'imported';
    };
  },
): void {
  tx.delete(documentLines).where(eq(documentLines.documentId, params.documentId)).run();
  tx.delete(documentVatTotals).where(eq(documentVatTotals.documentId, params.documentId)).run();
  params.lines.forEach((line, i) => {
    tx.insert(documentLines).values({
      id: ids.documentLine(), companyId: params.companyId, documentId: params.documentId,
      lineNumber: i + 1, ...line, description: line.description.trim(), ...params.provenance,
    }).run();
  });
  for (const band of params.vatTotals) {
    tx.insert(documentVatTotals).values({
      id: ids.documentVatTotal(), companyId: params.companyId, documentId: params.documentId,
      ...band, ...params.provenance,
    }).run();
  }
}

export interface ConfirmDocumentResult {
  documentId: string;
  changedFields: string[];
  acknowledgedChecks: string[];
  supplierId: string | null;
  customerId: string | null;
}

/**
 * Confirm a document with the values a person checked against the page.
 *
 * Refuses when any check is an error, or when a warning has not been
 * acknowledged (`acknowledgedCheckCodes`). Links the supplier/customer the
 * person chose — or creates one from the confirmed name when asked — because
 * a party record should be created from confirmed data, not from an unchecked
 * OCR read.
 */
export function confirmDocument(
  db: AppDatabase,
  params: {
    companyId: string;
    documentId: string;
    values: ReviewedDocumentValues;
    reviewedBy: string;
    acknowledgedCheckCodes?: string[];
    supplierId?: string | null;
    customerId?: string | null;
    createSupplier?: boolean;
    createCustomer?: boolean;
    note?: string | null;
    requestId?: string;
  },
): ConfirmDocumentResult {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) throw new DocumentReviewError(`Document ${params.documentId} not found.`);
  if (doc.reviewStatus === 'confirmed') {
    throw new DocumentReviewError('This document is already confirmed. Reopen it to change it.');
  }
  if (!params.reviewedBy.trim()) throw new DocumentReviewError('Who is confirming must be recorded.');

  assertValuesAreMoney(params.values);
  const checks = checkDocumentValues(params.values);
  const errors = checks.filter((c) => c.severity === 'error');
  if (errors.length > 0) {
    throw new DocumentReviewError(
      `The document cannot be confirmed yet: ${errors.map((e) => e.message).join(' ')}`,
      { checks: errors },
    );
  }
  const acknowledged = new Set(params.acknowledgedCheckCodes ?? []);
  const unacknowledged = checks.filter((c) => c.severity === 'warning' && !acknowledged.has(c.code));
  if (unacknowledged.length > 0) {
    throw new DocumentReviewError(
      `These need to be corrected or acknowledged before confirming: ${unacknowledged.map((c) => c.message).join(' ')}`,
      { checks: unacknowledged },
    );
  }

  const extraction = db.select().from(documentExtractions)
    .where(eq(documentExtractions.documentId, doc.id))
    .orderBy(desc(documentExtractions.createdAt)).get();
  const before = documentReviewValues(db, { companyId: params.companyId, documentId: doc.id }).values;
  const timestamp = nowIso();

  return db.transaction((tx) => {
    const supplierId = resolveParty(tx, 'supplier', {
      companyId: params.companyId, chosenId: params.supplierId ?? doc.supplierId,
      create: params.createSupplier ?? false, name: params.values.supplierNameStated,
      countryCode: params.values.supplierCountry, vatNumber: params.values.supplierVatNumber,
      documentId: doc.id, actor: params.reviewedBy,
    });
    const customerId = resolveParty(tx, 'customer', {
      companyId: params.companyId, chosenId: params.customerId ?? doc.customerId,
      create: params.createCustomer ?? false, name: params.values.customerNameStated,
      countryCode: params.values.customerCountry, vatNumber: params.values.customerVatNumber,
      documentId: doc.id, actor: params.reviewedBy,
    });

    const { lines, vatTotals, ...header } = params.values;
    tx.update(documents).set({
      ...header,
      supplierId,
      customerId,
      reviewStatus: 'confirmed',
      reviewedAt: timestamp,
      reviewedBy: params.reviewedBy,
      reviewNote: params.note ?? null,
      source: 'user',
      provenanceStatus: 'user_confirmed',
      classificationStatus: doc.classificationStatus === 'pending' ? 'pending' : doc.classificationStatus,
      updatedAt: timestamp,
    }).where(eq(documents.id, doc.id)).run();
    replaceLinesAndTotals(tx, {
      companyId: params.companyId, documentId: doc.id, lines, vatTotals,
      provenance: { source: 'user', confidence: null, provenanceStatus: 'user_confirmed' },
    });

    // Every field the person changed, against what was there (the extraction draft).
    const changedFields: string[] = [];
    for (const key of Object.keys(header) as Array<keyof typeof header>) {
      const was = JSON.stringify(before[key] ?? null);
      const now = JSON.stringify(header[key] ?? null);
      if (was !== now) {
        changedFields.push(key);
        tx.insert(auditEvents).values({
          id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
          entityType: 'document', entityId: doc.id, action: 'updated', field: key,
          previousValue: was, newValue: now, source: 'user', actor: params.reviewedBy,
          reason: 'Corrected at confirmation', requestId: params.requestId ?? null,
        }).run();
      }
    }
    for (const [key, was, now] of [
      ['lines', before.lines, lines], ['vatTotals', before.vatTotals, vatTotals],
    ] as const) {
      if (JSON.stringify(was) !== JSON.stringify(now)) {
        changedFields.push(key);
        tx.insert(auditEvents).values({
          id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
          entityType: 'document', entityId: doc.id, action: 'updated', field: key,
          previousValue: JSON.stringify(was), newValue: JSON.stringify(now), source: 'user',
          actor: params.reviewedBy, reason: 'Corrected at confirmation', requestId: params.requestId ?? null,
        }).run();
      }
    }

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'document', entityId: doc.id, action: 'user_confirmed',
      newValue: JSON.stringify({
        extractionId: extraction?.id ?? null,
        extractionProvider: extraction?.provider ?? null,
        changedFields,
        acknowledgedChecks: checks.filter((c) => c.severity === 'warning')
          .map((c) => ({ code: c.code, message: c.message })),
      }),
      source: 'user', actor: params.reviewedBy, reason: params.note ?? null,
      requestId: params.requestId ?? null,
    }).run();

    // The "please check this document" item is done; other items stay.
    tx.update(reviewItems).set({ status: 'resolved', updatedAt: timestamp })
      .where(and(
        eq(reviewItems.companyId, params.companyId),
        eq(reviewItems.dedupeKey, `document:${doc.id}:awaiting_confirmation`),
      )).run();

    return {
      documentId: doc.id,
      changedFields,
      acknowledgedChecks: checks.filter((c) => c.severity === 'warning').map((c) => c.code),
      supplierId,
      customerId,
    };
  });
}

function resolveParty(
  tx: Tx,
  kind: 'supplier' | 'customer',
  p: {
    companyId: string; chosenId: string | null; create: boolean; name: string | null;
    countryCode: string | null; vatNumber: string | null; documentId: string; actor: string;
  },
): string | null {
  const table = kind === 'supplier' ? suppliers : customers;
  if (p.chosenId) {
    const exists = tx.select({ id: table.id }).from(table)
      .where(and(eq(table.id, p.chosenId), eq(table.companyId, p.companyId))).get();
    if (!exists) throw new DocumentReviewError(`The chosen ${kind} does not exist.`);
    return p.chosenId;
  }
  if (!p.create) return null;
  if (!p.name?.trim()) throw new DocumentReviewError(`Enter the ${kind}'s name before creating one.`);
  const matchKey = normaliseName(p.name);
  const existing = tx.select({ id: table.id }).from(table)
    .where(and(eq(table.companyId, p.companyId), eq(table.matchKey, matchKey))).get();
  if (existing) return existing.id;
  const id = kind === 'supplier' ? ids.supplier() : ids.customer();
  tx.insert(table).values({
    id, companyId: p.companyId, name: p.name.trim(), matchKey,
    countryCode: p.countryCode?.toUpperCase() ?? null, vatNumber: p.vatNumber ?? null,
    notes: `Created when confirming document ${p.documentId}.`,
  }).run();
  tx.insert(auditEvents).values({
    id: ids.audit(), companyId: p.companyId, occurredAt: nowIso(), entityType: kind, entityId: id,
    action: 'created', newValue: JSON.stringify({ name: p.name, countryCode: p.countryCode, vatNumber: p.vatNumber }),
    source: 'user', actor: p.actor, reason: `Created from confirmed document ${p.documentId}`,
  }).run();
  return id;
}

/** Reject a document as unusable evidence. It stays stored (AGENTS.md #5); nothing uses it. */
export function rejectDocument(
  db: AppDatabase,
  params: { companyId: string; documentId: string; reviewedBy: string; reason: string; requestId?: string },
): void {
  if (!params.reason.trim()) throw new DocumentReviewError('Say why the document is being rejected.');
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) throw new DocumentReviewError(`Document ${params.documentId} not found.`);
  assertNotInUse(db, doc);
  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(documents).set({
      reviewStatus: 'rejected', reviewedAt: timestamp, reviewedBy: params.reviewedBy,
      reviewNote: params.reason, updatedAt: timestamp,
    }).where(eq(documents.id, doc.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp, entityType: 'document',
      entityId: doc.id, action: 'user_rejected', source: 'user', actor: params.reviewedBy,
      reason: params.reason, requestId: params.requestId ?? null,
    }).run();
    tx.update(reviewItems).set({ status: 'resolved', updatedAt: timestamp })
      .where(and(
        eq(reviewItems.companyId, params.companyId),
        eq(reviewItems.dedupeKey, `document:${doc.id}:awaiting_confirmation`),
      )).run();
  });
}

/**
 * Return a confirmed or rejected document to review so it can be corrected.
 * Refused while it supports a posted transaction or an invoice: unmatch it
 * first, so a figure already in the books is never silently changed.
 */
export function reopenDocument(
  db: AppDatabase,
  params: { companyId: string; documentId: string; reviewedBy: string; reason: string; requestId?: string },
): void {
  if (!params.reason.trim()) throw new DocumentReviewError('Say why the document is being reopened.');
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) throw new DocumentReviewError(`Document ${params.documentId} not found.`);
  if (doc.reviewStatus === 'unreviewed') return;
  assertNotInUse(db, doc);
  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(documents).set({
      reviewStatus: 'unreviewed', reviewedAt: null, reviewedBy: null, reviewNote: null, updatedAt: timestamp,
    }).where(eq(documents.id, doc.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp, entityType: 'document',
      entityId: doc.id, action: 'updated', field: 'reviewStatus',
      previousValue: JSON.stringify(doc.reviewStatus), newValue: JSON.stringify('unreviewed'),
      source: 'user', actor: params.reviewedBy, reason: params.reason, requestId: params.requestId ?? null,
    }).run();
    flagAwaitingConfirmation(tx, { companyId: params.companyId, documentId: doc.id, filename: doc.originalFilename });
  });
}

function assertNotInUse(db: AppDatabase, doc: typeof documents.$inferSelect): void {
  if (doc.invoiceId) {
    throw new DocumentReviewError('This document supports an invoice in the books. Void or unlink the invoice first.');
  }
  if (doc.matchedTransactionId) {
    const tx = db.select({ journalEntryId: bankTransactions.journalEntryId }).from(bankTransactions)
      .where(eq(bankTransactions.id, doc.matchedTransactionId)).get();
    throw new DocumentReviewError(
      tx?.journalEntryId
        ? 'This document supports a posted bank transaction. Unmatch it first.'
        : 'This document is matched to a bank transaction. Unmatch it first.',
    );
  }
}

/** Put a document on the review queue as awaiting confirmation (idempotent). */
export function flagAwaitingConfirmation(
  tx: Tx | AppDatabase,
  params: { companyId: string; documentId: string; filename: string; detail?: string },
): void {
  upsertReviewItem(tx, {
    companyId: params.companyId,
    kind: 'unresolved_ai_suggestion',
    severity: 'warning',
    title: `Check and confirm "${params.filename}"`,
    detail: params.detail
      ?? 'The details were read automatically and may contain mistakes. Compare them with the document, '
        + 'correct anything wrong, add anything missing, and confirm. Nothing uses this document until you do.',
    entityType: 'document',
    entityId: params.documentId,
    dedupeKey: `document:${params.documentId}:awaiting_confirmation`,
  });
}

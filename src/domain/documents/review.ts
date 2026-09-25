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
import { nowIso, isIsoDate } from '../dates';
import { asMinor, vatFromNet, sum } from '../money';
import { AccountingError } from '../accounting/errors';
import { normaliseName, upsertReviewItem } from '../extraction/service';

export class DocumentReviewError extends AccountingError {}

export type DocumentType = typeof documents.$inferInsert['documentType'];

export interface ReviewedLine {
  description: string;
  quantity: string | null;
  unitPriceMinor: number | null;
  netMinor: number | null;
  vatRateBasisPoints: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
}

export interface ReviewedVatTotal {
  rateBasisPoints: number | null;
  label: string | null;
  netMinor: number | null;
  vatMinor: number | null;
}

/** Everything a person confirms about a document. Amounts are integer minor units, as printed. */
export interface ReviewedDocumentValues {
  documentType: NonNullable<DocumentType>;
  invoiceNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  supplyDate: string | null;
  currency: string | null;
  supplierNameStated: string | null;
  supplierAddress: string | null;
  supplierVatNumber: string | null;
  supplierCountry: string | null;
  customerNameStated: string | null;
  customerAddress: string | null;
  customerVatNumber: string | null;
  customerCountry: string | null;
  vatLegends: string[];
  paymentTerms: string | null;
  originalDocumentNumber: string | null;
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
  lines: ReviewedLine[];
  vatTotals: ReviewedVatTotal[];
}

export interface DocumentCheck {
  /** Stable code, so an acknowledgement refers to one specific check. */
  code: string;
  /** An error blocks confirmation; a warning must be acknowledged. */
  severity: 'error' | 'warning';
  message: string;
}

/**
 * A computed VAT figure may differ from the printed one by rounding. Invoices
 * round per line or per total, so a difference of one minor unit per line (or
 * per rate band) is rounding, not an error.
 */
const ROUNDING_TOLERANCE_PER_ITEM = 1;

const withinRounding = (a: number, b: number, items: number): boolean =>
  Math.abs(a - b) <= ROUNDING_TOLERANCE_PER_ITEM * Math.max(1, items);

const fmt = (minor: number): string => (minor / 100).toFixed(2);

/** Types that are evidence of a supply, and so must carry a date and a total. */
const SUPPLY_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'supplier_invoice', 'sales_invoice', 'receipt', 'credit_note', 'sales_record',
]);

/**
 * Check the values a person is about to confirm. Pure — no database — so the
 * review screen can show the same checks live as the person edits.
 */
export function checkDocumentValues(values: ReviewedDocumentValues): DocumentCheck[] {
  const checks: DocumentCheck[] = [];
  const isEvidence = SUPPLY_EVIDENCE_TYPES.has(values.documentType);

  if (isEvidence) {
    if (!values.documentDate) {
      checks.push({ code: 'missing_date', severity: 'error', message: 'The document date is missing.' });
    }
    if (values.grossMinor === null) {
      checks.push({ code: 'missing_total', severity: 'error', message: 'The document total is missing.' });
    }
    if (!values.currency) {
      checks.push({ code: 'missing_currency', severity: 'error', message: 'The currency is missing.' });
    }
    // The counterparty is the customer on a sale and the supplier on a purchase.
    if (values.documentType === 'sales_invoice' || values.documentType === 'sales_record') {
      if (!values.customerNameStated) {
        checks.push({ code: 'missing_party', severity: 'error', message: 'The customer is not named.' });
      }
    } else if (values.documentType === 'credit_note') {
      if (!values.supplierNameStated && !values.customerNameStated) {
        checks.push({
          code: 'missing_party', severity: 'error',
          message: 'Neither the supplier nor the customer is named.',
        });
      }
    } else if (!values.supplierNameStated) {
      checks.push({ code: 'missing_party', severity: 'error', message: 'The supplier is not named.' });
    }
    if (values.lines.length === 0) {
      checks.push({
        code: 'no_lines', severity: 'warning',
        message: 'No lines were entered. Without lines, VAT can only be taken from the document\'s totals.',
      });
    }
  }
  for (const [field, value] of [
    ['documentDate', values.documentDate], ['dueDate', values.dueDate], ['supplyDate', values.supplyDate],
  ] as const) {
    if (value && !isIsoDate(value)) {
      checks.push({ code: `invalid_${field}`, severity: 'error', message: `${field} "${value}" is not a valid date (YYYY-MM-DD).` });
    }
  }
  if (values.documentType === 'credit_note' && !values.originalDocumentNumber) {
    checks.push({
      code: 'credit_note_without_original', severity: 'warning',
      message: 'This credit note does not state which invoice it credits.',
    });
  }

  // net + VAT = gross
  if (values.netMinor !== null && values.vatMinor !== null && values.grossMinor !== null
      && values.netMinor + values.vatMinor !== values.grossMinor) {
    checks.push({
      code: 'header_net_vat_gross', severity: 'warning',
      message: `Net ${fmt(values.netMinor)} + VAT ${fmt(values.vatMinor)} = ${fmt(values.netMinor + values.vatMinor)}, `
        + `but the total is ${fmt(values.grossMinor)}.`,
    });
  }

  // Each line: net × rate ≈ VAT, and net + VAT = gross.
  values.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.description.trim()) {
      checks.push({ code: `line_${n}_description`, severity: 'error', message: `Line ${n} has no description.` });
    }
    if (line.netMinor !== null && line.vatRateBasisPoints !== null && line.vatMinor !== null) {
      const expected = vatFromNet(line.netMinor, line.vatRateBasisPoints);
      if (!withinRounding(expected, line.vatMinor, 1)) {
        checks.push({
          code: `line_${n}_vat`, severity: 'warning',
          message: `Line ${n}: ${line.vatRateBasisPoints / 100}% of ${fmt(line.netMinor)} is ${fmt(expected)}, `
            + `but the VAT shown is ${fmt(line.vatMinor)}.`,
        });
      }
    }
    if (line.netMinor !== null && line.vatMinor !== null && line.grossMinor !== null
        && line.netMinor + line.vatMinor !== line.grossMinor) {
      checks.push({
        code: `line_${n}_gross`, severity: 'warning',
        message: `Line ${n}: net + VAT does not equal the line total.`,
      });
    }
  });

  // Lines sum to the header.
  const lineNets = values.lines.map((l) => l.netMinor).filter((v): v is number => v !== null);
  if (values.netMinor !== null && lineNets.length === values.lines.length && values.lines.length > 0) {
    const total = sum(lineNets);
    if (total !== values.netMinor) {
      checks.push({
        code: 'lines_net_sum', severity: 'warning',
        message: `The lines' net amounts add up to ${fmt(total)}, but the document's net is ${fmt(values.netMinor)}.`,
      });
    }
  }
  const lineVats = values.lines.map((l) => l.vatMinor).filter((v): v is number => v !== null);
  if (values.vatMinor !== null && lineVats.length === values.lines.length && values.lines.length > 0) {
    const total = sum(lineVats);
    if (!withinRounding(total, values.vatMinor, values.lines.length)) {
      checks.push({
        code: 'lines_vat_sum', severity: 'warning',
        message: `The lines' VAT adds up to ${fmt(total)}, but the document's VAT is ${fmt(values.vatMinor)}.`,
      });
    }
  }

  // Per-rate totals: net × rate ≈ VAT, and they sum to the header.
  values.vatTotals.forEach((band, i) => {
    if (band.netMinor !== null && band.rateBasisPoints !== null && band.vatMinor !== null) {
      const expected = vatFromNet(band.netMinor, band.rateBasisPoints);
      if (!withinRounding(expected, band.vatMinor, values.lines.filter((l) => l.vatRateBasisPoints === band.rateBasisPoints).length)) {
        checks.push({
          code: `vat_total_${i + 1}_rate`, severity: 'warning',
          message: `VAT total ${band.label ?? `${band.rateBasisPoints / 100}%`}: ${band.rateBasisPoints / 100}% of `
            + `${fmt(band.netMinor)} is ${fmt(expected)}, but ${fmt(band.vatMinor)} is shown.`,
        });
      }
    }
  });
  if (values.vatTotals.length > 0) {
    const bandVat = values.vatTotals.map((b) => b.vatMinor);
    if (values.vatMinor !== null && bandVat.every((v): v is number => v !== null)
        && sum(bandVat) !== values.vatMinor) {
      checks.push({
        code: 'vat_totals_sum', severity: 'warning',
        message: `The VAT totals per rate add up to ${fmt(sum(bandVat))}, but the document's VAT is ${fmt(values.vatMinor)}.`,
      });
    }
    const bandNet = values.vatTotals.map((b) => b.netMinor);
    if (values.netMinor !== null && bandNet.every((v): v is number => v !== null)
        && sum(bandNet) !== values.netMinor) {
      checks.push({
        code: 'vat_totals_net_sum', severity: 'warning',
        message: `The net amounts per rate add up to ${fmt(sum(bandNet))}, but the document's net is ${fmt(values.netMinor)}.`,
      });
    }
  }

  return checks;
}

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

import { and, eq } from 'drizzle-orm';
import { atomically } from '../accounting/journal';
import type { AppDatabase } from '@/db';
import { documents, documentLines, documentVatTotals, auditEvents, companies } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate, type IsoDate } from '../dates';
import { AccountingError } from '../accounting/errors';
import { assertDocumentConfirmed } from '../documents/review';
import { upsertReviewItem } from '../extraction/service';
import { resolveTreatment } from '../vat/engine';
import { documentLineChoices } from './suggest';
import { createInvoice, type CreatedInvoice, type InvoiceLineInput } from '../invoicing/invoices';

/**
 * Post a confirmed document as an invoice (issue #203).
 *
 * The invoice is the only proof of a supply and its VAT; the bank line only
 * proves payment. So the VAT posted here is the VAT the person confirmed on the
 * document, line by line — never a split of a bank amount. One invoice line is
 * posted per printed line, carrying that line's stated net and VAT. Where the
 * document gives only per-rate totals, one line per rate is posted from those;
 * where it gives neither, one line from the header.
 *
 * The person codes each evidence line (account and VAT treatment), usually by
 * accepting a suggestion. Whatever cannot be reconciled with what is printed is
 * refused with a reason, not quietly adjusted: nothing is silently repaired.
 */

export class ConsolidationError extends AccountingError {}

/** One line of evidence on the document, as it will be posted. */
export interface EvidenceLine {
  /** 1-based position among the evidence lines. */
  number: number;
  /** Where it came from: a printed line, a per-rate total, or the header. */
  origin: 'line' | 'vat_total' | 'header';
  documentLineId: string | null;
  description: string;
  quantity: string | null;
  unitPriceMinor: number | null;
  netMinor: number;
  /** As printed; null when the document does not state VAT for this line. */
  vatMinor: number | null;
  rateBasisPoints: number | null;
}

export interface LineCoding {
  accountId: string;
  vatTreatmentId: string;
  taxRateId?: string;
  /** Statutory rules behind the treatment (from the suggestion), for the trace. */
  vatRuleKeys?: string[];
}

export interface PostDocumentInput {
  companyId: string;
  documentId: string;
  /** One coding per evidence line, in order (see `documentEvidenceLines`). */
  coding: LineCoding[];
  /** Required when the document's currency is not the company's base currency. */
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  /**
   * Declare the VAT in the VAT period covering this date: only for a late
   * document whose own period's return is locked or filed (issue #226).
   */
  vatDeclarationDate?: IsoDate;
  actor?: string;
  requestId?: string;
}

type DocumentRow = typeof documents.$inferSelect;

/** Which way the document runs, or null when it is not a VAT invoice at all. */
export function documentDirection(doc: Pick<DocumentRow, 'documentType' | 'customerId' | 'supplierId'>):
  'sales' | 'purchase' | null {
  switch (doc.documentType) {
    case 'sales_invoice':
    case 'sales_record':
      return 'sales';
    case 'supplier_invoice':
    case 'receipt':
      return 'purchase';
    case 'credit_note':
      // A credit note we issued names our customer; one we received names our supplier.
      return doc.customerId && !doc.supplierId ? 'sales' : 'purchase';
    default:
      return null;
  }
}

/**
 * The lines that will be posted, derived from the confirmed document without
 * inventing any figure. Throws when the document does not support posting.
 */
export function documentEvidenceLines(db: AppDatabase, params: { companyId: string; documentId: string }): {
  document: DocumentRow;
  direction: 'sales' | 'purchase';
  lines: EvidenceLine[];
} {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) throw new ConsolidationError(`Document ${params.documentId} not found.`);
  assertDocumentConfirmed(doc, 'posting it');

  const direction = documentDirection(doc);
  if (!direction) {
    throw new ConsolidationError(
      `A ${doc.documentType.replace(/_/g, ' ')} is not a VAT invoice, so it cannot be posted as one.`,
    );
  }

  const printed = db.select().from(documentLines).where(eq(documentLines.documentId, doc.id))
    .orderBy(documentLines.lineNumber).all();
  if (printed.length > 0) {
    return {
      document: doc, direction,
      lines: printed.map((l, i) => {
        const net = l.netMinor ?? (l.grossMinor !== null && l.vatMinor !== null ? l.grossMinor - l.vatMinor : null);
        if (net === null) {
          throw new ConsolidationError(
            `Line ${i + 1} ("${l.description}") has no net amount. Reopen the document and enter it from the page.`,
          );
        }
        return {
          number: i + 1, origin: 'line' as const, documentLineId: l.id, description: l.description,
          quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, netMinor: net,
          vatMinor: l.vatMinor, rateBasisPoints: l.vatRateBasisPoints,
        };
      }),
    };
  }

  const bands = db.select().from(documentVatTotals).where(eq(documentVatTotals.documentId, doc.id)).all();
  if (bands.length > 0 && bands.every((b) => b.netMinor !== null)) {
    return {
      document: doc, direction,
      lines: bands.map((b, i) => ({
        number: i + 1, origin: 'vat_total' as const, documentLineId: null,
        description: b.label ?? (b.rateBasisPoints !== null ? `Supplies at ${b.rateBasisPoints / 100}%` : 'Supplies'),
        quantity: null, unitPriceMinor: null, netMinor: b.netMinor!, vatMinor: b.vatMinor,
        rateBasisPoints: b.rateBasisPoints,
      })),
    };
  }

  // Header only. The net is what is printed; where only a total and a VAT figure
  // are printed, net = total - VAT is exact. A bare total is posted as the net
  // only if the treatment charges no VAT — checked when coded (see postDocumentAsInvoice).
  const net = doc.netMinor
    ?? (doc.grossMinor !== null && doc.vatMinor !== null ? doc.grossMinor - doc.vatMinor : doc.grossMinor);
  if (net === null) {
    throw new ConsolidationError('The document has no amounts. Reopen it and enter them from the page.');
  }
  return {
    document: doc, direction,
    lines: [{
      number: 1, origin: 'header', documentLineId: null,
      description: doc.invoiceNumber ? `Invoice ${doc.invoiceNumber}` : doc.originalFilename,
      quantity: null, unitPriceMinor: null, netMinor: net,
      vatMinor: doc.vatMinor, rateBasisPoints: null,
    }],
  };
}

const quantityMilli = (q: string | null): number | undefined => {
  if (!q || !/^\d+(\.\d{1,3})?$/.test(q)) return undefined;
  const [whole = '0', frac = ''] = q.split('.');
  return Number(whole) * 1000 + Number((frac + '000').slice(0, 3));
};

export function postDocumentAsInvoice(
  db: AppDatabase, input: Parameters<typeof postDocumentAsInvoiceSteps>[1],
): ReturnType<typeof postDocumentAsInvoiceSteps> {
  return atomically(db, () => postDocumentAsInvoiceSteps(db, input));
}

function postDocumentAsInvoiceSteps(db: AppDatabase, input: PostDocumentInput): CreatedInvoice {
  const { document: doc, direction, lines } = documentEvidenceLines(db, input);
  if (doc.invoiceId) {
    throw new ConsolidationError('This document has already been posted as an invoice.', { invoiceId: doc.invoiceId });
  }
  if (input.coding.length !== lines.length) {
    throw new ConsolidationError(
      `The document has ${lines.length} line${lines.length === 1 ? '' : 's'} to post, `
        + `but ${input.coding.length} ${input.coding.length === 1 ? 'was' : 'were'} coded. Code every line.`,
    );
  }
  if (!doc.documentDate) throw new ConsolidationError('The document has no date.');
  const partyId = direction === 'sales' ? doc.customerId : doc.supplierId;
  if (!partyId) {
    throw new ConsolidationError(
      `The document is not linked to a ${direction === 'sales' ? 'customer' : 'supplier'}. `
        + 'Reopen it and choose one when confirming.',
    );
  }
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get()!;
  const currency = (doc.currency ?? company.baseCurrency).toUpperCase();
  const invoiceDate = asIsoDate(doc.documentDate);
  const taxPoint = asIsoDate(doc.supplyDate ?? doc.documentDate);

  const invoiceLines: InvoiceLineInput[] = lines.map((line, i) => {
    const coding = input.coding[i]!;
    const resolved = resolveTreatment(db, {
      companyId: input.companyId, treatmentId: coding.vatTreatmentId, onDate: taxPoint, rateOverrideId: coding.taxRateId,
    });
    const t = resolved.treatment;
    const where = `Line ${line.number} ("${line.description}")`;

    // A rate printed on the line must agree with the treatment chosen for it.
    if (t.appliesRate && !t.isReverseCharge && line.rateBasisPoints !== null
        && line.rateBasisPoints !== resolved.rateBasisPoints) {
      throw new ConsolidationError(
        `${where} is printed at ${line.rateBasisPoints / 100}%, but "${t.name}" is ${resolved.rateBasisPoints / 100}% `
          + 'on this date. Choose the treatment that matches the document.',
      );
    }
    // A treatment that charges no VAT cannot sit on a line where VAT was charged.
    if (!t.appliesRate && line.vatMinor !== null && line.vatMinor !== 0) {
      throw new ConsolidationError(
        `${where} shows VAT of ${(line.vatMinor / 100).toFixed(2)}, but "${t.name}" charges none. `
          + 'Choose a treatment that matches the document.',
      );
    }
    // A header-only document with a bare total: that total is the net only when no VAT arises.
    if (line.origin === 'header' && doc.netMinor === null && doc.vatMinor === null
        && t.appliesRate && !t.isReverseCharge) {
      throw new ConsolidationError(
        'The document states only a total, with no net or VAT, but the chosen treatment charges VAT. '
          + 'Reopen the document and enter the VAT shown on it, or choose the treatment it actually states.',
      );
    }

    return {
      description: line.description,
      quantityMilli: quantityMilli(line.quantity),
      unitPriceMinor: line.unitPriceMinor ?? undefined,
      netMinor: line.netMinor,
      accountId: coding.accountId,
      vatTreatmentId: coding.vatTreatmentId,
      taxRateId: coding.taxRateId,
      // The printed VAT, as printed. Under a reverse charge the engine ignores
      // it and self-assesses on the net (and a non-zero figure is flagged).
      // When a line prints no VAT the engine applies the treatment's rate to
      // the printed net; the totals check below catches any disagreement.
      statedVatMinor: line.vatMinor ?? undefined,
      documentLineId: line.documentLineId,
      vatRuleKeys: coding.vatRuleKeys ?? [],
    };
  });

  const created = createInvoice(db, {
    companyId: input.companyId,
    direction,
    invoiceDate,
    dueDate: doc.dueDate ? asIsoDate(doc.dueDate) : null,
    supplyDate: doc.supplyDate ? asIsoDate(doc.supplyDate) : null,
    supplierId: direction === 'purchase' ? partyId : null,
    customerId: direction === 'sales' ? partyId : null,
    invoiceNumber: doc.invoiceNumber,
    currency: currency !== company.baseCurrency ? currency : undefined,
    fxRate: input.fxRate,
    lines: invoiceLines,
    documentId: doc.id,
    isCreditNote: doc.documentType === 'credit_note',
    vatDeclarationDate: input.vatDeclarationDate,
    actor: input.actor,
    requestId: input.requestId,
  });

  // The posted total must equal what the person confirmed, to within a cent
  // per line of rounding (a credit note posts negative; under a reverse charge
  // the invoice total is the net, which is what the engine posts as gross).
  const sign = doc.documentType === 'credit_note' ? -1 : 1;
  const mismatch = doc.grossMinor !== null
    && Math.abs(created.grossMinor - sign * doc.grossMinor) > lines.length;

  db.transaction((tx) => {
    tx.update(documents).set({ invoiceId: created.invoiceId, updatedAt: nowIso() })
      .where(eq(documents.id, doc.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: nowIso(),
      entityType: 'document', entityId: doc.id, action: 'updated', field: 'invoiceId',
      newValue: JSON.stringify(created.invoiceId), source: 'user', actor: input.actor ?? 'user',
      reason: `Posted as ${direction} invoice from ${lines.length} confirmed line${lines.length === 1 ? '' : 's'}`,
      requestId: input.requestId ?? null,
    }).run();
  });

  if (mismatch) {
    // Posted anyway (every line is as printed), but never silently: a total
    // that does not agree with the document is a review item.
    upsertReviewItem(db, {
      companyId: input.companyId,
      kind: 'invoice_total_mismatch',
      severity: 'warning',
      title: `"${doc.originalFilename}": posted total differs from the document`,
      detail: `The lines as posted total ${(sign * created.grossMinor / 100).toFixed(2)}, but the document's `
        + `total is ${((doc.grossMinor ?? 0) / 100).toFixed(2)}. Check each line's VAT against the page.`,
      entityType: 'invoice',
      entityId: created.invoiceId,
      dedupeKey: `invoice:${created.invoiceId}:total_mismatch`,
    });
  }
  // Each line's rate is checked against the statutory rules and, where it is
  // not the rate they give (or they cannot say), flagged for review — the
  // invoice figures are kept as printed (issue #205).
  const choices = documentLineChoices(db, { companyId: input.companyId, documentId: doc.id });
  // What the invoice says against itself or the parties' records (issue #207).
  for (const conflict of choices.conflicts) {
    upsertReviewItem(db, {
      companyId: input.companyId,
      kind: 'uncertain_vat_treatment',
      severity: 'warning',
      title: `"${doc.originalFilename}": ${conflict.code.replace(/_/g, ' ')}`,
      detail: conflict.message,
      entityType: 'invoice',
      entityId: created.invoiceId,
      dedupeKey: `invoice:${created.invoiceId}:conflict:${conflict.code}`,
    });
  }
  for (const choice of choices.lines) {
    const check = choice.rateCheck;
    if (check.outcome === 'consistent') continue;
    upsertReviewItem(db, {
      companyId: input.companyId,
      kind: 'uncertain_vat_treatment',
      severity: check.outcome === 'inconsistent' ? 'warning' : 'info',
      title: check.outcome === 'inconsistent'
        ? `"${doc.originalFilename}" line ${choice.line.number}: rate charged differs from the rules`
        : `"${doc.originalFilename}" line ${choice.line.number}: rate charged could not be confirmed`,
      detail: `"${choice.line.description}": ${check.message}`,
      entityType: 'invoice',
      entityId: created.invoiceId,
      dedupeKey: `invoice:${created.invoiceId}:line:${choice.line.number}:rate`,
    });
  }
  return created;
}

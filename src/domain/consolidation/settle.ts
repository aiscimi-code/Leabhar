import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankTransactions, invoices, documents, documentMatches } from '@/db/schema';
import { asIsoDate } from '../dates';
import { recordPayment, type RecordedPayment } from '../invoicing/payments';
import { upsertReviewItem } from '../extraction/service';
import { ConsolidationError } from './postDocument';
import { resolveReviewItems } from '../matching/service';
import { nowIso } from '../dates';

/**
 * Settle a bank line against one or more invoices (issue #203).
 *
 * The bank line proves payment; the invoices prove the supplies and their VAT.
 * Consolidation is the payment between them: one payment can settle several
 * invoices, one invoice can be settled by several payments, and a payment can
 * be net of a credit note (the credit note is allocated alongside the
 * invoices). No VAT is computed here from the bank amount — the VAT was posted
 * from the invoice lines. On the cash receipts basis the payment releases a
 * sales invoice's deferred output VAT, dated at the receipt (`recordPayment`).
 *
 * Money left over is a payment on account. It is posted, and flagged.
 */

export interface SettleAllocation {
  invoiceId: string;
  /** Positive cash applied to this invoice (or credit note), in the bank line's currency. */
  amountMinor: number;
}

export interface SettleInput {
  companyId: string;
  bankTransactionId: string;
  allocations: SettleAllocation[];
  /** Needed when the bank line's currency is not the base currency, or differs from an invoice's. */
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  actor?: string;
  requestId?: string;
}

export function settleBankTransaction(db: AppDatabase, input: SettleInput): RecordedPayment {
  const tx = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.id, input.bankTransactionId), eq(bankTransactions.companyId, input.companyId)))
    .get();
  if (!tx) throw new ConsolidationError(`Bank transaction ${input.bankTransactionId} not found.`);
  if (input.allocations.length === 0) {
    throw new ConsolidationError('Choose at least one invoice for this payment to settle.');
  }

  // A purchase invoice must rest on a confirmed document: that is the evidence
  // for the VAT it carries. (Sales invoices the company issued itself are
  // their own evidence.)
  for (const allocation of input.allocations) {
    const invoice = db.select().from(invoices)
      .where(and(eq(invoices.id, allocation.invoiceId), eq(invoices.companyId, input.companyId))).get();
    if (!invoice) throw new ConsolidationError(`Invoice ${allocation.invoiceId} not found.`);
    if (invoice.direction === 'purchase') {
      const doc = invoice.documentId
        ? db.select({ reviewStatus: documents.reviewStatus }).from(documents)
          .where(eq(documents.id, invoice.documentId)).get()
        : undefined;
      if (doc?.reviewStatus !== 'confirmed') {
        throw new ConsolidationError(
          `Invoice ${invoice.invoiceNumber ?? invoice.id} has no confirmed supplier document behind it.`,
        );
      }
    }
  }

  const payment = recordPayment(db, {
    companyId: input.companyId,
    direction: tx.amountMinor < 0 ? 'made' : 'received',
    paymentDate: asIsoDate(tx.transactionDate),
    amountMinor: Math.abs(tx.amountMinor),
    currency: tx.currency,
    fxRate: input.fxRate,
    method: 'bank_transfer',
    bankTransactionId: tx.id,
    allocations: input.allocations.map((a) => ({ invoiceId: a.invoiceId, allocatedMinor: a.amountMinor })),
    reference: tx.description.slice(0, 60),
    actor: input.actor,
    requestId: input.requestId,
  });

  // Each invoice's document now has its bank evidence: record the link the
  // documents screen shows (the first payment, where an invoice is paid in parts).
  for (const allocation of input.allocations) {
    const invoice = db.select({ documentId: invoices.documentId }).from(invoices)
      .where(eq(invoices.id, allocation.invoiceId)).get();
    if (!invoice?.documentId) continue;
    db.update(documents).set({ matchedTransactionId: tx.id, matchStatus: 'matched' })
      .where(and(eq(documents.id, invoice.documentId), isNull(documents.matchedTransactionId))).run();
    // Settling is the person's decision on the match: record the scored
    // candidate for this pair as accepted, and the document's other pending
    // candidates as rejected by implication (as acceptMatch does).
    const decidedAt = nowIso();
    db.update(documentMatches).set({
      decision: 'accepted', decidedAt, decidedBy: input.actor ?? 'user',
      decisionReason: 'Settled against its invoice', provenanceStatus: 'user_confirmed',
    }).where(and(
      eq(documentMatches.documentId, invoice.documentId), eq(documentMatches.bankTransactionId, tx.id),
      eq(documentMatches.decision, 'pending'),
    )).run();
    db.update(documentMatches).set({ decision: 'rejected', decidedAt })
      .where(and(
        eq(documentMatches.documentId, invoice.documentId), ne(documentMatches.bankTransactionId, tx.id),
        eq(documentMatches.decision, 'pending'),
      )).run();
    resolveReviewItems(db, input.companyId, `document:${invoice.documentId}:match`,
      `Settled by bank transaction ${tx.id}.`);
    resolveReviewItems(db, input.companyId, `document:${invoice.documentId}:no_match`, 'Settled by a payment.');
  }

  if (payment.unallocatedMinor !== 0) {
    upsertReviewItem(db, {
      companyId: input.companyId,
      kind: 'unmatched_transaction',
      severity: 'warning',
      title: `${(payment.unallocatedMinor / 100).toFixed(2)} of "${tx.description}" is not matched to an invoice`,
      detail: 'The rest of this bank line settled the invoices chosen. The remainder is held as a payment on '
        + 'account against the supplier or customer until an invoice for it is confirmed and allocated.',
      entityType: 'bank_transaction',
      entityId: tx.id,
      dedupeKey: `bank_transaction:${tx.id}:unallocated`,
    });
  }
  return payment;
}

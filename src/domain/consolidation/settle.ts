import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankTransactions, invoices, documents, documentMatches, companies } from '@/db/schema';
import { asIsoDate, type IsoDate } from '../dates';
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
  /** See `RecordPaymentInput.vatDeclarationDate` (issue #226). */
  vatDeclarationDate?: IsoDate | null;
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

  assertInvoicesEvidenced(db, input.companyId, input.allocations);

  const payment = recordPayment(db, {
    companyId: input.companyId,
    direction: tx.amountMinor < 0 ? 'made' : 'received',
    paymentDate: asIsoDate(tx.transactionDate),
    amountMinor: Math.abs(tx.amountMinor),
    currency: tx.currency,
    fxRate: input.fxRate ?? statementRate(db, input.companyId, tx),
    vatDeclarationDate: input.vatDeclarationDate,
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

/**
 * A purchase invoice must rest on a confirmed document: that is the evidence
 * for the VAT it carries. (Sales invoices the company issued itself are their
 * own evidence.)
 */
function assertInvoicesEvidenced(db: AppDatabase, companyId: string, allocations: SettleAllocation[]): void {
  for (const allocation of allocations) {
    const invoice = db.select().from(invoices)
      .where(and(eq(invoices.id, allocation.invoiceId), eq(invoices.companyId, companyId))).get();
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
}

export interface SettleByDirectorInput {
  companyId: string;
  officerId: string;
  /** The day the director paid. */
  paymentDate: IsoDate;
  allocations: SettleAllocation[];
  currency?: string;
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  reference?: string | null;
  actor?: string;
  requestId?: string;
}

/**
 * Settle purchase invoices a director paid personally (issue #221): a card
 * payment on a personal account, say. No company money moved, so there is no
 * bank line; the director's current account is credited with what they paid
 * and the company owes it to them. As with a bank settlement, the input VAT
 * was posted from the confirmed invoice's lines — nothing is computed here.
 */
export function settleInvoiceByDirector(db: AppDatabase, input: SettleByDirectorInput): RecordedPayment {
  if (input.allocations.length === 0) {
    throw new ConsolidationError('Choose at least one invoice the director paid.');
  }
  for (const allocation of input.allocations) {
    const invoice = db.select({ direction: invoices.direction }).from(invoices)
      .where(and(eq(invoices.id, allocation.invoiceId), eq(invoices.companyId, input.companyId))).get();
    if (invoice && invoice.direction !== 'purchase') {
      throw new ConsolidationError('A director pays purchase invoices; a sales invoice is paid by the customer.');
    }
  }
  assertInvoicesEvidenced(db, input.companyId, input.allocations);
  const amountMinor = input.allocations.reduce((sum, a) => {
    const invoice = db.select({ isCreditNote: invoices.isCreditNote }).from(invoices)
      .where(eq(invoices.id, a.invoiceId)).get();
    return sum + (invoice?.isCreditNote ? -a.amountMinor : a.amountMinor);
  }, 0);
  return recordPayment(db, {
    companyId: input.companyId,
    direction: 'made',
    paymentDate: input.paymentDate,
    amountMinor,
    currency: input.currency,
    fxRate: input.fxRate,
    method: 'director_personal',
    officerId: input.officerId,
    allocations: input.allocations.map((a) => ({ invoiceId: a.invoiceId, allocatedMinor: a.amountMinor })),
    reference: input.reference ?? null,
    actor: input.actor,
    requestId: input.requestId,
  });
}

/**
 * The bank's own rate, when the statement carried one for a foreign-currency
 * line: it converts the line to base currency. A rate the person enters takes
 * precedence (issue #223).
 */
function statementRate(
  db: AppDatabase, companyId: string, tx: typeof bankTransactions.$inferSelect,
): SettleInput['fxRate'] {
  const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
  if (tx.currency.toUpperCase() === base.toUpperCase()) return undefined;
  if (!tx.fxRateNumerator || !tx.fxRateDenominator) return undefined;
  return {
    numerator: tx.fxRateNumerator, denominator: tx.fxRateDenominator,
    source: tx.fxRateSource ?? 'bank_statement',
  };
}

/** What exchange rate, if any, settling a bank line against these invoices needs (issue #223). */
export type SettlementRateNeed =
  | { needed: false; statementRate: string | null }
  | {
      needed: true;
      /** One unit of this currency (the bank line's)… */
      from: string;
      /** …is worth this many units of this one. */
      to: string;
      /** Why the rate is asked for, for the screen. */
      reason: string;
      /** The statement's own rate, when there is one to pre-fill with. */
      statementRate: string | null;
    }
  | { needed: 'unsupported'; reason: string };

/**
 * `recordPayment` takes one rate, converting the payment's currency: to base
 * when the bank line is foreign (and then to the invoice currency, which must
 * be the same or base), otherwise to the invoice's currency.
 */
export function settlementRateNeed(
  db: AppDatabase, input: { companyId: string; bankTransactionId: string; invoiceIds: string[] },
): SettlementRateNeed {
  const tx = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.id, input.bankTransactionId), eq(bankTransactions.companyId, input.companyId)))
    .get();
  if (!tx) throw new ConsolidationError(`Bank transaction ${input.bankTransactionId} not found.`);
  const base = db.select({ c: companies.baseCurrency }).from(companies)
    .where(eq(companies.id, input.companyId)).get()!.c.toUpperCase();
  const paid = tx.currency.toUpperCase();
  const invoiceCurrencies = [...new Set(input.invoiceIds.map((id) => db.select({ c: invoices.currency })
    .from(invoices).where(and(eq(invoices.id, id), eq(invoices.companyId, input.companyId))).get()?.c.toUpperCase())
    .filter((c): c is string => Boolean(c)))];
  const statement = statementRate(db, input.companyId, tx);
  // For display only: the posting uses the statement's exact fraction.
  const statementText = statement ? (statement.numerator / statement.denominator).toFixed(6) : null;

  if (paid !== base) {
    const other = invoiceCurrencies.find((c) => c !== paid && c !== base);
    if (other) {
      return {
        needed: 'unsupported',
        reason: `A ${other} invoice settled from a ${paid} bank line involves three currencies with ${base} as `
          + 'the base currency, and is not supported.',
      };
    }
    return {
      needed: true, from: paid, to: base, statementRate: statementText,
      reason: statement
        ? `The statement gives the bank's rate for this ${paid} line; change it only if the bank's figure is wrong.`
        : `This bank line is in ${paid}: the rate converts it to ${base} for the books.`,
    };
  }
  const foreign = invoiceCurrencies.filter((c) => c !== paid);
  if (foreign.length > 1) {
    return {
      needed: 'unsupported',
      reason: `The invoices ticked are in ${foreign.join(' and ')}. Settle one currency at a time.`,
    };
  }
  if (foreign.length === 1) {
    return {
      needed: true, from: paid, to: foreign[0]!, statementRate: null,
      reason: `The invoice is in ${foreign[0]} and the payment in ${paid}: the rate converts what was paid into `
        + 'the invoice\'s currency to settle it.',
    };
  }
  return { needed: false, statementRate: null };
}

class DryRun extends Error {
  constructor(readonly payment: RecordedPayment) { super('dry run'); }
}

/**
 * What settling would post — the amount applied to each invoice in its own
 * currency, the exchange difference, what is left on account — computed by
 * the same code that posts it, inside a transaction that is always rolled
 * back. Nothing is written (issue #223).
 */
export function previewSettlement(
  db: AppDatabase, input: SettleInput,
): { ok: true; payment: RecordedPayment } | { ok: false; error: string } {
  try {
    db.transaction(() => { throw new DryRun(settleBankTransaction(db, input)); });
    throw new Error('unreachable');
  } catch (error) {
    if (error instanceof DryRun) return { ok: true, payment: error.payment };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  payments, paymentAllocations, invoices, companies, auditEvents, customers, suppliers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { InvoicingError } from './invoices';
import { resolveReviewItems } from '../matching/service';

/**
 * Money held on account (issue #386).
 *
 * A payment worth more than the invoices it settled leaves the rest on the
 * debtors or creditors control account, against the payment's customer or
 * supplier. Applying it to a later invoice of the same party moves nothing in
 * the ledger — both balances already sit on that control account — so it
 * posts no journal. It records an allocation and updates the invoice, audited.
 */

type Payment = typeof payments.$inferSelect;

/** What of a payment is still on account, in its currency (base currency only). */
export function onAccountMinor(db: AppDatabase, payment: Payment): number {
  // A refund, or a credit note applied without cash, holds nothing on account itself.
  if (payment.refundOfPaymentId || payment.method === 'offset') return 0;
  const expected = payment.direction === 'received' ? 'sales' : 'purchase';
  const rows = db.select({ allocation: paymentAllocations, invoice: invoices })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .where(eq(paymentAllocations.paymentId, payment.id)).all();
  let applied = 0;
  for (const { allocation, invoice } of rows) {
    if (allocation.allocationType === 'write_off') continue;
    // baseAllocatedMinor is signed as the invoice moved: negative for a credit
    // note. A credit note netted against the payment reduces the cash applied;
    // one refunded by it (the opposite direction, issue #157) is cash applied.
    const refunded = invoice.isCreditNote && invoice.direction !== expected;
    applied += refunded ? -allocation.baseAllocatedMinor : allocation.baseAllocatedMinor;
  }
  // Money on account refunded (issue #402), unless the refund was reversed.
  const refunded = db.select({ base: payments.baseAmountMinor }).from(payments).where(and(
    eq(payments.refundOfPaymentId, payment.id), isNull(payments.reversedAt),
  )).all().reduce((sum, r) => sum + r.base, 0);
  return payment.baseAmountMinor - applied - refunded;
}

export interface PaymentOnAccount {
  paymentId: string;
  paymentDate: string;
  direction: 'received' | 'made';
  customerId: string | null;
  supplierId: string | null;
  partyName: string | null;
  currency: string;
  onAccountMinor: number;
  reference: string | null;
  bankTransactionId: string | null;
}

/**
 * Standing payments with money still on account, oldest first. Filtered to one
 * party when given. Only base-currency payments can be applied here.
 */
export function paymentsOnAccount(
  db: AppDatabase,
  params: { companyId: string; customerId?: string | null; supplierId?: string | null },
): PaymentOnAccount[] {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) return [];
  const rows = db.select().from(payments).where(and(
    eq(payments.companyId, params.companyId),
    isNull(payments.reversedAt),
    eq(payments.currency, company.baseCurrency),
    params.customerId ? eq(payments.customerId, params.customerId) : undefined,
    params.supplierId ? eq(payments.supplierId, params.supplierId) : undefined,
  )).orderBy(payments.paymentDate).all();
  const out: PaymentOnAccount[] = [];
  for (const payment of rows) {
    const remaining = onAccountMinor(db, payment);
    if (remaining <= 0) continue;
    const partyName = payment.customerId
      ? db.select({ n: customers.name }).from(customers).where(eq(customers.id, payment.customerId)).get()?.n ?? null
      : payment.supplierId
        ? db.select({ n: suppliers.name }).from(suppliers).where(eq(suppliers.id, payment.supplierId)).get()?.n ?? null
        : null;
    out.push({
      paymentId: payment.id, paymentDate: payment.paymentDate, direction: payment.direction,
      customerId: payment.customerId, supplierId: payment.supplierId, partyName,
      currency: payment.currency, onAccountMinor: remaining,
      reference: payment.reference, bankTransactionId: payment.bankTransactionId,
    });
  }
  return out;
}

export interface OnAccountAllocation {
  allocationId: string;
  /** What is still on account after this allocation. */
  onAccountMinor: number;
  invoiceStatus: string;
  outstandingMinor: number;
}

/**
 * Apply money a payment holds on account to an invoice of the same party.
 * Refused unless the payment stands, is in base currency and names its party;
 * the invoice is an ordinary open invoice of that party in base currency and
 * the payment's direction; and the amount is no more than what is on account
 * or outstanding. On the cash receipts basis a sales invoice with VAT is
 * refused: applying the receipt would make its VAT due, and on what date is a
 * decision this does not take (see issue #389).
 */
export function allocatePaymentOnAccount(
  db: AppDatabase,
  params: {
    companyId: string; paymentId: string; invoiceId: string; amountMinor: number;
    actor: string; reason?: string | null; requestId?: string;
  },
): OnAccountAllocation {
  const actor = params.actor.trim();
  if (!actor) throw new InvoicingError('Say who is applying this money.');
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new InvoicingError('The amount to apply must be a positive amount in minor units.');
  }
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new InvoicingError(`Company ${params.companyId} not found.`);
  const payment = db.select().from(payments)
    .where(and(eq(payments.id, params.paymentId), eq(payments.companyId, params.companyId))).get();
  if (!payment) throw new InvoicingError(`Payment ${params.paymentId} not found.`);
  if (payment.reversedAt) throw new InvoicingError('This payment has been reversed; nothing of it is on account.');
  const base = company.baseCurrency.toUpperCase();
  if (payment.currency.toUpperCase() !== base) {
    throw new InvoicingError(
      `This payment is in ${payment.currency}. Money on account can be applied in ${base} only for now; `
        + 'a foreign-currency payment would need an exchange difference worked out on application.',
    );
  }
  if (!payment.customerId && !payment.supplierId) {
    throw new InvoicingError(
      'This payment does not record whose money it is (it settled several parties, or was recorded before '
        + 'payments carried a party). Reverse it and settle it again against the right party\'s invoices.',
    );
  }

  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!invoice) throw new InvoicingError(`Invoice ${params.invoiceId} not found.`);
  const label = invoice.invoiceNumber ?? invoice.id;
  if (invoice.status === 'void') throw new InvoicingError(`Invoice ${label} has been voided.`);
  if (invoice.isCreditNote) {
    throw new InvoicingError('Money on account is applied to invoices; a credit note adds to what is owed back, not to what was paid.');
  }
  const expected = payment.direction === 'received' ? 'sales' : 'purchase';
  if (invoice.direction !== expected) {
    throw new InvoicingError(`A payment ${payment.direction} cannot be applied to a ${invoice.direction} invoice.`);
  }
  if ((payment.customerId ?? null) !== (invoice.customerId ?? null)
    || (payment.supplierId ?? null) !== (invoice.supplierId ?? null)) {
    throw new InvoicingError(`Invoice ${label} belongs to a different party from the one this payment came from.`);
  }
  if (invoice.currency.toUpperCase() !== base) {
    throw new InvoicingError(`Invoice ${label} is in ${invoice.currency}; money on account can be applied in ${base} only for now.`);
  }
  if (invoice.direction === 'sales' && invoice.vatMinor !== 0 && company.vatAccountingBasis === 'cash_receipts') {
    throw new InvoicingError(
      'On the cash receipts basis applying a receipt to this invoice makes its output VAT due, and that is not '
        + 'yet supported for money held on account. Reverse the payment and settle it against this invoice instead.',
    );
  }
  if (params.amountMinor > invoice.outstandingMinor) {
    throw new InvoicingError(
      `Invoice ${label} has ${invoice.outstandingMinor} outstanding; ${params.amountMinor} would overpay it.`,
    );
  }
  const available = onAccountMinor(db, payment);
  if (params.amountMinor > available) {
    throw new InvoicingError(`Only ${available} of this payment is on account.`);
  }

  const timestamp = nowIso();
  const allocationId = ids.allocation();
  const paidMinor = invoice.paidMinor + params.amountMinor;
  const outstandingMinor = invoice.grossMinor - paidMinor;
  const status = outstandingMinor === 0 ? 'paid' : 'part_paid';
  const remaining = available - params.amountMinor;

  db.transaction((tx) => {
    tx.insert(paymentAllocations).values({
      id: allocationId,
      companyId: params.companyId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      allocatedMinor: params.amountMinor,
      baseAllocatedMinor: params.amountMinor,
      currency: invoice.currency,
      fxDifferenceMinor: 0,
      allocationType: 'on_account',
      notes: params.reason?.trim() || null,
    }).run();
    tx.update(invoices).set({ paidMinor, outstandingMinor, status, updatedAt: timestamp })
      .where(eq(invoices.id, invoice.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'payment', entityId: payment.id, action: 'updated', field: 'on_account_allocation',
      previousValue: String(available),
      newValue: JSON.stringify({ invoiceId: invoice.id, amountMinor: params.amountMinor, onAccountMinor: remaining }),
      source: 'user', actor, reason: params.reason?.trim() || 'Money on account applied to a later invoice',
      requestId: params.requestId ?? null,
    }).run();
  });

  if (remaining === 0 && payment.bankTransactionId) {
    resolveReviewItems(db, params.companyId, `bank_transaction:${payment.bankTransactionId}:unallocated`,
      `Money on account applied to invoice ${label}.`);
  }
  return { allocationId, onAccountMinor: remaining, invoiceStatus: status, outstandingMinor };
}

/** Standing payments of this invoice's party with money on account. */
export function onAccountForInvoice(db: AppDatabase, params: { companyId: string; invoiceId: string }): PaymentOnAccount[] {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!invoice || invoice.isCreditNote || invoice.outstandingMinor <= 0) return [];
  if (!invoice.customerId && !invoice.supplierId) return [];
  const direction = invoice.direction === 'sales' ? 'received' : 'made';
  return paymentsOnAccount(db, {
    companyId: params.companyId, customerId: invoice.customerId, supplierId: invoice.supplierId,
  }).filter((p) => p.direction === direction);
}

import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  payments, paymentAllocations, invoices, companies, auditEvents, customers, suppliers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { InvoicingError } from './invoices';
import { resolveReviewItems } from '../matching/service';
import { postJournalEntry, assertAccountingPeriodOpen } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { createVatEntries, assertVatPeriodWritable } from '../vat/engine';
import { computeVatReleases } from './payments';
import { invoiceVatDeferred } from '../vat/basis';

/**
 * Money held on account (issue #386).
 *
 * A payment worth more than the invoices it settled leaves the rest on the
 * debtors or creditors control account, against the payment's customer or
 * supplier. Applying it to a later invoice of the same party moves nothing in
 * the ledger — both balances already sit on that control account — so it
 * posts no journal. It records an allocation and updates the invoice, audited.
 *
 * One exception, the cash receipts basis (issue #389): output VAT on a sales
 * invoice is due on the money, and the tax point is the day the money arrived
 * (VATCA s.80(1)), not the day it is applied. Applying money on account to a
 * cash-basis sales invoice with VAT therefore releases the deferred VAT on
 * the applied share, dated at the original receipt. If that date's VAT period
 * is locked or filed, nothing is written into it and nothing is silently moved
 * to the application date: the person names an open period to declare it in
 * (`vatDeclarationDate`, a late declaration, flagged), or the path refuses.
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
    // A shortfall written off, or RCT deducted (issue #549), is not cash the payment applied.
    if (allocation.allocationType === 'write_off' || allocation.allocationType === 'rct_deduction') continue;
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
  /** The output VAT this application released (cash receipts basis), in base minor units. */
  vatReleasedMinor: number;
  /** The VAT entries the release created, when it released any. */
  vatEntryIds: string[];
}

/**
 * Apply money a payment holds on account to an invoice of the same party.
 * Refused unless the payment stands, is in base currency and names its party;
 * the invoice is an ordinary open invoice of that party in base currency and
 * the payment's direction; and the amount is no more than what is on account
 * or outstanding.
 *
 * On the cash receipts basis a sales invoice with VAT releases its deferred
 * output VAT on the applied share, with the tax point of the original receipt
 * (s.80(1), issue #389). The receipt's period must be writable for that to
 * happen; if it is locked or filed, the person names an open period to declare
 * it in (`vatDeclarationDate`) — a late declaration, flagged, never a silent
 * move to the application date — and without one the path refuses.
 */
export function allocatePaymentOnAccount(
  db: AppDatabase,
  params: {
    companyId: string; paymentId: string; invoiceId: string; amountMinor: number;
    actor: string; reason?: string | null; requestId?: string;
    /**
     * Declare the released output VAT in the VAT period covering this date,
     * when the receipt's own period is locked or filed (issue #389). Flagged.
     */
    vatDeclarationDate?: string | null;
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
  if (invoice.status === 'written_off') throw new InvoicingError(`Invoice ${label} was written off; reverse the write-off first.`);
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
  // ---- Cash-basis VAT release (issue #389) ----
  // The tax point is the original receipt date (s.80(1)), never the
  // application date. Computed before anything is written; the writability of
  // the period is checked before that too, so a refusal leaves nothing behind.
  const releasesCashBasisVat = invoiceVatDeferred(db, invoice);
  const vatReleases = releasesCashBasisVat
    ? computeVatReleases(db, [{ invoice, invoiceAllocatedMinor: params.amountMinor }])
    : [];
  const releasesSomething = vatReleases.some((r) => r.netMinor !== 0 || r.vatMinor !== 0);
  const declarationDate = params.vatDeclarationDate?.trim() || null;
  if (releasesSomething) {
    if (declarationDate && !isIsoDate(declarationDate)) {
      throw new InvoicingError('The VAT declaration date must be a date (YYYY-MM-DD).');
    }
    assertVatPeriodWritable(db, params.companyId, asIsoDate(declarationDate ?? payment.paymentDate),
      'The output VAT this receipt released when it arrived');
    // The release journal is dated where the VAT is declared: at the receipt,
    // or — a late declaration — in the named period, so the VAT control account
    // agrees with the return that declares it and a closed receipt year is not
    // written into. Checked before anything is written.
    assertAccountingPeriodOpen(db, params.companyId, declarationDate ?? payment.paymentDate);
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

  let vatReleasedMinor = 0;
  const vatEntryIds: string[] = [];
  let releaseJournalId: string | null = null;

  db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;

    // ---- The VAT the application makes due (cash receipts basis) ----
    // A release journal of its own (the payment's journal is posted and
    // immutable), dated at the original receipt — or, for a late declaration,
    // in the period that declares it, so the control account agrees with that
    // return. The VAT entries keep the receipt as their tax point either way,
    // and carry the payment as their source, so reversing the payment reverses them.
    if (releasesSomething) {
      const vatOnSalesDeferred = systemAccountId(txDb, params.companyId, 'vat_on_sales_deferred');
      const vatOnSales = systemAccountId(txDb, params.companyId, 'vat_on_sales');
      const releasedMinor = vatReleases.reduce((sum, r) => sum + r.vatMinor, 0);
      if (releasedMinor !== 0) {
        const releaseJournal = postJournalEntry(txDb, {
          companyId: params.companyId,
          entryDate: asIsoDate(declarationDate ?? payment.paymentDate),
          narrative: `Output VAT due on money applied from the receipt of ${payment.paymentDate} `
            + `(${invoice.invoiceNumber ?? invoice.id})`,
          sourceType: 'payment',
          sourceId: payment.id,
          baseCurrency: base,
          createdBy: actor,
          createdVia: 'user',
          requestId: params.requestId,
          lines: releasedMinor >= 0
            ? [
              { accountId: vatOnSalesDeferred, debitMinor: Math.abs(releasedMinor), memo: 'VAT now due following application of the receipt (cash receipts basis)' },
              { accountId: vatOnSales, creditMinor: Math.abs(releasedMinor), memo: 'VAT now due following application of the receipt (cash receipts basis)' },
            ]
            : [
              { accountId: vatOnSalesDeferred, creditMinor: Math.abs(releasedMinor), memo: 'VAT now due following application of the receipt (cash receipts basis)' },
              { accountId: vatOnSales, debitMinor: Math.abs(releasedMinor), memo: 'VAT now due following application of the receipt (cash receipts basis)' },
            ],
        });
        releaseJournalId = releaseJournal.id;
      }
      for (const release of vatReleases) {
        if (release.netMinor === 0 && release.vatMinor === 0) continue;
        const created = createVatEntries(txDb, {
          companyId: params.companyId,
          journalEntryId: releaseJournalId!,
          sourceType: 'payment',
          sourceId: payment.id,
          direction: 'sales',
          treatmentId: release.vatTreatmentId,
          rateOverrideId: release.taxRateId ?? undefined,
          invoiceLineId: release.invoiceLineId,
          // The tax point is the day the money arrived (s.80(1)), not the day
          // it was applied. This is the whole point of the basis.
          taxPointDate: asIsoDate(payment.paymentDate),
          // The rate is the one chargeable when the supply was made (s.80(2)(a), #615).
          rateDate: asIsoDate(invoice.supplyDate ?? invoice.invoiceDate),
          declarationDate: declarationDate ? asIsoDate(declarationDate) : undefined,
          netMinor: release.netMinor,
          statedVatMinor: release.vatMinor,
          currency: invoice.currency,
          baseCurrency: base,
          fxRate: invoice.fxRateNumerator && invoice.fxRateDenominator
            ? { numerator: invoice.fxRateNumerator, denominator: invoice.fxRateDenominator }
            : undefined,
          source: 'user',
          provenanceStatus: 'manually_entered',
          notes: `Released by applying money received on ${payment.paymentDate} to invoice ${invoice.id} `
            + `(tax point s.80(1): the receipt date, not the application date)`,
        });
        vatEntryIds.push(...created.entries.map((e) => e.id));
        vatReleasedMinor += created.entries
          .filter((e) => e.direction === 'sales')
          .reduce((sum, e) => sum + e.baseVatMinor, 0);
      }
    }

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
      newValue: JSON.stringify({
        invoiceId: invoice.id, amountMinor: params.amountMinor, onAccountMinor: remaining,
        ...(releasesSomething
          ? { vatReleasedMinor, vatEntryIds, releaseJournalId, taxPointDate: payment.paymentDate }
          : {}),
      }),
      source: 'user', actor,
      reason: params.reason?.trim() || (releasesSomething
        ? 'Money on account applied to a later invoice; its output VAT became due, dated at the receipt (s.80(1))'
        : 'Money on account applied to a later invoice'),
      requestId: params.requestId ?? null,
    }).run();
  });

  if (remaining === 0 && payment.bankTransactionId) {
    resolveReviewItems(db, params.companyId, `bank_transaction:${payment.bankTransactionId}:unallocated`,
      `Money on account applied to invoice ${label}.`);
  }
  if (remaining === 0) {
    resolveReviewItems(db, params.companyId, `payment:${payment.id}:on_account_vat`,
      `All the money held on account from the receipt of ${payment.paymentDate} is now applied or refunded.`);
  }
  return { allocationId, onAccountMinor: remaining, invoiceStatus: status, outstandingMinor, vatReleasedMinor, vatEntryIds };
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

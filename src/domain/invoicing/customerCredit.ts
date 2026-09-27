import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  payments, paymentAllocations, invoices, companies, auditEvents, bankTransactions, bankAccounts,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate, type IsoDate } from '../dates';
import { postJournalEntry, atomically } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { resolveReviewItems } from '../matching/service';
import { InvoicingError } from './invoices';
import { onAccountMinor, paymentsOnAccount, type PaymentOnAccount } from './onAccount';

/**
 * Customer credit (issue #402): what a customer has in hand against us — open
 * credit notes and money on account — and the two ways to use it: apply a
 * credit note to an invoice, or refund money held on account.
 *
 * Applying a credit note moves nothing in the ledger (both documents sit on
 * debtors) and no VAT: on the invoice basis the VAT is already in both, and on
 * the cash receipts basis the credited share of the invoice's deferred VAT and
 * the credit note's own deferred VAT cancel, and later receipts release only
 * the rest. It is recorded as a zero-cash `offset` payment with two
 * allocations, so both documents show what settled them.
 */

type Invoice = typeof invoices.$inferSelect;

function baseCurrencyOf(db: AppDatabase, companyId: string): string {
  const company = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new InvoicingError(`Company ${companyId} not found.`);
  return company.c.toUpperCase();
}

function loadInvoice(db: AppDatabase, companyId: string, invoiceId: string): Invoice {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId))).get();
  if (!invoice) throw new InvoicingError(`Invoice ${invoiceId} not found.`);
  return invoice;
}

/** Apply `amountMinor` of a credit note to an invoice of the same party. */
export function applyCreditNote(
  db: AppDatabase,
  params: {
    companyId: string; creditNoteId: string; invoiceId: string; amountMinor: number;
    date: IsoDate; actor: string; reason?: string | null; requestId?: string;
  },
): { paymentId: string; creditNoteRemainingMinor: number; invoiceOutstandingMinor: number } {
  const actor = params.actor.trim();
  if (!actor) throw new InvoicingError('Say who is applying this credit note.');
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new InvoicingError('The amount to apply is a positive amount in minor units.');
  }
  const base = baseCurrencyOf(db, params.companyId);
  const credit = loadInvoice(db, params.companyId, params.creditNoteId);
  const invoice = loadInvoice(db, params.companyId, params.invoiceId);
  if (!credit.isCreditNote) throw new InvoicingError('The first document must be a credit note.');
  if (invoice.isCreditNote) throw new InvoicingError('A credit note is applied to an invoice, not to another credit note.');
  for (const doc of [credit, invoice]) {
    if (doc.status === 'void' || doc.status === 'written_off') {
      throw new InvoicingError(`${doc.invoiceNumber ?? doc.id} is ${doc.status.replace('_', ' ')}.`);
    }
    if (doc.currency.toUpperCase() !== base) {
      throw new InvoicingError(`${doc.invoiceNumber ?? doc.id} is in ${doc.currency}; credit notes are applied in ${base} only for now.`);
    }
  }
  if (credit.direction !== invoice.direction
    || (credit.customerId ?? null) !== (invoice.customerId ?? null)
    || (credit.supplierId ?? null) !== (invoice.supplierId ?? null)) {
    throw new InvoicingError('The credit note and the invoice belong to different parties, or one is a sale and the other a purchase.');
  }
  const creditRemaining = Math.abs(credit.outstandingMinor);
  if (params.amountMinor > creditRemaining) {
    throw new InvoicingError(`Only ${creditRemaining} of the credit note is left to apply.`);
  }
  if (params.amountMinor > invoice.outstandingMinor) {
    throw new InvoicingError(`The invoice has only ${invoice.outstandingMinor} outstanding.`);
  }

  const paymentId = ids.payment();
  const timestamp = nowIso();
  const status = (gross: number, paid: number) => (gross - paid === 0 ? 'paid' : paid === 0 ? 'issued' : 'part_paid');
  const invoicePaid = invoice.paidMinor + params.amountMinor;
  const creditPaid = credit.paidMinor - params.amountMinor;

  db.transaction((tx) => {
    tx.insert(payments).values({
      id: paymentId, companyId: params.companyId,
      direction: invoice.direction === 'sales' ? 'received' : 'made',
      paymentDate: params.date, amountMinor: 0, currency: base, baseAmountMinor: 0, baseCurrency: base,
      method: 'offset', customerId: invoice.customerId, supplierId: invoice.supplierId,
      reference: `Credit note ${credit.invoiceNumber ?? credit.id} applied to ${invoice.invoiceNumber ?? invoice.id}`,
      notes: params.reason ?? null, source: 'user', provenanceStatus: 'user_confirmed',
    }).run();
    tx.insert(paymentAllocations).values({
      id: ids.allocation(), companyId: params.companyId, paymentId, invoiceId: invoice.id,
      allocatedMinor: params.amountMinor, baseAllocatedMinor: params.amountMinor, currency: base,
    }).run();
    tx.insert(paymentAllocations).values({
      id: ids.allocation(), companyId: params.companyId, paymentId, invoiceId: credit.id,
      allocatedMinor: -params.amountMinor, baseAllocatedMinor: -params.amountMinor, currency: base,
    }).run();
    tx.update(invoices).set({
      paidMinor: invoicePaid, outstandingMinor: invoice.grossMinor - invoicePaid,
      status: status(invoice.grossMinor, invoicePaid), updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    tx.update(invoices).set({
      paidMinor: creditPaid, outstandingMinor: credit.grossMinor - creditPaid,
      status: status(credit.grossMinor, creditPaid), updatedAt: timestamp,
    }).where(eq(invoices.id, credit.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'payment', entityId: paymentId, action: 'created',
      newValue: JSON.stringify({ creditNoteId: credit.id, invoiceId: invoice.id, amountMinor: params.amountMinor }),
      source: 'user', actor, reason: params.reason ?? 'Credit note applied to an invoice', requestId: params.requestId ?? null,
    }).run();
  });
  return {
    paymentId,
    creditNoteRemainingMinor: Math.abs(credit.grossMinor - creditPaid),
    invoiceOutstandingMinor: invoice.grossMinor - invoicePaid,
  };
}

/** Undo an applied credit note: both documents are open again for the amount. */
export function unapplyCreditNote(
  db: AppDatabase, params: { companyId: string; paymentId: string; actor: string; reason: string },
): void {
  const payment = db.select().from(payments)
    .where(and(eq(payments.id, params.paymentId), eq(payments.companyId, params.companyId))).get();
  if (!payment || payment.method !== 'offset') throw new InvoicingError('That is not an applied credit note.');
  if (payment.reversedAt) throw new InvoicingError('This credit note application has already been undone.');
  if (!params.reason.trim()) throw new InvoicingError('Say why the credit note is being unapplied.');
  const timestamp = nowIso();
  db.transaction((tx) => {
    for (const allocation of tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id)).all()) {
      const doc = tx.select().from(invoices).where(eq(invoices.id, allocation.invoiceId)).get()!;
      const paid = doc.paidMinor - allocation.allocatedMinor;
      const outstanding = doc.grossMinor - paid;
      tx.update(invoices).set({
        paidMinor: paid, outstandingMinor: outstanding,
        status: outstanding === 0 ? 'paid' : paid === 0 ? 'issued' : 'part_paid', updatedAt: timestamp,
      }).where(eq(invoices.id, doc.id)).run();
    }
    tx.update(payments).set({ reversedAt: timestamp, reversedBy: params.actor, reversalReason: params.reason, updatedAt: timestamp })
      .where(eq(payments.id, payment.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'payment', entityId: payment.id, action: 'reversal_posted',
      source: 'user', actor: params.actor, reason: params.reason,
    }).run();
  });
}

/**
 * Refund money a payment holds on account. From a statement line (the money
 * leaving or arriving), or on a date from a bank account. Posts the control
 * account against the bank; the original payment's on-account balance falls.
 */
export function refundOnAccount(
  db: AppDatabase,
  params: {
    companyId: string; paymentId: string; amountMinor: number; actor: string; reason: string;
    bankTransactionId?: string | null; date?: IsoDate; bankAccountId?: string | null; requestId?: string;
  },
): { refundPaymentId: string; journalEntryId: string; onAccountMinor: number } {
  return atomically(db, () => {
    const actor = params.actor.trim();
    if (!actor) throw new InvoicingError('Say who is making this refund.');
    if (!params.reason.trim()) throw new InvoicingError('Say why the money is being refunded.');
    if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
      throw new InvoicingError('The refund is a positive amount in minor units.');
    }
    const base = baseCurrencyOf(db, params.companyId);
    const original = db.select().from(payments)
      .where(and(eq(payments.id, params.paymentId), eq(payments.companyId, params.companyId))).get();
    if (!original) throw new InvoicingError(`Payment ${params.paymentId} not found.`);
    if (original.reversedAt) throw new InvoicingError('That payment has been reversed; nothing of it is on account.');
    if (original.currency.toUpperCase() !== base) {
      throw new InvoicingError(`That payment is in ${original.currency}; refunds are in ${base} only for now.`);
    }
    const available = onAccountMinor(db, original);
    if (params.amountMinor > available) throw new InvoicingError(`Only ${available} of that payment is on account.`);

    // A customer's money goes back out; a supplier's comes back in.
    const refundDirection = original.direction === 'received' ? 'made' : 'received';
    let date: IsoDate;
    let bankLedgerId: string;
    let line: typeof bankTransactions.$inferSelect | undefined;
    if (params.bankTransactionId) {
      line = db.select().from(bankTransactions).where(and(
        eq(bankTransactions.id, params.bankTransactionId), eq(bankTransactions.companyId, params.companyId),
      )).get();
      if (!line) throw new InvoicingError(`Bank transaction ${params.bankTransactionId} not found.`);
      if (line.status === 'rolled_back') throw new InvoicingError('That line\'s import was undone.');
      if (line.journalEntryId) throw new InvoicingError('That bank line is already posted.');
      const expectedSign = refundDirection === 'made' ? -1 : 1;
      if (Math.sign(line.amountMinor) !== expectedSign || Math.abs(line.amountMinor) !== params.amountMinor
        || line.currency.toUpperCase() !== base) {
        throw new InvoicingError(`The bank line is ${line.amountMinor} ${line.currency}; this refund is `
          + `${expectedSign * params.amountMinor} ${base}.`);
      }
      date = asIsoDate(line.transactionDate);
      const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, line.bankAccountId)).get();
      bankLedgerId = account?.accountId ?? systemAccountId(db, params.companyId, 'bank_control');
    } else {
      if (!params.date || !params.bankAccountId) {
        throw new InvoicingError('Give the bank line the refund went through, or its date and bank account.');
      }
      const account = db.select().from(bankAccounts).where(and(
        eq(bankAccounts.id, params.bankAccountId), eq(bankAccounts.companyId, params.companyId),
      )).get();
      if (!account) throw new InvoicingError(`Bank account ${params.bankAccountId} not found.`);
      date = params.date;
      bankLedgerId = account.accountId ?? systemAccountId(db, params.companyId, 'bank_control');
    }

    const control = systemAccountId(db, params.companyId, original.direction === 'received' ? 'debtors' : 'creditors');
    const party = { customerId: original.customerId, supplierId: original.supplierId };
    const refundPaymentId = ids.payment();
    const narrative = `Refund of money on account: ${params.reason.trim()}`;
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: date, narrative, sourceType: 'payment', sourceId: refundPaymentId,
      baseCurrency: base, createdBy: actor, createdVia: 'user', requestId: params.requestId,
      lines: refundDirection === 'made'
        ? [{ accountId: control, debitMinor: params.amountMinor, ...party, memo: narrative },
            { accountId: bankLedgerId, creditMinor: params.amountMinor, memo: narrative }]
        : [{ accountId: bankLedgerId, debitMinor: params.amountMinor, memo: narrative },
            { accountId: control, creditMinor: params.amountMinor, ...party, memo: narrative }],
    });

    const timestamp = nowIso();
    db.insert(payments).values({
      id: refundPaymentId, companyId: params.companyId, direction: refundDirection, paymentDate: date,
      amountMinor: params.amountMinor, currency: base, baseAmountMinor: params.amountMinor, baseCurrency: base,
      method: 'bank_transfer', bankTransactionId: line?.id ?? null, ...party, refundOfPaymentId: original.id,
      journalEntryId: journal.id, reference: narrative.slice(0, 60), notes: params.reason,
      source: 'user', provenanceStatus: 'user_confirmed',
    }).run();
    if (line) {
      db.update(bankTransactions).set({
        journalEntryId: journal.id, status: 'posted', source: 'user', provenanceStatus: 'user_confirmed', updatedAt: timestamp,
      }).where(eq(bankTransactions.id, line.id)).run();
    }
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'payment', entityId: refundPaymentId, action: 'created',
      newValue: JSON.stringify({ refundOf: original.id, amountMinor: params.amountMinor, date }),
      source: 'user', actor, reason: params.reason, requestId: params.requestId ?? null,
    }).run();

    const remaining = available - params.amountMinor;
    if (remaining === 0 && original.bankTransactionId) {
      resolveReviewItems(db, params.companyId, `bank_transaction:${original.bankTransactionId}:unallocated`,
        'The money held on account was refunded.');
    }
    return { refundPaymentId, journalEntryId: journal.id, onAccountMinor: remaining };
  });
}

export interface CustomerCredit {
  creditNotes: Array<{ invoiceId: string; number: string | null; date: string; remainingMinor: number }>;
  onAccount: PaymentOnAccount[];
  totalMinor: number;
}

/** What a customer has in hand against us: open credit notes and money on account (base currency). */
export function customerCredit(db: AppDatabase, params: { companyId: string; customerId: string }): CustomerCredit {
  const base = baseCurrencyOf(db, params.companyId);
  const creditNotes = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId), eq(invoices.customerId, params.customerId),
    eq(invoices.direction, 'sales'), eq(invoices.isCreditNote, true),
    ne(invoices.status, 'void'), ne(invoices.outstandingMinor, 0), isNull(invoices.voidedAt),
  )).orderBy(invoices.invoiceDate).all()
    .filter((c) => c.currency.toUpperCase() === base)
    .map((c) => ({ invoiceId: c.id, number: c.invoiceNumber, date: c.invoiceDate, remainingMinor: Math.abs(c.outstandingMinor) }));
  const onAccount = paymentsOnAccount(db, { companyId: params.companyId, customerId: params.customerId })
    .filter((p) => p.direction === 'received');
  return {
    creditNotes, onAccount,
    totalMinor: creditNotes.reduce((s, c) => s + c.remainingMinor, 0) + onAccount.reduce((s, p) => s + p.onAccountMinor, 0),
  };
}

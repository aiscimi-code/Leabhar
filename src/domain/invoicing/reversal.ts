import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  payments, paymentAllocations, invoices, vatEntries, bankTransactions, auditEvents, reviewItems,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { reverseJournalEntry, atomically } from '../accounting/journal';
import { findVatPeriod, assertVatPeriodWritable } from '../vat/engine';
import { InvoicingError } from './invoices';

/**
 * Reverse a payment (issue #220).
 *
 * A payment settled against the wrong invoice, or for the wrong amounts, is
 * corrected by reversing it and settling again. Nothing is deleted or edited
 * in place (AGENTS.md #2): the payment's journal is reversed by a new entry,
 * any output VAT it released on the cash receipts basis is reversed by
 * negative VAT entries, the invoices it settled are open again for exactly
 * what it allocated, and the bank line it came from is unposted so it can be
 * settled correctly. The payment and its allocations stay on file, marked
 * reversed, with who, when and why.
 *
 * A reversal that would land in a locked or submitted VAT period, or a closed
 * accounting period, is refused before anything is written: a filed return is
 * never changed by a correction. Choose a later reversal date instead.
 */

export interface ReversePaymentInput {
  companyId: string;
  paymentId: string;
  reason: string;
  /** Defaults to the payment's own date, so a correction in an open period nets to nothing there. */
  reversalDate?: IsoDate;
  actor?: string;
  requestId?: string;
}

export interface ReversedPayment {
  paymentId: string;
  reversalJournalEntryId: string;
  reversedVatEntryIds: string[];
  invoiceStatuses: Array<{ invoiceId: string; status: string; outstandingMinor: number }>;
  bankTransactionId: string | null;
}

export function reversePayment(
  db: AppDatabase, input: Parameters<typeof reversePaymentSteps>[1],
): ReturnType<typeof reversePaymentSteps> {
  return atomically(db, () => reversePaymentSteps(db, input));
}

function reversePaymentSteps(db: AppDatabase, input: ReversePaymentInput): ReversedPayment {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new InvoicingError('Reversing a payment needs a reason.');
  }
  const payment = db.select().from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.companyId, input.companyId))).get();
  if (!payment) throw new InvoicingError(`Payment ${input.paymentId} not found.`);
  if (payment.reversedAt) {
    throw new InvoicingError('This payment has already been reversed.', { paymentId: payment.id });
  }
  if (!payment.journalEntryId) {
    throw new InvoicingError('This payment has no journal entry to reverse.', { paymentId: payment.id });
  }

  const bankTransaction = payment.bankTransactionId
    ? db.select().from(bankTransactions).where(eq(bankTransactions.id, payment.bankTransactionId)).get()
    : undefined;
  if (bankTransaction?.reconciliationId) {
    throw new InvoicingError(
      'The bank line this payment came from is part of a completed bank reconciliation. Reversing the '
        + 'payment would change the ledger balance that reconciliation agreed. Undo the reconciliation first.',
      { bankTransactionId: bankTransaction.id },
    );
  }

  const reversalDate = input.reversalDate ?? asIsoDate(payment.paymentDate);
  const released = db.select().from(vatEntries)
    .where(and(eq(vatEntries.sourceType, 'payment'), eq(vatEntries.sourceId, payment.id))).all();

  // ---- Refuse before writing anything ----
  // The reversing VAT lands in the period of the reversal date: never a locked
  // or filed one (issue #226).
  const vatPeriod = released.length > 0
    ? assertVatPeriodWritable(db, input.companyId, reversalDate, 'Reversing the output VAT this payment released')
    : findVatPeriod(db, input.companyId, reversalDate);

  const allocations = db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id)).all();
  const targets = allocations.map((allocation) => {
    const invoice = db.select().from(invoices).where(eq(invoices.id, allocation.invoiceId)).get()!;
    if (invoice.status === 'void') {
      throw new InvoicingError(`Invoice ${invoice.invoiceNumber ?? invoice.id} has been voided since this payment.`);
    }
    return { allocation, invoice };
  });

  // Reversing the journal refuses a closed or locked accounting period itself.
  const reversal = reverseJournalEntry(db, {
    companyId: input.companyId,
    entryId: payment.journalEntryId,
    reversalDate,
    reason: input.reason,
    createdBy: input.actor ?? 'user',
    requestId: input.requestId,
  });

  const timestamp = nowIso();
  const reversedVatEntryIds: string[] = [];
  const invoiceStatuses: ReversedPayment['invoiceStatuses'] = [];

  db.transaction((tx) => {
    // ---- Output VAT released by this payment (cash receipts basis) ----
    for (const entry of released) {
      const id = ids.vatEntry();
      tx.insert(vatEntries).values({
        ...entry,
        id,
        journalEntryId: reversal.id,
        netMinor: -entry.netMinor,
        vatMinor: -entry.vatMinor,
        grossMinor: -entry.grossMinor,
        baseNetMinor: -entry.baseNetMinor,
        baseVatMinor: -entry.baseVatMinor,
        baseGrossMinor: -entry.baseGrossMinor,
        recoverableVatMinor: -entry.recoverableVatMinor,
        baseRecoverableVatMinor: -entry.baseRecoverableVatMinor,
        taxPointDate: reversalDate,
        vatPeriodId: vatPeriod?.id ?? null,
        pairedEntryId: null,
        notes: `Reversal of the VAT released by payment ${payment.id}: ${input.reason}`,
        source: 'user',
        provenanceStatus: 'user_confirmed',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      reversedVatEntryIds.push(id);
    }

    // ---- The invoices are open again for exactly what this payment allocated ----
    for (const { allocation, invoice } of targets) {
      const paidMinor = invoice.paidMinor - allocation.allocatedMinor;
      const outstandingMinor = invoice.grossMinor - paidMinor;
      const status = outstandingMinor === 0 ? 'paid' : paidMinor === 0 ? 'issued' : 'part_paid';
      tx.update(invoices).set({ paidMinor, outstandingMinor, status, updatedAt: timestamp })
        .where(eq(invoices.id, invoice.id)).run();
      invoiceStatuses.push({ invoiceId: invoice.id, status, outstandingMinor });
    }

    tx.update(payments).set({
      reversedAt: timestamp, reversedBy: input.actor ?? 'user', reversalReason: input.reason,
      reversalJournalEntryId: reversal.id, updatedAt: timestamp,
    }).where(eq(payments.id, payment.id)).run();

    if (bankTransaction) {
      // The bank line is still evidence that money moved; it is unposted so it
      // can be settled again, correctly.
      tx.update(bankTransactions).set({ journalEntryId: null, status: 'unclassified', updatedAt: timestamp })
        .where(eq(bankTransactions.id, bankTransaction.id)).run();
      tx.update(reviewItems).set({
        status: 'resolved', resolvedAt: timestamp, resolvedBy: input.actor ?? 'user',
        resolution: 'The payment was reversed.', updatedAt: timestamp,
      }).where(and(
        eq(reviewItems.companyId, input.companyId),
        eq(reviewItems.dedupeKey, `bank_transaction:${bankTransaction.id}:unallocated`),
        eq(reviewItems.status, 'open'),
      )).run();
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
        entityType: 'bank_transaction', entityId: bankTransaction.id, action: 'updated', field: 'status',
        previousValue: JSON.stringify(bankTransaction.status), newValue: JSON.stringify('unclassified'),
        source: 'user', actor: input.actor ?? 'user',
        reason: `Payment ${payment.id} reversed: ${input.reason}`, requestId: input.requestId ?? null,
      }).run();
    }

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'payment', entityId: payment.id, action: 'reversal_posted',
      newValue: JSON.stringify({
        reversalJournalEntryId: reversal.id, reversalDate,
        reversedVatEntries: reversedVatEntryIds.length, invoices: invoiceStatuses,
      }),
      source: 'user', actor: input.actor ?? 'user', reason: input.reason, requestId: input.requestId ?? null,
    }).run();
  });

  return {
    paymentId: payment.id, reversalJournalEntryId: reversal.id, reversedVatEntryIds, invoiceStatuses,
    bankTransactionId: bankTransaction?.id ?? null,
  };
}

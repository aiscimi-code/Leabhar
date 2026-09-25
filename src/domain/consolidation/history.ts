import { and, eq, inArray, or } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { auditEvents, documents, paymentAllocations, payments, invoices } from '@/db/schema';

/**
 * Everything that happened to a bank line, in order (issue #224): its own
 * audit events, the settlement that posted it (and any reversal), and the
 * match decisions for documents against it. Each is labelled with what it
 * concerns, so a person reading the bank line sees who settled it, when and
 * against what — read from the audit trail as recorded, never reconstructed.
 */

export interface TransactionHistoryEvent {
  id: string;
  occurredAt: string;
  action: string;
  actor: string;
  reason: string | null;
  entity: 'bank_transaction' | 'payment' | 'document';
  /** What the event concerns, e.g. "Payment: settled INV MOS-5120". */
  subject: string;
  /** A link to what the event concerns, when it has its own screen. */
  href: string | null;
}

const MATCH_ACTIONS = ['document_matched', 'document_unmatched', 'user_rejected'] as const;

export function transactionHistory(
  db: AppDatabase, input: { companyId: string; bankTransactionId: string },
): TransactionHistoryEvent[] {
  const { companyId, bankTransactionId } = input;
  const events: TransactionHistoryEvent[] = [];

  for (const e of db.select().from(auditEvents).where(and(
    eq(auditEvents.companyId, companyId), eq(auditEvents.entityType, 'bank_transaction'),
    eq(auditEvents.entityId, bankTransactionId),
  )).all()) {
    events.push({
      id: e.id, occurredAt: e.occurredAt, action: e.action, actor: e.actor, reason: e.reason,
      entity: 'bank_transaction', subject: 'This bank line', href: null,
    });
  }

  // The payments this bank line made or received, reversed ones included.
  const linked = db.select().from(payments)
    .where(and(eq(payments.companyId, companyId), eq(payments.bankTransactionId, bankTransactionId))).all();
  if (linked.length > 0) {
    const settled = new Map<string, Array<{ id: string; label: string }>>();
    for (const row of db.select({ paymentId: paymentAllocations.paymentId, invoiceId: invoices.id, number: invoices.invoiceNumber })
      .from(paymentAllocations).innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
      .where(inArray(paymentAllocations.paymentId, linked.map((p) => p.id))).all()) {
      const list = settled.get(row.paymentId) ?? [];
      list.push({ id: row.invoiceId, label: row.number ?? 'an invoice without a number' });
      settled.set(row.paymentId, list);
    }
    for (const e of db.select().from(auditEvents).where(and(
      eq(auditEvents.companyId, companyId), eq(auditEvents.entityType, 'payment'),
      inArray(auditEvents.entityId, linked.map((p) => p.id)),
    )).all()) {
      const invoicesSettled = settled.get(e.entityId) ?? [];
      const what = invoicesSettled.length > 0
        ? `${e.action === 'reversal_posted' ? 'reversed settlement of' : 'settled'} ${invoicesSettled.map((i) => i.label).join(', ')}`
        : 'held on account';
      events.push({
        id: e.id, occurredAt: e.occurredAt, action: e.action, actor: e.actor, reason: e.reason,
        entity: 'payment', subject: `Payment: ${what}`,
        href: invoicesSettled.length === 1 ? `/invoices/${invoicesSettled[0]!.id}` : null,
      });
    }
  }

  // Match decisions record the bank line as the value that changed.
  const matchEvents = db.select({ event: auditEvents, filename: documents.originalFilename })
    .from(auditEvents).innerJoin(documents, eq(auditEvents.entityId, documents.id))
    .where(and(
      eq(auditEvents.companyId, companyId), eq(auditEvents.entityType, 'document'),
      inArray(auditEvents.action, [...MATCH_ACTIONS]),
      or(eq(auditEvents.newValue, bankTransactionId), eq(auditEvents.previousValue, bankTransactionId)),
    )).all();
  for (const { event: e, filename } of matchEvents) {
    events.push({
      id: e.id, occurredAt: e.occurredAt, action: e.action, actor: e.actor, reason: e.reason,
      entity: 'document', subject: `Document: ${filename}`, href: `/documents/${e.entityId}`,
    });
  }

  // Newest first, as the screen lists them; ties keep the order they were written in.
  return events.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, payments, paymentAllocations, invoices, invoiceLines, documents, documentLines,
  vatEntries, vatPeriods, vatTreatments, irishTaxRules, reviewItems,
} from '@/db/schema';

/**
 * The full trace behind a bank line's VAT (issue #203): bank line → payment →
 * invoices → confirmed document → each line and the rules behind its
 * treatment → the VAT entries it produced → VAT3 box and period.
 *
 * Read-only and computed from what is stored, so the screen shows exactly
 * what was posted — never a recomputation.
 */

export interface TraceVatEntry {
  id: string;
  direction: 'sales' | 'purchases';
  netMinor: number;
  vatMinor: number;
  recoverableVatMinor: number;
  rateBasisPoints: number;
  vatBox: string | null;
  netBox: string | null;
  taxPointDate: string;
  periodName: string | null;
  currency: string;
  /** How the entry arose: on the invoice, or released by this payment (cash basis). */
  arose: 'invoice' | 'payment';
}

export interface TraceLine {
  lineNumber: number;
  description: string;
  netMinor: number;
  vatMinor: number;
  treatment: { code: string; name: string } | null;
  accountId: string | null;
  documentLine: { lineNumber: number; description: string; netMinor: number | null; vatMinor: number | null } | null;
  rules: Array<{ ruleKey: string; name: string; provisionId: string }>;
  vatEntries: TraceVatEntry[];
}

export interface TraceInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  direction: 'sales' | 'purchase';
  isCreditNote: boolean;
  grossMinor: number;
  currency: string;
  allocatedMinor: number;
  document: { id: string; filename: string; sha256: string; reviewedBy: string | null } | null;
  lines: TraceLine[];
}

export interface TransactionTrace {
  kind: 'settled' | 'classified_without_invoice' | 'unposted';
  payment: { id: string; amountMinor: number; currency: string; unallocatedMinor: number } | null;
  invoices: TraceInvoice[];
  /** VAT entries posted directly on the bank line (a classified receipt, say). */
  directVatEntries: TraceVatEntry[];
  /** Open review items about this bank line (no invoice, money on account…). */
  flags: string[];
}

export function transactionTrace(db: AppDatabase, params: { companyId: string; bankTransactionId: string }): TransactionTrace | null {
  const tx = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.id, params.bankTransactionId), eq(bankTransactions.companyId, params.companyId))).get();
  if (!tx) return null;

  const periodName = new Map(db.select({ id: vatPeriods.id, name: vatPeriods.name }).from(vatPeriods)
    .where(eq(vatPeriods.companyId, params.companyId)).all().map((p) => [p.id, p.name]));
  const toEntry = (e: typeof vatEntries.$inferSelect, arose: TraceVatEntry['arose']): TraceVatEntry => ({
    id: e.id, direction: e.direction, netMinor: e.netMinor, vatMinor: e.vatMinor,
    recoverableVatMinor: e.recoverableVatMinor, rateBasisPoints: e.rateBasisPoints,
    vatBox: e.vatBox, netBox: e.netBox, taxPointDate: e.taxPointDate,
    periodName: e.vatPeriodId ? periodName.get(e.vatPeriodId) ?? null : null, currency: e.currency, arose,
  });
  const live = (rows: Array<typeof vatEntries.$inferSelect>) => rows;

  const flags = db.select({ title: reviewItems.title }).from(reviewItems)
    .where(and(
      eq(reviewItems.companyId, params.companyId), eq(reviewItems.entityType, 'bank_transaction'),
      eq(reviewItems.entityId, tx.id), eq(reviewItems.status, 'open'),
    )).all().map((r) => r.title);

  const payment = db.select().from(payments).where(eq(payments.bankTransactionId, tx.id)).get();
  const directVatEntries = live(db.select().from(vatEntries)
    .where(and(eq(vatEntries.sourceType, 'bank_transaction'), eq(vatEntries.sourceId, tx.id))).all())
    .map((e) => toEntry(e, 'invoice'));

  if (!payment) {
    return {
      kind: tx.journalEntryId ? 'classified_without_invoice' : 'unposted',
      payment: null, invoices: [], directVatEntries, flags,
    };
  }

  const allocations = db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id)).all();
  const released = live(db.select().from(vatEntries)
    .where(and(eq(vatEntries.sourceType, 'payment'), eq(vatEntries.sourceId, payment.id))).all());

  const traceInvoices: TraceInvoice[] = allocations.map((allocation) => {
    const invoice = db.select().from(invoices).where(eq(invoices.id, allocation.invoiceId)).get()!;
    const doc = invoice.documentId ? db.select().from(documents).where(eq(documents.id, invoice.documentId)).get() : undefined;
    const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.lineNumber).all();
    const onInvoice = live(db.select().from(vatEntries).where(eq(vatEntries.sourceId, invoice.id)).all());
    const docLines = new Map(doc
      ? db.select().from(documentLines).where(eq(documentLines.documentId, doc.id)).all().map((l) => [l.id, l])
      : []);
    const ruleKeys = [...new Set(lines.flatMap((l) => l.vatRuleKeys))];
    const rules = new Map(ruleKeys.length
      ? db.select({ ruleKey: irishTaxRules.ruleKey, name: irishTaxRules.name, provisionId: irishTaxRules.provisionId })
        .from(irishTaxRules).where(and(eq(irishTaxRules.companyId, params.companyId), inArray(irishTaxRules.ruleKey, ruleKeys)))
        .all().map((r) => [r.ruleKey, r])
      : []);

    return {
      invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate,
      direction: invoice.direction, isCreditNote: invoice.isCreditNote, grossMinor: invoice.grossMinor,
      currency: invoice.currency, allocatedMinor: allocation.allocatedMinor,
      document: doc ? { id: doc.id, filename: doc.originalFilename, sha256: doc.sha256, reviewedBy: doc.reviewedBy } : null,
      lines: lines.map((l) => {
        const treatment = l.vatTreatmentId
          ? db.select({ code: vatTreatments.code, name: vatTreatments.name }).from(vatTreatments)
            .where(eq(vatTreatments.id, l.vatTreatmentId)).get() ?? null
          : null;
        const dl = l.documentLineId ? docLines.get(l.documentLineId) : undefined;
        return {
          lineNumber: l.lineNumber, description: l.description, netMinor: l.netMinor, vatMinor: l.vatMinor,
          treatment, accountId: l.accountId,
          documentLine: dl ? { lineNumber: dl.lineNumber, description: dl.description, netMinor: dl.netMinor, vatMinor: dl.vatMinor } : null,
          rules: l.vatRuleKeys.map((k) => rules.get(k)).filter((r): r is NonNullable<typeof r> => !!r),
          vatEntries: [
            ...onInvoice.filter((e) => e.invoiceLineId === l.id).map((e) => toEntry(e, 'invoice' as const)),
            // Cash-basis releases are per invoice treatment, not per line: shown on the
            // lines whose treatment they release.
            ...released.filter((e) => e.vatTreatmentId === l.vatTreatmentId && e.notes?.includes(invoice.id))
              .map((e) => toEntry(e, 'payment' as const)),
          ],
        };
      }),
    };
  });

  return {
    kind: 'settled',
    payment: {
      id: payment.id, amountMinor: payment.amountMinor, currency: payment.currency,
      unallocatedMinor: payment.amountMinor - allocations.reduce((s, a) => s + Math.abs(a.allocatedMinor), 0),
    },
    invoices: traceInvoices, directVatEntries, flags,
  };
}

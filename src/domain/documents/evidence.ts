import { and, eq, isNull, or } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  documents, documentMatches, invoices, journalEntries, vatEntries, vatPeriods,
  payments, paymentAllocations, bankTransactions,
} from '@/db/schema';
import type { IsoDate } from '../dates';
import type { DocumentType } from './types';

/**
 * The evidence chain behind one document (issue #431) — the document-centric
 * half of `consolidation/trace.ts`, which walks the same chain from the bank
 * line. Read-only and assembled from stored rows only: nothing here
 * recomputes a figure, so what the panel shows is exactly what was posted.
 *
 * document -> the invoice posted from it -> its journal entry and VAT entries
 *           -> the payments that settled it -> the bank lines behind those
 * payments -> the matches considered along the way -> the duplicates pointing
 * at it and the document it duplicates.
 */
export interface EvidenceBankTransaction {
  id: string;
  transactionDate: string;
  description: string;
  amountMinor: number;
  currency: string;
}

export interface EvidenceVatEntry {
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
}

export interface EvidencePayment {
  paymentId: string;
  paymentDate: string;
  amountMinor: number;
  currency: string;
  allocatedMinor: number;
  bankTransaction: EvidenceBankTransaction | null;
  reversedAt: string | null;
}

export interface EvidenceInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  direction: 'sales' | 'purchase';
  isCreditNote: boolean;
  status: string;
  grossMinor: number;
  currency: string;
  journalEntry: { id: string; entryNumber: number; entryDate: string; narrative: string } | null;
  vatEntries: EvidenceVatEntry[];
  payments: EvidencePayment[];
}

export interface EvidenceMatch {
  matchId: string;
  matchType: string;
  score: number;
  decision: string;
  bankTransaction: EvidenceBankTransaction | null;
}

export interface DocumentEvidence {
  document: {
    id: string;
    filename: string;
    sha256: string;
    documentType: DocumentType;
    documentDate: string | null;
  };
  /** The byte-identical document already on file, if this one is flagged as its duplicate. */
  duplicateOf: { id: string; filename: string } | null;
  /** Documents flagged as duplicates of this one. */
  duplicates: Array<{ id: string; filename: string; uploadedAt: string }>;
  /** The bank transaction the document is linked to, if any. */
  linkedTransaction: EvidenceBankTransaction | null;
  matches: EvidenceMatch[];
  invoice: EvidenceInvoice | null;
}

export function documentEvidence(
  db: AppDatabase,
  params: { companyId: string; documentId: string },
): DocumentEvidence | null {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!doc) return null;

  const duplicateOf = doc.isDuplicateOf
    ? db.select({ id: documents.id, filename: documents.originalFilename }).from(documents)
      .where(eq(documents.id, doc.isDuplicateOf)).get() ?? null
    : null;
  const duplicates = db.select({ id: documents.id, filename: documents.originalFilename, uploadedAt: documents.uploadedAt })
    .from(documents).where(eq(documents.isDuplicateOf, doc.id)).all();

  const toBankTransaction = (txId: string | null): EvidenceBankTransaction | null => {
    if (!txId) return null;
    const tx = db.select().from(bankTransactions).where(eq(bankTransactions.id, txId)).get();
    return tx ? {
      id: tx.id, transactionDate: tx.transactionDate, description: tx.description,
      amountMinor: tx.amountMinor, currency: tx.currency,
    } : null;
  };

  const matches = db.select().from(documentMatches)
    .where(eq(documentMatches.documentId, doc.id)).all()
    .map((m) => ({
      matchId: m.id, matchType: m.matchType, score: m.score, decision: m.decision,
      bankTransaction: toBankTransaction(m.bankTransactionId),
    }));

  const periodName = new Map(db.select({ id: vatPeriods.id, name: vatPeriods.name })
    .from(vatPeriods).where(eq(vatPeriods.companyId, params.companyId)).all()
    .map((p) => [p.id, p.name]));
  const toVatEntry = (e: typeof vatEntries.$inferSelect): EvidenceVatEntry => ({
    id: e.id, direction: e.direction, netMinor: e.netMinor, vatMinor: e.vatMinor,
    recoverableVatMinor: e.recoverableVatMinor, rateBasisPoints: e.rateBasisPoints,
    vatBox: e.vatBox, netBox: e.netBox, taxPointDate: e.taxPointDate,
    periodName: e.vatPeriodId ? periodName.get(e.vatPeriodId) ?? null : null,
  });

  let invoice: EvidenceInvoice | null = null;
  const invoiceRow = db.select().from(invoices)
    .where(and(eq(invoices.documentId, doc.id), eq(invoices.companyId, params.companyId))).get()
    ?? (doc.invoiceId
      ? db.select().from(invoices).where(eq(invoices.id, doc.invoiceId)).get()
      : undefined);

  if (invoiceRow) {
    const journal = invoiceRow.journalEntryId
      ? db.select().from(journalEntries).where(eq(journalEntries.id, invoiceRow.journalEntryId)).get()
      : undefined;
    const entries = db.select().from(vatEntries)
      .where(and(
        eq(vatEntries.companyId, params.companyId),
        or(
          and(eq(vatEntries.sourceType, 'sales_invoice'), eq(vatEntries.sourceId, invoiceRow.id)),
          and(eq(vatEntries.sourceType, 'purchase_invoice'), eq(vatEntries.sourceId, invoiceRow.id)),
        ),
      )).all().map(toVatEntry);
    const paymentRows = db.select().from(payments)
      .where(and(eq(payments.companyId, params.companyId), isNull(payments.reversedAt))).all();
    const allocations = db.select().from(paymentAllocations)
      .where(eq(paymentAllocations.invoiceId, invoiceRow.id)).all();
    const paymentById = new Map(paymentRows.map((p) => [p.id, p]));

    invoice = {
      invoiceId: invoiceRow.id,
      invoiceNumber: invoiceRow.invoiceNumber,
      invoiceDate: invoiceRow.invoiceDate,
      direction: invoiceRow.direction,
      isCreditNote: invoiceRow.isCreditNote,
      status: invoiceRow.status,
      grossMinor: invoiceRow.grossMinor,
      currency: invoiceRow.currency,
      journalEntry: journal ? {
        id: journal.id, entryNumber: journal.entryNumber, entryDate: journal.entryDate,
        narrative: journal.narrative,
      } : null,
      vatEntries: entries,
      payments: allocations
        .map((a) => {
          const p = paymentById.get(a.paymentId);
          return p ? {
            paymentId: p.id, paymentDate: p.paymentDate, amountMinor: p.amountMinor,
            currency: p.currency, allocatedMinor: Math.abs(a.allocatedMinor),
            bankTransaction: toBankTransaction(p.bankTransactionId), reversedAt: p.reversedAt,
          } : null;
        })
        .filter((p): p is EvidencePayment => p !== null),
    };
  }

  return {
    document: {
      id: doc.id, filename: doc.originalFilename, sha256: doc.sha256,
      documentType: doc.documentType, documentDate: doc.documentDate,
    },
    duplicateOf,
    duplicates,
    linkedTransaction: toBankTransaction(doc.matchedTransactionId),
    matches,
    invoice,
  };
}

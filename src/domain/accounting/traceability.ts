/**
 * Source-to-ledger traceability (docs/trust TRUST_MODEL.md, Work Package 05).
 *
 * This module provides the functions to trace a journal line backward to its
 * source document and forward from a source document to its ledger impact.
 *
 * The chain exists structurally in the schema:
 *   statementImports → bankTransactions → journalEntries → journalLines
 *   journalEntries.sourceType/sourceId → source transaction or invoice
 *
 * These functions make that chain queryable and testable.
 */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  journalEntries, journalLines, bankTransactions, statementImports,
  accounts, auditEvents,
} from '@/db/schema';

export interface TraceabilityPath {
  journalLine: {
    id: string;
    entryId: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    debitMinor: number | null;
    creditMinor: number | null;
  };
  journalEntry: {
    id: string;
    entryNumber: number;
    entryDate: string;
    narrative: string;
    sourceType: string;
    sourceId: string | null;
    createdVia: string;
    provenanceStatus: string;
    source: string;
  };
  sourceTransaction?: {
    id: string;
    description: string;
    amountMinor: number;
    currency: string;
    transactionDate: string;
    bankReference: string | null;
  };
  auditTrail: Array<{
    action: string;
    occurredAt: string;
    actor: string | null;
    newValue: string | null;
  }>;
}

/**
 * Trace backward: from a journal line, find the source transaction and
 * import that produced it. This is the "ledger → journal → transaction → document"
 * direction of the traceability chain.
 */
export function traceJournalLine(
  db: AppDatabase,
  companyId: string,
  journalLineId: string,
): TraceabilityPath | null {
  // --- Step 1: Journal line ---
  const line = db
    .select()
    .from(journalLines)
    .where(eq(journalLines.id, journalLineId))
    .get();
  if (!line) return null;

  // --- Step 2: Account for the line ---
  const account = db
    .select({ code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, line.accountId))
    .get();

  // --- Step 3: Journal entry ---
  const entry = db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, line.journalEntryId))
    .get();
  if (!entry) return null;

  // --- Step 4: Source transaction (if entry references one) ---
  let sourceTransaction: TraceabilityPath['sourceTransaction'] | undefined;
  if (entry.sourceType === 'bank_transaction' && entry.sourceId) {
    const tx = db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, entry.sourceId))
      .get();
    if (tx) {
      sourceTransaction = {
        id: tx.id,
        description: tx.description,
        amountMinor: tx.amountMinor,
        currency: tx.currency,
        transactionDate: tx.transactionDate,
        bankReference: tx.bankReference,
      };
    }
  }

  // --- Step 5: Audit trail ---
  const auditTrail = db
    .select({
      action: auditEvents.action,
      occurredAt: auditEvents.occurredAt,
      actor: auditEvents.actor,
      newValue: auditEvents.newValue,
    })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entry.id))
    .all();

  return {
    journalLine: {
      id: line.id,
      entryId: line.journalEntryId,
      accountId: line.accountId,
      accountCode: account?.code ?? '',
      accountName: account?.name ?? '',
      debitMinor: line.baseDebitMinor,
      creditMinor: line.baseCreditMinor,
    },
    journalEntry: {
      id: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      narrative: entry.narrative,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      createdVia: entry.createdVia,
      provenanceStatus: entry.provenanceStatus,
      source: entry.source,
    },
    sourceTransaction,
    auditTrail,
  };
}

/**
 * Trace forward: from a bank transaction id, find all journal entries and
 * journal lines it produced. This is the "document → transaction → journal → ledger"
 * direction of the traceability chain.
 */
export function traceBankTransaction(
  db: AppDatabase,
  companyId: string,
  bankTransactionId: string,
): {
  bankTransaction: { id: string; description: string; amountMinor: number; currency: string; transactionDate: string };
  journalEntries: Array<{
    entryNumber: number;
    entryDate: string;
    narrative: string;
    lines: Array<{ accountCode: string; accountName: string; debitMinor: number | null; creditMinor: number | null }>;
  }>;
} | null {
  const tx = db
    .select({
      id: bankTransactions.id,
      description: bankTransactions.description,
      amountMinor: bankTransactions.amountMinor,
      currency: bankTransactions.currency,
      transactionDate: bankTransactions.transactionDate,
    })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId))
    .get();
  if (!tx) return null;

  // Find journal entries sourced from this bank transaction.
  const entries = db
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      narrative: journalEntries.narrative,
    })
    .from(journalEntries)
    .where(eq(journalEntries.sourceId, bankTransactionId))
    .all();

  const journalEntriesResult = entries.map((entry) => {
    const lines = db
      .select({
        lineId: journalLines.id,
        accountId: journalLines.accountId,
        debitMinor: journalLines.baseDebitMinor,
        creditMinor: journalLines.baseCreditMinor,
      })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .all();

    const enrichedLines = lines.map((l) => {
      const account = db
        .select({ code: accounts.code, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, l.accountId))
        .get();
      return {
        accountCode: account?.code ?? '',
        accountName: account?.name ?? '',
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
      };
    });

    return {
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      narrative: entry.narrative,
      lines: enrichedLines,
    };
  });

  return {
    bankTransaction: tx,
    journalEntries: journalEntriesResult,
  };
}

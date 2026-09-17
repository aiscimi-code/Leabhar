import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { documentMatches, documents, bankTransactions } from '@/db/schema';
import {
  matchAllUnmatched, acceptMatch, linkDocument, rejectMatch, unmatchDocument,
} from '@/domain/matching/service';

export { matchAllUnmatched, acceptMatch, linkDocument, rejectMatch, unmatchDocument };

/**
 * Agent wrappers for the document↔bank matching domain functions.
 *
 * Matching links evidence to a bank transaction. It does NOT classify or post
 * the transaction — a matched document is still an unposted bank line until it
 * is classified (via `auto-classify` or the UI). The agent workflow is:
 * match → then classify → then reconcile.
 */

export interface MatchSummary {
  processed: number;
  autoMatched: number;
  needingReview: number;
}

export function runMatch(
  db: AppDatabase, params: { companyId: string; actor?: string },
): MatchSummary {
  return matchAllUnmatched(db, { companyId: params.companyId, actor: params.actor ?? 'cli' });
}

export interface MatchCandidateRow {
  matchId: string;
  documentId: string;
  documentFilename: string | null;
  bankTransactionId: string | null;
  transactionDescription: string | null;
  transactionDate: string | null;
  amountMinor: number | null;
  currency: string | null;
  matchType: string;
  score: number;
  decision: string;
}

export function listMatches(
  db: AppDatabase, params: { companyId: string; decision?: string },
): MatchCandidateRow[] {
  const conditions = [eq(documentMatches.companyId, params.companyId)];
  if (params.decision) {
    conditions.push(eq(documentMatches.decision, params.decision as 'pending'));
  }
  return db.select({
    matchId: documentMatches.id,
    documentId: documentMatches.documentId,
    documentFilename: documents.originalFilename,
    bankTransactionId: documentMatches.bankTransactionId,
    transactionDescription: bankTransactions.description,
    transactionDate: bankTransactions.transactionDate,
    amountMinor: bankTransactions.amountMinor,
    currency: bankTransactions.currency,
    matchType: documentMatches.matchType,
    score: documentMatches.score,
    decision: documentMatches.decision,
  })
    .from(documentMatches)
    .leftJoin(documents, eq(documentMatches.documentId, documents.id))
    .leftJoin(bankTransactions, eq(documentMatches.bankTransactionId, bankTransactions.id))
    .where(and(...conditions))
    .orderBy(desc(documentMatches.score)).all();
}

export function acceptMatchCandidate(
  db: AppDatabase,
  params: { companyId: string; documentId: string; bankTransactionId: string; reason?: string },
): void {
  acceptMatch(db, {
    companyId: params.companyId,
    documentId: params.documentId,
    bankTransactionId: params.bankTransactionId,
    actor: 'cli',
    reason: params.reason,
  });
}

export function linkDocumentToTransaction(
  db: AppDatabase,
  params: { companyId: string; documentId: string; bankTransactionId: string; reason?: string },
): void {
  linkDocument(db, {
    companyId: params.companyId,
    documentId: params.documentId,
    bankTransactionId: params.bankTransactionId,
    actor: 'cli',
    reason: params.reason,
  });
}

export function rejectMatchCandidate(
  db: AppDatabase,
  params: { companyId: string; documentId: string; bankTransactionId: string; reason?: string },
): void {
  rejectMatch(db, {
    companyId: params.companyId,
    documentId: params.documentId,
    bankTransactionId: params.bankTransactionId,
    actor: 'cli',
    reason: params.reason,
  });
}

export function unmatchDocumentLink(
  db: AppDatabase,
  params: { companyId: string; documentId: string; reason: string },
): void {
  unmatchDocument(db, {
    companyId: params.companyId,
    documentId: params.documentId,
    actor: 'cli',
    reason: params.reason,
  });
}

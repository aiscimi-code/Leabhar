import { and, eq, gte, lte, ne, isNull, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  documents, bankTransactions, documentMatches, suppliers, auditEvents, reviewItems,
  payments, paymentAllocations,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, addDays, asIsoDate } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { assertDocumentConfirmed } from '../documents/review';
import {
  scoreMatch, rankCandidates, MATCH_THRESHOLDS,
  type MatchCandidate, type DocumentForMatching, type TransactionForMatching,
} from './scoring';

/**
 * Matching service (README §16).
 *
 * Candidates are stored, not just the winner, so the user can see what else was
 * considered. Nothing below the auto-accept threshold is applied without a
 * decision, and an ambiguous best candidate is never applied at all — README §16
 * is explicit that an uncertain match must never be silently forced.
 */

export interface FindMatchesOptions {
  /** How far either side of the document date to look. */
  windowDays?: number;
  /** Apply a match automatically at or above this score. Null disables it. */
  autoAcceptThreshold?: number | null;
  actor?: string;
  requestId?: string;
}

export interface MatchOutcome {
  documentId: string;
  candidates: MatchCandidate[];
  best: MatchCandidate | null;
  ambiguous: boolean;
  applied: boolean;
  matchRecordIds: string[];
}

export function findMatchesForDocument(
  db: AppDatabase,
  params: { companyId: string; documentId: string } & FindMatchesOptions,
): MatchOutcome {
  const document = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId)))
    .get();
  if (!document) throw new Error(`Document ${params.documentId} not found.`);
  // An unconfirmed extraction is a draft: its amounts, date and supplier may be
  // wrong, so it cannot be used to find (let alone apply) a bank match.
  assertDocumentConfirmed(document, 'matching it to a bank transaction');

  const windowDays = params.windowDays ?? 60;
  const supplier = document.supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, document.supplierId)).get()
    : undefined;

  const forMatching: DocumentForMatching = {
    id: document.id,
    grossMinor: document.grossMinor,
    currency: document.currency,
    documentDate: document.documentDate,
    invoiceNumber: document.invoiceNumber,
    supplierId: document.supplierId,
    supplierName: supplier?.name ?? null,
    supplierAliases: supplier?.aliases ?? [],
    typicalPaymentDays: supplier?.typicalPaymentDays ?? null,
  };

  // Only consider transactions in a plausible window, and only ones that are
  // not already matched to a different document.
  const conditions = [
    eq(bankTransactions.companyId, params.companyId),
    ne(bankTransactions.status, 'ignored'),
    ne(bankTransactions.status, 'duplicate'),
    sql`NOT EXISTS (
      SELECT 1 FROM ${documents} d
      WHERE d.matched_transaction_id = ${bankTransactions.id}
        AND d.id <> ${document.id}
    )`,
  ];

  if (document.documentDate) {
    const date = asIsoDate(document.documentDate);
    conditions.push(gte(bankTransactions.transactionDate, addDays(date, -windowDays)));
    conditions.push(lte(bankTransactions.transactionDate, addDays(date, windowDays)));
  }

  const transactions = db.select().from(bankTransactions).where(and(...conditions)).all();

  const candidates = transactions
    .map((transaction) => scoreMatch(forMatching, toTransaction(transaction)))
    .filter((candidate) => candidate.score >= MATCH_THRESHOLDS.possible
      || candidate.matchType === 'conflict');

  const ranked = rankCandidates(candidates);
  const timestamp = nowIso();
  const matchRecordIds: string[] = [];

  const autoAcceptThreshold = params.autoAcceptThreshold === undefined
    ? MATCH_THRESHOLDS.matched
    : params.autoAcceptThreshold;

  const canAutoAccept = autoAcceptThreshold !== null
    && ranked.best !== null
    && ranked.best.matchType === 'matched'
    && ranked.best.score >= autoAcceptThreshold
    && !ranked.ambiguous;

  db.transaction((tx) => {
    // Previous undecided candidates are superseded so the queue does not grow
    // a new copy every time matching is re-run.
    tx.update(documentMatches).set({ decision: 'superseded' })
      .where(and(
        eq(documentMatches.documentId, document.id),
        eq(documentMatches.decision, 'pending'),
      )).run();

    for (const candidate of ranked.all) {
      const isWinner = candidate === ranked.best;
      const id = ids.match();
      tx.insert(documentMatches).values({
        id,
        companyId: params.companyId,
        documentId: document.id,
        bankTransactionId: candidate.bankTransactionId,
        matchType: candidate.matchType,
        score: candidate.score,
        factors: candidate.factors,
        amountDifferenceMinor: candidate.amountDifferenceMinor,
        dateDifferenceDays: candidate.dateDifferenceDays,
        currencyMatches: candidate.currencyMatches,
        decision: isWinner && canAutoAccept ? 'auto_accepted' : 'pending',
        decidedAt: isWinner && canAutoAccept ? timestamp : null,
        decidedBy: isWinner && canAutoAccept ? 'system' : null,
        decisionReason: isWinner && canAutoAccept ? candidate.explanation : null,
        source: 'system',
        confidence: candidate.score,
        provenanceStatus: isWinner && canAutoAccept ? 'system_rule' : 'ai_suggestion',
      }).run();
      matchRecordIds.push(id);
    }

    if (canAutoAccept && ranked.best) {
      applyMatchInTransaction(tx, {
        companyId: params.companyId,
        documentId: document.id,
        bankTransactionId: ranked.best.bankTransactionId,
        actor: params.actor ?? 'system',
        reason: ranked.best.explanation,
        auto: true,
        requestId: params.requestId,
      });
    } else if (ranked.best) {
      tx.update(documents).set({ matchStatus: 'suggested' })
        .where(eq(documents.id, document.id)).run();

      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'uncertain_match',
        severity: 'warning',
        title: ranked.ambiguous
          ? `"${document.originalFilename}" matches more than one transaction equally well`
          : `"${document.originalFilename}" has an uncertain match`,
        detail: ranked.ambiguous
          ? `Two transactions score within 10 points of each other (${ranked.best.score}% and `
            + `${ranked.runnerUp!.score}%). Choosing one automatically would risk attaching `
            + 'this document to the wrong payment.'
          : ranked.best.explanation,
        entityType: 'document',
        entityId: document.id,
        dedupeKey: `document:${document.id}:match`,
        context: {
          candidates: ranked.all.slice(0, 5).map((c) => ({
            bankTransactionId: c.bankTransactionId,
            score: c.score,
            matchType: c.matchType,
            explanation: c.explanation,
          })),
          ambiguous: ranked.ambiguous,
        },
        suggestedActions: ranked.all.slice(0, 3).map((c) => ({
          label: `Accept match with transaction (${c.score}%)`,
          action: 'accept_match',
          payload: { documentId: document.id, bankTransactionId: c.bankTransactionId },
        })),
      });
    } else {
      tx.update(documents).set({ matchStatus: 'unmatched' })
        .where(eq(documents.id, document.id)).run();

      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'unmatched_transaction',
        severity: 'info',
        title: `No transaction found for "${document.originalFilename}"`,
        detail: 'Nothing in the bank data plausibly corresponds to this document. It may '
          + 'not have been paid yet, it may have been paid personally, or the statement '
          + 'covering it may not be imported.',
        entityType: 'document',
        entityId: document.id,
        dedupeKey: `document:${document.id}:no_match`,
      });
    }
  });

  return {
    documentId: document.id,
    candidates: ranked.all,
    best: ranked.best,
    ambiguous: ranked.ambiguous,
    applied: canAutoAccept,
    matchRecordIds,
  };
}

function toTransaction(row: typeof bankTransactions.$inferSelect): TransactionForMatching {
  return {
    id: row.id,
    amountMinor: row.amountMinor,
    currency: row.currency,
    transactionDate: row.transactionDate,
    description: row.description,
    bankReference: row.bankReference,
    counterpartyName: row.counterpartyName,
    supplierId: row.supplierId,
    baseAmountMinor: row.baseAmountMinor,
    baseCurrency: row.baseCurrency,
  };
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export function applyMatchInTransaction(
  tx: Tx | AppDatabase,
  params: {
    companyId: string; documentId: string; bankTransactionId: string;
    actor: string; reason: string; auto: boolean; requestId?: string;
  },
): void {
  const document = tx.select({
    id: documents.id, reviewStatus: documents.reviewStatus, originalFilename: documents.originalFilename,
  }).from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId)))
    .get();
  if (!document) throw new Error(`Document ${params.documentId} not found.`);
  assertDocumentConfirmed(document, 'linking it to a bank transaction');

  const timestamp = nowIso();

  tx.update(documents).set({
    matchedTransactionId: params.bankTransactionId,
    matchStatus: 'matched',
    updatedAt: timestamp,
  }).where(eq(documents.id, params.documentId)).run();

  tx.update(bankTransactions).set({ updatedAt: timestamp })
    .where(and(
      eq(bankTransactions.id, params.bankTransactionId),
      eq(bankTransactions.status, 'unclassified'),
    )).run();

  tx.insert(auditEvents).values({
    id: ids.audit(),
    companyId: params.companyId,
    occurredAt: timestamp,
    entityType: 'document',
    entityId: params.documentId,
    action: 'document_matched',
    newValue: params.bankTransactionId,
    source: params.auto ? 'system' : 'user',
    actor: params.actor,
    reason: params.reason,
    requestId: params.requestId ?? null,
  }).run();
}

/** Accept a proposed match. This is a user decision and is recorded as one. */
export function acceptMatch(
  db: AppDatabase,
  params: {
    companyId: string; documentId: string; bankTransactionId: string;
    actor?: string; reason?: string; requestId?: string;
  },
): void {
  db.transaction((tx) => {
    tx.update(documentMatches).set({
      decision: 'accepted',
      decidedAt: nowIso(),
      decidedBy: params.actor ?? 'user',
      decisionReason: params.reason ?? null,
      provenanceStatus: 'user_confirmed',
    }).where(and(
      eq(documentMatches.documentId, params.documentId),
      eq(documentMatches.bankTransactionId, params.bankTransactionId),
    )).run();

    // Every other candidate for this document is now rejected by implication.
    tx.update(documentMatches).set({ decision: 'rejected', decidedAt: nowIso() })
      .where(and(
        eq(documentMatches.documentId, params.documentId),
        ne(documentMatches.bankTransactionId, params.bankTransactionId),
        eq(documentMatches.decision, 'pending'),
      )).run();

    applyMatchInTransaction(tx, {
      companyId: params.companyId,
      documentId: params.documentId,
      bankTransactionId: params.bankTransactionId,
      actor: params.actor ?? 'user',
      reason: params.reason ?? 'Accepted by user',
      auto: false,
      requestId: params.requestId,
    });

    resolveReviewItems(
      tx, params.companyId, `document:${params.documentId}:match`,
      `Matched to transaction ${params.bankTransactionId} by ${params.actor ?? 'user'}.`,
    );
    resolveReviewItems(
      tx, params.companyId, `document:${params.documentId}:no_match`,
      'A match was recorded.',
    );
  });
}

/**
 * Link a document to a bank transaction by hand, regardless of whether the
 * scorer ever proposed it as a candidate.
 *
 * The user is making the decision, so this bypasses the scoring thresholds —
 * but it does not bypass the audit trail or the review resolution. If the
 * document was already linked to a different transaction, the old link is
 * detached first (leaving its audit record behind), exactly as `unmatchDocument`
 * does. A manual link is recorded as a `documentMatches` row with `source: 'user'`
 * so it is distinguishable from an auto-scored candidate in the audit trail.
 */
export function linkDocument(
  db: AppDatabase,
  params: {
    companyId: string; documentId: string; bankTransactionId: string;
    actor?: string; reason?: string; requestId?: string;
  },
): void {
  const document = db.select().from(documents)
    .where(and(
      eq(documents.id, params.documentId),
      eq(documents.companyId, params.companyId),
    )).get();
  if (!document) throw new Error(`Document ${params.documentId} not found.`);
  assertDocumentConfirmed(document, 'linking it to a bank transaction');

  const transaction = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, params.bankTransactionId),
      eq(bankTransactions.companyId, params.companyId),
    )).get();
  if (!transaction) throw new Error(`Bank transaction ${params.bankTransactionId} not found.`);

  // A document already linked elsewhere is detached first, so the old link
  // remains in the audit trail rather than being silently overwritten.
  if (document.matchedTransactionId && document.matchedTransactionId !== params.bankTransactionId) {
    unmatchDocument(db, {
      companyId: params.companyId,
      documentId: params.documentId,
      actor: params.actor,
      reason: `Re-linked to ${params.bankTransactionId}`,
    });
  }

  const reason = params.reason ?? 'Manually linked';
  const actor = params.actor ?? 'user';
  const timestamp = nowIso();

  db.transaction((tx) => {
    // Any pending scored candidates for this document are rejected by
    // implication — the user has chosen a link, so they no longer need a
    // decision on the alternatives.
    tx.update(documentMatches).set({
      decision: 'rejected', decidedAt: timestamp, decidedBy: actor,
      decisionReason: 'Superseded by a manual link',
    }).where(and(
      eq(documentMatches.documentId, params.documentId),
      eq(documentMatches.decision, 'pending'),
    )).run();

    const matchId = ids.match();
    tx.insert(documentMatches).values({
      id: matchId,
      companyId: params.companyId,
      documentId: params.documentId,
      bankTransactionId: params.bankTransactionId,
      matchType: 'matched',
      score: 100,
      factors: [],
      amountDifferenceMinor: null,
      dateDifferenceDays: null,
      currencyMatches: null,
      decision: 'accepted',
      decidedAt: timestamp,
      decidedBy: actor,
      decisionReason: reason,
      source: 'user',
      confidence: 100,
      provenanceStatus: 'user_confirmed',
    }).run();

    applyMatchInTransaction(tx, {
      companyId: params.companyId,
      documentId: params.documentId,
      bankTransactionId: params.bankTransactionId,
      actor,
      reason,
      auto: false,
      requestId: params.requestId,
    });

    resolveReviewItems(
      tx, params.companyId, `document:${params.documentId}:match`,
      `Manually linked to transaction ${params.bankTransactionId} by ${actor}.`,
    );
    resolveReviewItems(
      tx, params.companyId, `document:${params.documentId}:no_match`,
      'A manual link was recorded.',
    );
  });
}

export function rejectMatch(
  db: AppDatabase,
  params: {
    companyId: string; documentId: string; bankTransactionId: string;
    actor?: string; reason?: string;
  },
): void {
  db.transaction((tx) => {
    tx.update(documentMatches).set({
      decision: 'rejected',
      decidedAt: nowIso(),
      decidedBy: params.actor ?? 'user',
      decisionReason: params.reason ?? null,
      provenanceStatus: 'user_rejected',
    }).where(and(
      eq(documentMatches.documentId, params.documentId),
      eq(documentMatches.bankTransactionId, params.bankTransactionId),
    )).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'document',
      entityId: params.documentId,
      action: 'user_rejected',
      previousValue: params.bankTransactionId,
      source: 'user',
      actor: params.actor ?? 'user',
      reason: params.reason ?? null,
    }).run();
  });
}

/** Detach a document from its transaction, leaving the record of both. */
export function unmatchDocument(
  db: AppDatabase,
  params: { companyId: string; documentId: string; actor?: string; reason: string },
): void {
  const document = db.select().from(documents)
    .where(eq(documents.id, params.documentId)).get();
  if (!document?.matchedTransactionId) return;

  // A document whose invoice this bank line has paid is not merely matched:
  // the payment is posted. Unlinking it would leave the payment in the books
  // with its evidence apparently gone (issue #203).
  if (document.invoiceId) {
    const settled = db.select({ id: payments.id }).from(payments)
      .innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
      .where(and(
        eq(payments.bankTransactionId, document.matchedTransactionId),
        eq(paymentAllocations.invoiceId, document.invoiceId),
      )).get();
    if (settled) {
      throw new Error(
        'This bank line has paid the invoice posted from this document, so they cannot be unlinked. '
          + 'The payment must be reversed first.',
      );
    }
  }

  db.transaction((tx) => {
    tx.update(documents).set({
      matchedTransactionId: null, matchStatus: 'unmatched', updatedAt: nowIso(),
    }).where(eq(documents.id, params.documentId)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'document',
      entityId: params.documentId,
      action: 'document_unmatched',
      previousValue: document.matchedTransactionId,
      source: 'user',
      actor: params.actor ?? 'user',
      reason: params.reason,
    }).run();
  });
}

/** Close the review item a resolved decision was raised for. */
export function resolveReviewItems(
  tx: Tx | AppDatabase, companyId: string, dedupeKey: string, resolution: string,
): void {
  tx.update(reviewItems).set({
    status: 'resolved',
    resolvedAt: nowIso(),
    resolution,
    updatedAt: nowIso(),
  }).where(and(
    eq(reviewItems.companyId, companyId),
    eq(reviewItems.dedupeKey, dedupeKey),
    eq(reviewItems.status, 'open'),
  )).run();
}

/** Run matching over every unmatched document (README §14's refresh action). */
export function matchAllUnmatched(
  db: AppDatabase,
  params: { companyId: string } & FindMatchesOptions,
): { processed: number; autoMatched: number; needingReview: number } {
  const pending = db.select({ id: documents.id }).from(documents)
    .where(and(
      eq(documents.companyId, params.companyId),
      eq(documents.archived, false),
      // Drafts wait for confirmation; they are listed as awaiting it, not matched.
      eq(documents.reviewStatus, 'confirmed'),
      or(eq(documents.matchStatus, 'unmatched'), eq(documents.matchStatus, 'suggested')),
      isNull(documents.matchedTransactionId),
    )).all();

  let autoMatched = 0;
  let needingReview = 0;

  for (const { id } of pending) {
    const outcome = findMatchesForDocument(db, { ...params, documentId: id });
    if (outcome.applied) autoMatched += 1;
    else if (outcome.best) needingReview += 1;
  }

  return { processed: pending.length, autoMatched, needingReview };
}

/** Bank transactions with no supporting document (README §20). */
export function unmatchedTransactions(
  db: AppDatabase,
  params: { companyId: string; from?: string; to?: string },
): Array<typeof bankTransactions.$inferSelect> {
  const conditions = [
    eq(bankTransactions.companyId, params.companyId),
    ne(bankTransactions.status, 'ignored'),
    sql`NOT EXISTS (
      SELECT 1 FROM ${documents} d WHERE d.matched_transaction_id = ${bankTransactions.id}
    )`,
  ];
  if (params.from) conditions.push(gte(bankTransactions.transactionDate, params.from));
  if (params.to) conditions.push(lte(bankTransactions.transactionDate, params.to));

  return db.select().from(bankTransactions)
    .where(and(...conditions))
    .orderBy(bankTransactions.transactionDate).all();
}

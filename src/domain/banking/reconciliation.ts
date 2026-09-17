import { and, eq, gte, lte, sql, desc, isNull, or, ne, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, bankAccounts, journalEntries, journalLines,
  reconciliations, auditEvents, documents, companies,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { normaliseDescription } from './fingerprint';
import { multiplyRational } from '../money';
import { AccountingError } from '../accounting/errors';

export class ReconciliationError extends AccountingError {}

/**
 * Convert a transaction's amountMinor into the company's base currency.
 *
 * Reconciliation compares the statement against the ledger, and the ledger is
 * always in base currency (journal lines carry baseDebit/baseCredit). A foreign
 * statement line cannot be folded into that comparison by its native amountMinor
 * — that mixes currency units and manufactures a residual that is only a unit
 * mismatch, not a real reconciliation break.
 *
 * So: a transaction in the base currency contributes its own amountMinor; a
 * foreign transaction contributes its settled base amount if the statement
 * carried one, else its amount converted at the statement's own rate; and a
 * foreign transaction with neither is refused rather than silently miscounted.
 */
function transactionBaseAmount(
  transaction: typeof bankTransactions.$inferSelect,
  baseCurrency: string,
): number {
  if (transaction.currency === baseCurrency) return transaction.amountMinor;
  if (transaction.baseAmountMinor !== null) return transaction.baseAmountMinor;
  if (transaction.fxRateNumerator !== null && transaction.fxRateDenominator !== null) {
    return multiplyRational(
      transaction.amountMinor, transaction.fxRateNumerator, transaction.fxRateDenominator,
    );
  }
  throw new ReconciliationError(
    `Transaction ${transaction.id} ("${transaction.description}") is in ${transaction.currency} `
      + `but the books are in ${baseCurrency}, and it has no settled base amount or exchange `
      + 'rate. Classify it with an exchange rate, or re-import the statement with a settled '
      + '(base-currency) amount column, before reconciling.',
  );
}

/**
 * The exchange rate from the latest in-period transaction that carries one, as
 * a numerator/denominator rational. Used to convert a foreign account's running
 * balance into base currency when the statement balance is a single figure in
 * the account's own currency.
 */
function latestInPeriodFxRate(
  transactions: Array<typeof bankTransactions.$inferSelect>,
): { numerator: number; denominator: number } | null {
  const withRate = [...transactions]
    .filter((t) => t.fxRateNumerator !== null && t.fxRateDenominator !== null)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate)
      || a.createdAt.localeCompare(b.createdAt));
  const last = withRate[withRate.length - 1];
  if (!last || last.fxRateNumerator === null || last.fxRateDenominator === null) return null;
  return { numerator: last.fxRateNumerator, denominator: last.fxRateDenominator };
}

/**
 * Bank reconciliation (README §21).
 *
 * Two independent records of the same money: the statement, and the ledger.
 * They can legitimately differ — a payment recorded but not yet cleared, a
 * statement line not yet classified — but every difference must be
 * *explainable*. An unexplained difference means a transaction is missing,
 * duplicated or miscoded, and that is the whole point of doing this.
 *
 * So this does not simply report a number. It decomposes the difference into
 * named components, each carrying the records behind it, and only calls the
 * account reconciled when the components account for the difference exactly.
 *
 * Reconciling never alters imported bank evidence (§21). It writes a
 * reconciliation record and marks transactions as reconciled; the imported
 * date, amount and description are untouched.
 */

export interface ReconcilingItem {
  kind: 'statement_not_in_ledger' | 'ledger_not_on_statement' | 'suspected_duplicate';
  label: string;
  explanation: string;
  amountMinor: number;
  entityType: 'bank_transaction' | 'journal_entry';
  entityId: string;
  date: string;
  description: string;
}

export interface ReconciliationResult {
  bankAccountId: string;
  bankAccountName: string;
  currency: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;

  /** What the bank says, from the statement's own running balance. */
  statementBalanceMinor: number;
  statementBalanceSource: 'statement_running_balance' | 'supplied' | 'derived_from_movements';
  /** What the books say. */
  ledgerBalanceMinor: number;
  /** Statement less ledger. */
  differenceMinor: number;

  items: ReconcilingItem[];
  /** Difference left once every identified item is accounted for. Should be 0. */
  unexplainedMinor: number;
  reconciled: boolean;
  summary: string;

  counts: {
    transactionsInPeriod: number;
    unposted: number;
    ledgerOnly: number;
    suspectedDuplicates: number;
    missingDocuments: number;
  };
}

export function reconcileBankAccount(
  db: AppDatabase,
  params: {
    companyId: string;
    bankAccountId: string;
    periodStart: IsoDate;
    periodEnd: IsoDate;
    /** Use the closing balance from the paper statement instead of the import. */
    statementClosingBalanceMinor?: number;
  },
): ReconciliationResult {
  const account = db.select().from(bankAccounts)
    .where(and(
      eq(bankAccounts.id, params.bankAccountId),
      eq(bankAccounts.companyId, params.companyId),
    )).get();
  if (!account) throw new ReconciliationError(`Bank account ${params.bankAccountId} not found.`);

  const company = db.select().from(companies)
    .where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ReconciliationError(`Company ${params.companyId} not found.`);
  const baseCurrency = company.baseCurrency;

  const inPeriod = and(
    eq(bankTransactions.bankAccountId, params.bankAccountId),
    gte(bankTransactions.transactionDate, params.periodStart),
    lte(bankTransactions.transactionDate, params.periodEnd),
  );

  const transactions = db.select().from(bankTransactions)
    .where(inPeriod)
    .orderBy(bankTransactions.transactionDate, bankTransactions.createdAt).all();

  // ---- What the bank says ----
  const { statementBalanceMinor, statementBalanceSource } = statementBalance(
    db, account, params, transactions, baseCurrency,
  );

  // ---- What the books say ----
  const ledgerAccountId = account.accountId;
  const ledgerBalanceMinor = ledgerAccountId
    ? bankLedgerBalance(db, params.companyId, ledgerAccountId, params.periodEnd)
    : 0;

  const differenceMinor = statementBalanceMinor - ledgerBalanceMinor;

  // ---- Decompose the difference ----
  const items: ReconcilingItem[] = [];

  // Statement lines that have not reached the ledger. These are on the bank's
  // side of the difference: the bank has counted them, the books have not.
  const unposted = transactions.filter(
    (t) => t.journalEntryId === null && t.status !== 'ignored' && t.status !== 'duplicate',
  );
  for (const transaction of unposted) {
    items.push({
      kind: 'statement_not_in_ledger',
      label: 'On the statement, not yet in the books',
      explanation: 'This transaction has been imported but not classified, so it is included '
        + 'in the bank balance and excluded from the ledger. Classify it to remove this '
        + 'difference.',
      amountMinor: transactionBaseAmount(transaction, baseCurrency),
      entityType: 'bank_transaction',
      entityId: transaction.id,
      date: transaction.transactionDate,
      description: transaction.description,
    });
  }

  // Ledger movements on the bank account with no statement line behind them.
  // Usually a payment recorded before it cleared — legitimate, but it must be
  // visible rather than absorbed.
  const ledgerOnly = ledgerAccountId
    ? ledgerEntriesWithoutStatementLine(db, {
        companyId: params.companyId,
        ledgerAccountId,
        bankAccountId: params.bankAccountId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
      })
    : [];

  for (const entry of ledgerOnly) {
    items.push({
      kind: 'ledger_not_on_statement',
      label: 'In the books, not on the statement',
      explanation: 'The books record this money moving, but no imported statement line '
        + 'corresponds to it. Usually that means it has not cleared yet, or the statement '
        + 'covering it has not been imported.',
      amountMinor: entry.amountMinor,
      entityType: 'journal_entry',
      entityId: entry.entryId,
      date: entry.entryDate,
      description: entry.narrative,
    });
  }

  // ---- Suspected duplicates ----
  // These do not contribute to the difference — both copies are in both
  // records — but reconciliation is when a person is actually looking, and a
  // duplicated purchase reclaims the same VAT twice.
  const duplicates = findSuspectedDuplicates(transactions);
  for (const duplicate of duplicates) {
    items.push({
      kind: 'suspected_duplicate',
      label: 'Possible duplicate',
      explanation: `The same amount, date and description appear ${duplicate.occurrences} times `
        + 'on this statement. That can be genuine — two identical charges on one day happen — '
        + 'but confirm it, because a duplicated purchase would reclaim the same VAT twice.',
      amountMinor: transactionBaseAmount(duplicate.transaction, baseCurrency),
      entityType: 'bank_transaction',
      entityId: duplicate.transaction.id,
      date: duplicate.transaction.transactionDate,
      description: duplicate.transaction.description,
    });
  }

  // ---- Does the explanation account for the difference? ----
  const explainedMinor = items
    .filter((item) => item.kind !== 'suspected_duplicate')
    .reduce((sum, item) => sum + (
      // A statement line not in the books makes the statement higher than the
      // ledger by its own (signed) amount. A ledger movement with no statement
      // line makes it lower.
      item.kind === 'statement_not_in_ledger' ? item.amountMinor : -item.amountMinor
    ), 0);

  const unexplainedMinor = differenceMinor - explainedMinor;
  const reconciled = unexplainedMinor === 0;

  const missingDocuments = transactions.filter((t) =>
    t.journalEntryId !== null
    && db.select({ id: documents.id }).from(documents)
        .where(eq(documents.matchedTransactionId, t.id)).get() === undefined).length;

  return {
    bankAccountId: account.id,
    bankAccountName: `${account.bankName} — ${account.accountName}`,
    currency: baseCurrency,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    statementBalanceMinor,
    statementBalanceSource,
    ledgerBalanceMinor,
    differenceMinor,
    items,
    unexplainedMinor,
    reconciled,
    summary: buildSummary({
      reconciled, differenceMinor, unexplainedMinor,
      unposted: unposted.length, ledgerOnly: ledgerOnly.length,
      statementBalanceSource,
    }),
    counts: {
      transactionsInPeriod: transactions.length,
      unposted: unposted.length,
      ledgerOnly: ledgerOnly.length,
      suspectedDuplicates: duplicates.length,
      missingDocuments,
    },
  };
}

/**
 * The bank's own closing balance.
 *
 * Preferred source is the running balance the statement itself carried, because
 * that is the bank's figure rather than one this application derived. Deriving
 * it by summing movements would make the reconciliation circular: the ledger
 * and the "statement" would both be built from the same imported rows, and the
 * check would pass even when a row was missing.
 */
function statementBalance(
  db: AppDatabase,
  account: typeof bankAccounts.$inferSelect,
  params: { statementClosingBalanceMinor?: number; periodEnd: IsoDate; bankAccountId: string },
  transactions: Array<typeof bankTransactions.$inferSelect>,
  baseCurrency: string,
): { statementBalanceMinor: number; statementBalanceSource: ReconciliationResult['statementBalanceSource'] } {
  const foreignAccount = account.currency !== baseCurrency;

  // Convert a balance figure in the account's own currency into base currency,
  // using the rate the latest in-period statement line carried. A foreign
  // account cannot be reconciled against a base-currency ledger without a rate.
  const toBase = (amountMinor: number): number => {
    if (!foreignAccount) return amountMinor;
    const rate = latestInPeriodFxRate(transactions);
    if (!rate) {
      throw new ReconciliationError(
        `Bank account ${account.id} is in ${account.currency} but the books are in `
          + `${baseCurrency}, and no in-period statement line carries an exchange rate. `
          + 'Import a statement with a settled (base-currency) amount column, or classify a '
          + 'transaction with an exchange rate, before reconciling.',
      );
    }
    return multiplyRational(amountMinor, rate.numerator, rate.denominator);
  };

  if (params.statementClosingBalanceMinor !== undefined) {
    return {
      statementBalanceMinor: toBase(params.statementClosingBalanceMinor),
      statementBalanceSource: 'supplied',
    };
  }

  const withBalance = [...transactions]
    .filter((t) => t.balanceAfterMinor !== null)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate)
      || a.createdAt.localeCompare(b.createdAt));

  const last = withBalance[withBalance.length - 1];
  if (last?.balanceAfterMinor !== null && last?.balanceAfterMinor !== undefined) {
    return {
      statementBalanceMinor: toBase(last.balanceAfterMinor),
      statementBalanceSource: 'statement_running_balance',
    };
  }

  // No running balance in the import. Fall back to opening balance plus
  // movements, and say so: this cannot detect a missing statement line.
  // Each movement is converted to base so the sum is in a single currency.
  const opening = foreignAccount ? toBase(account.openingBalanceMinor) : account.openingBalanceMinor;
  const movements = transactions.reduce(
    (sum, t) => sum + transactionBaseAmount(t, baseCurrency), 0,
  );
  return {
    statementBalanceMinor: opening + movements,
    statementBalanceSource: 'derived_from_movements',
  };
}

/** The ledger balance of a bank account, as a signed bank balance. */
function bankLedgerBalance(
  db: AppDatabase, companyId: string, ledgerAccountId: string, asOf: IsoDate,
): number {
  const row = db.select({
    debit: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
    credit: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
  })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalLines.companyId, companyId),
      eq(journalLines.accountId, ledgerAccountId),
      eq(journalEntries.isPosted, true),
      lte(journalEntries.entryDate, asOf),
    )).get();

  // A bank account is a debit-normal asset: debits increase it.
  return (row?.debit ?? 0) - (row?.credit ?? 0);
}

/**
 * Journal entries touching the bank account that no imported statement line
 * accounts for.
 */
function ledgerEntriesWithoutStatementLine(
  db: AppDatabase,
  params: {
    companyId: string; ledgerAccountId: string; bankAccountId: string;
    periodStart: IsoDate; periodEnd: IsoDate;
  },
): Array<{ entryId: string; entryDate: string; narrative: string; amountMinor: number }> {
  const rows = db.select({
    entryId: journalEntries.id,
    entryDate: journalEntries.entryDate,
    narrative: journalEntries.narrative,
    sourceType: journalEntries.sourceType,
    sourceId: journalEntries.sourceId,
    debit: journalLines.baseDebitMinor,
    credit: journalLines.baseCreditMinor,
  })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalLines.companyId, params.companyId),
      eq(journalLines.accountId, params.ledgerAccountId),
      eq(journalEntries.isPosted, true),
      gte(journalEntries.entryDate, params.periodStart),
      lte(journalEntries.entryDate, params.periodEnd),
    )).all();

  // An entry is accounted for when a bank transaction points at it.
  const evidenced = new Set(
    db.select({ id: journalEntries.id })
      .from(bankTransactions)
      .innerJoin(journalEntries, eq(bankTransactions.journalEntryId, journalEntries.id))
      .where(eq(bankTransactions.bankAccountId, params.bankAccountId))
      .all().map((r) => r.id),
  );

  const byEntry = new Map<string, { entryId: string; entryDate: string;
                                    narrative: string; amountMinor: number }>();

  for (const row of rows) {
    if (evidenced.has(row.entryId)) continue;
    const existing = byEntry.get(row.entryId);
    const amount = row.debit - row.credit;
    if (existing) existing.amountMinor += amount;
    else {
      byEntry.set(row.entryId, {
        entryId: row.entryId,
        entryDate: row.entryDate,
        narrative: row.narrative,
        amountMinor: amount,
      });
    }
  }

  return [...byEntry.values()].filter((entry) => entry.amountMinor !== 0);
}

/**
 * Statement lines sharing a date, amount and normalised description.
 *
 * Import deduplication already guarantees these are distinct lines on the
 * statement rather than a double import, so this is flagged for a human rather
 * than treated as an error.
 */
function findSuspectedDuplicates(
  transactions: Array<typeof bankTransactions.$inferSelect>,
): Array<{ transaction: typeof bankTransactions.$inferSelect; occurrences: number }> {
  const groups = new Map<string, Array<typeof bankTransactions.$inferSelect>>();

  for (const transaction of transactions) {
    // A bank-supplied transaction id makes two lines definitively distinct.
    if (transaction.bankTransactionId) continue;
    const key = [
      transaction.transactionDate,
      String(transaction.amountMinor),
      transaction.currency,
      normaliseDescription(transaction.description),
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(transaction);
    groups.set(key, group);
  }

  const flagged: Array<{ transaction: typeof bankTransactions.$inferSelect; occurrences: number }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const transaction of group) {
      if (transaction.duplicateConfirmed) continue;
      flagged.push({ transaction, occurrences: group.length });
    }
  }
  return flagged;
}

function buildSummary(params: {
  reconciled: boolean; differenceMinor: number; unexplainedMinor: number;
  unposted: number; ledgerOnly: number;
  statementBalanceSource: ReconciliationResult['statementBalanceSource'];
}): string {
  const caveat = params.statementBalanceSource === 'derived_from_movements'
    ? ' Note that the statement balance was derived from the imported movements rather than '
      + 'read from the statement, so this check cannot detect a statement line that was never '
      + 'imported. Enter the closing balance from your statement for a real check.'
    : '';

  if (params.reconciled && params.differenceMinor === 0) {
    return `The bank and the books agree exactly.${caveat}`;
  }
  if (params.reconciled) {
    const parts: string[] = [];
    if (params.unposted > 0) {
      parts.push(`${params.unposted} statement line${params.unposted === 1 ? '' : 's'} not yet classified`);
    }
    if (params.ledgerOnly > 0) {
      parts.push(`${params.ledgerOnly} ledger entr${params.ledgerOnly === 1 ? 'y' : 'ies'} not yet on a statement`);
    }
    return `The difference is fully explained by ${parts.join(' and ')}.${caveat}`;
  }
  return `There is a difference of ${(Math.abs(params.unexplainedMinor) / 100).toFixed(2)} that `
    + 'nothing accounts for. A transaction is missing, duplicated or miscoded — do not '
    + `treat these figures as final until it is found.${caveat}`;
}

/**
 * Record a completed reconciliation.
 *
 * Marks the reconciled transactions and writes the reconciliation record.
 * The imported evidence is untouched (§21): only the reconciliation status and
 * timestamp change, on rows whose accounting has already been posted.
 */
export function completeReconciliation(
  db: AppDatabase,
  params: {
    companyId: string;
    bankAccountId: string;
    periodStart: IsoDate;
    periodEnd: IsoDate;
    statementClosingBalanceMinor?: number;
    actor?: string;
    notes?: string;
    /** Complete despite an unexplained difference. Requires a reason. */
    acceptDifference?: { reason: string };
  },
): { reconciliationId: string; result: ReconciliationResult } {
  const result = reconcileBankAccount(db, params);

  if (!result.reconciled && !params.acceptDifference) {
    throw new ReconciliationError(
      `NOT RECONCILED: ${result.summary} Completing anyway requires an explicit reason, which `
        + 'is recorded in the audit trail.',
      { unexplainedMinor: result.unexplainedMinor },
    );
  }

  const reconciliationId = ids.reconciliation();
  const timestamp = nowIso();

  db.transaction((tx) => {
    tx.insert(reconciliations).values({
      id: reconciliationId,
      companyId: params.companyId,
      bankAccountId: params.bankAccountId,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      statementClosingBalanceMinor: result.statementBalanceMinor,
      ledgerBalanceMinor: result.ledgerBalanceMinor,
      differenceMinor: result.differenceMinor,
      currency: result.currency,
      unmatchedCount: result.counts.unposted,
      duplicateCount: result.counts.suspectedDuplicates,
      missingDocumentCount: result.counts.missingDocuments,
      status: result.reconciled ? 'balanced' : 'unbalanced',
      completedAt: timestamp,
      completedBy: params.actor ?? 'user',
      notes: params.notes ?? params.acceptDifference?.reason ?? null,
    }).run();

    // Only posted transactions can be reconciled; an unclassified line has no
    // accounting to agree with.
    tx.update(bankTransactions).set({
      status: 'reconciled',
      reconciliationId,
      reconciledAt: timestamp,
      updatedAt: timestamp,
    }).where(and(
      eq(bankTransactions.bankAccountId, params.bankAccountId),
      gte(bankTransactions.transactionDate, params.periodStart),
      lte(bankTransactions.transactionDate, params.periodEnd),
      eq(bankTransactions.status, 'posted'),
    )).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'reconciliation',
      entityId: reconciliationId,
      action: 'reconciled',
      newValue: JSON.stringify({
        bankAccountId: params.bankAccountId,
        periodStart: params.periodStart, periodEnd: params.periodEnd,
        statementBalanceMinor: result.statementBalanceMinor,
        ledgerBalanceMinor: result.ledgerBalanceMinor,
        differenceMinor: result.differenceMinor,
        unexplainedMinor: result.unexplainedMinor,
      }),
      source: 'user',
      actor: params.actor ?? 'user',
      reason: params.acceptDifference?.reason ?? null,
    }).run();
  });

  return { reconciliationId, result };
}

export function reconciliationHistory(
  db: AppDatabase, companyId: string,
): Array<typeof reconciliations.$inferSelect> {
  return db.select().from(reconciliations)
    .where(eq(reconciliations.companyId, companyId))
    .orderBy(desc(reconciliations.periodEnd)).all();
}

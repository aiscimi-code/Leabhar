import { and, eq, gte, lte, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, bankAccounts, bankTransactions, companies, journalEntries, journalLines,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, asIsoDate, nowIso } from '../dates';
import { AccountingError } from '../accounting/errors';

/**
 * A statement line whose movement is already in the ledger (issue #385).
 *
 * The commonest case is a transfer between two of the business's own
 * accounts: classifying the line on one account to the other account's ledger
 * posts both sides at once, so the second account's line is not a new
 * movement — it is evidence for the journal already posted. The same holds for
 * a loan drawdown or a correction journaled by hand. Linking says so; posting
 * again would count the money twice.
 */

export class JournalLinkError extends AccountingError {}

type Line = typeof bankTransactions.$inferSelect;

function loadLine(db: AppDatabase, companyId: string, bankTransactionId: string): {
  line: Line; ledgerAccountId: string; baseAmountMinor: number;
} {
  const line = db.select().from(bankTransactions).where(and(
    eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.companyId, companyId),
  )).get();
  if (!line) throw new JournalLinkError(`Bank transaction ${bankTransactionId} not found.`);
  const account = db.select().from(bankAccounts).where(eq(bankAccounts.id, line.bankAccountId)).get();
  if (!account?.accountId) {
    throw new JournalLinkError('This bank account has no ledger account, so there is no journal to link to.');
  }
  const base = db.select({ c: companies.baseCurrency }).from(companies)
    .where(eq(companies.id, companyId)).get()!.c.toUpperCase();
  const baseAmountMinor = line.currency.toUpperCase() === base ? line.amountMinor : line.baseAmountMinor;
  if (baseAmountMinor === null) {
    throw new JournalLinkError(
      `This line is in ${line.currency} with no base-currency amount, so it cannot be compared with a `
        + 'journal. Record the rate the bank used first.',
    );
  }
  return { line, ledgerAccountId: account.accountId, baseAmountMinor };
}

/** The net base-currency movement a journal makes on one ledger account (debit positive). */
function netOnAccount(db: AppDatabase, journalEntryId: string, ledgerAccountId: string): number {
  return db.select().from(journalLines).where(and(
    eq(journalLines.journalEntryId, journalEntryId), eq(journalLines.accountId, ledgerAccountId),
  )).all().reduce((sum, l) => sum + l.baseDebitMinor - l.baseCreditMinor, 0);
}

/** Is a journal already evidenced by a line on this bank account? */
function evidencedOnAccount(db: AppDatabase, journalEntryId: string, bankAccountId: string): boolean {
  return db.select({ id: bankTransactions.id }).from(bankTransactions).where(and(
    eq(bankTransactions.journalEntryId, journalEntryId),
    eq(bankTransactions.bankAccountId, bankAccountId),
  )).get() !== undefined;
}

export interface JournalCandidate {
  journalEntryId: string;
  entryNumber: number;
  entryDate: string;
  narrative: string;
  sourceType: string;
  amountMinor: number;
  dateDifferenceDays: number;
  /** Posted by classifying a line on another of the business's own accounts. */
  transferFromBankAccount: string | null;
}

/**
 * Posted, unreversed journals that move exactly this line's amount on this
 * account's ledger within `windowDays`, and that no line on this account
 * evidences yet. Transfers between own accounts first, then by date distance.
 */
export function suggestJournalMatches(
  db: AppDatabase,
  params: { companyId: string; bankTransactionId: string; windowDays?: number },
): JournalCandidate[] {
  const { line, ledgerAccountId, baseAmountMinor } = loadLine(db, params.companyId, params.bankTransactionId);
  const window = params.windowDays ?? 7;
  const date = asIsoDate(line.transactionDate);
  const entries = db.selectDistinct({
    id: journalEntries.id, entryNumber: journalEntries.entryNumber, entryDate: journalEntries.entryDate,
    narrative: journalEntries.narrative, sourceType: journalEntries.sourceType, sourceId: journalEntries.sourceId,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalLines.companyId, params.companyId),
      eq(journalLines.accountId, ledgerAccountId),
      eq(journalEntries.isPosted, true),
      isNull(journalEntries.reversedByEntryId),
      isNull(journalEntries.reversalOfId),
      gte(journalEntries.entryDate, addDays(date, -window)),
      lte(journalEntries.entryDate, addDays(date, window)),
    )).all();

  const candidates: JournalCandidate[] = [];
  for (const entry of entries) {
    if (entry.sourceType === 'opening_balance') continue;
    if (netOnAccount(db, entry.id, ledgerAccountId) !== baseAmountMinor) continue;
    if (evidencedOnAccount(db, entry.id, line.bankAccountId)) continue;
    const origin = entry.sourceType === 'bank_transaction' && entry.sourceId
      ? db.select({ bankAccountId: bankTransactions.bankAccountId }).from(bankTransactions)
        .where(eq(bankTransactions.id, entry.sourceId)).get()
      : db.select({ bankAccountId: bankTransactions.bankAccountId }).from(bankTransactions)
        .where(eq(bankTransactions.journalEntryId, entry.id)).get();
    const fromOther = origin && origin.bankAccountId !== line.bankAccountId ? origin.bankAccountId : null;
    candidates.push({
      journalEntryId: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      narrative: entry.narrative,
      sourceType: entry.sourceType,
      amountMinor: baseAmountMinor,
      dateDifferenceDays: Math.abs(
        (Date.parse(entry.entryDate) - Date.parse(line.transactionDate)) / 86_400_000,
      ),
      transferFromBankAccount: fromOther,
    });
  }
  return candidates.sort((a, b) =>
    Number(b.transferFromBankAccount !== null) - Number(a.transferFromBankAccount !== null)
      || a.dateDifferenceDays - b.dateDifferenceDays);
}

/**
 * Link a statement line to the journal that already records its movement.
 * Refused unless the journal is posted and standing, moves exactly the line's
 * amount on this account's ledger, and no other line on this account already
 * evidences it — so a link can never make the ledger say something the
 * statement does not.
 */
export function linkBankTransactionToJournal(
  db: AppDatabase,
  params: {
    companyId: string; bankTransactionId: string; journalEntryId: string;
    actor: string; reason: string; requestId?: string;
  },
): void {
  const actor = params.actor.trim();
  if (!actor) throw new JournalLinkError('Say who is linking this line.');
  const reason = params.reason.trim();
  if (!reason) throw new JournalLinkError('Say why this line is that journal, e.g. "transfer from the current account".');

  const { line, ledgerAccountId, baseAmountMinor } = loadLine(db, params.companyId, params.bankTransactionId);
  if (line.status === 'rolled_back') throw new JournalLinkError('This line\'s import was undone; it is not part of the books.');
  if (line.journalEntryId) {
    throw new JournalLinkError('This line is already posted. Reclassify it instead if its posting is wrong.');
  }

  const entry = db.select().from(journalEntries).where(and(
    eq(journalEntries.id, params.journalEntryId), eq(journalEntries.companyId, params.companyId),
  )).get();
  if (!entry || !entry.isPosted) throw new JournalLinkError('That journal is not posted.');
  if (entry.reversedByEntryId || entry.reversalOfId) {
    throw new JournalLinkError('That journal has been reversed, or is a reversal. Link the line to a standing entry.');
  }
  const net = netOnAccount(db, entry.id, ledgerAccountId);
  if (net !== baseAmountMinor) {
    throw new JournalLinkError(
      `That journal moves ${(net / 100).toFixed(2)} on this account's ledger, but the line is `
        + `${(baseAmountMinor / 100).toFixed(2)}. A link must describe the same movement exactly.`,
    );
  }
  if (evidencedOnAccount(db, entry.id, line.bankAccountId)) {
    throw new JournalLinkError('Another line on this account already evidences that journal.');
  }

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(bankTransactions).set({
      journalEntryId: entry.id, status: 'posted', updatedAt: timestamp,
    }).where(eq(bankTransactions.id, line.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'bank_transaction',
      entityId: line.id,
      action: 'user_confirmed',
      field: 'journal_entry_id',
      previousValue: null,
      newValue: JSON.stringify({ journalEntryId: entry.id, entryNumber: entry.entryNumber }),
      reason,
      source: 'user',
      actor,
      requestId: params.requestId ?? null,
    }).run();
  });
}

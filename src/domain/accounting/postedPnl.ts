import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, journalEntries, journalLines } from '@/db/schema';

/**
 * Posted income and expense lines, for analysis kept beside the ledger (farm
 * enterprises, ADR 0016; projects, EPIC 27). Each line is signed so income
 * earned and cost incurred are positive, and carries `allocationLineId`: the
 * line an allocation is recorded against. For a reversing entry that is the
 * line it reverses (same line number and account), so a reversal takes the
 * original's allocation and the pair nets to nothing in the analysis as in
 * the ledger.
 */
export interface PostedPnlLine {
  id: string;
  journalEntryId: string;
  lineNumber: number;
  accountId: string;
  entryDate: string;
  sourceType: string;
  accountType: 'income' | 'expense';
  accountSubtype: string | null;
  amountMinor: number;
  /** The line whose allocation applies: itself, or the line a reversal reverses (null when that cannot be matched). */
  allocationLineId: string | null;
}

export function postedPnlLines(db: AppDatabase, companyId: string, range?: { from: string; to: string }): PostedPnlLine[] {
  const where = [eq(journalLines.companyId, companyId), eq(journalEntries.isPosted, true), inArray(accounts.type, ['income', 'expense'])];
  if (range) where.push(gte(journalEntries.entryDate, range.from), lte(journalEntries.entryDate, range.to));
  const rows = db.select({
    id: journalLines.id, journalEntryId: journalLines.journalEntryId, lineNumber: journalLines.lineNumber, accountId: journalLines.accountId,
    entryDate: journalEntries.entryDate, reversalOfId: journalEntries.reversalOfId, sourceType: journalEntries.sourceType,
    accountType: accounts.type, accountSubtype: accounts.subtype, debit: journalLines.baseDebitMinor, credit: journalLines.baseCreditMinor,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(...where)).all();
  const reversedIds = [...new Set(rows.filter((l) => l.reversalOfId).map((l) => l.reversalOfId!))];
  const originals = new Map<string, Map<number, { id: string; accountId: string }>>();
  if (reversedIds.length) {
    for (const o of db.select().from(journalLines).where(inArray(journalLines.journalEntryId, reversedIds)).all()) {
      const m = originals.get(o.journalEntryId) ?? new Map();
      m.set(o.lineNumber, { id: o.id, accountId: o.accountId });
      originals.set(o.journalEntryId, m);
    }
  }
  return rows.map((l) => {
    let allocationLineId: string | null = l.id;
    if (l.reversalOfId) {
      const o = originals.get(l.reversalOfId)?.get(l.lineNumber);
      allocationLineId = o && o.accountId === l.accountId ? o.id : null;
    }
    return {
      id: l.id, journalEntryId: l.journalEntryId, lineNumber: l.lineNumber, accountId: l.accountId, entryDate: l.entryDate,
      sourceType: l.sourceType, accountType: l.accountType as 'income' | 'expense', accountSubtype: l.accountSubtype,
      amountMinor: l.accountType === 'income' ? l.credit - l.debit : l.debit - l.credit, allocationLineId,
    };
  });
}

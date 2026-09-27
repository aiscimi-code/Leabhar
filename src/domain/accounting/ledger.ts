import { and, eq, sql, gte, lte, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, journalEntries, journalLines } from '@/db/schema';
import { type AccountType, signedBalance, normalBalance } from '../config/chartOfAccounts';
import type { IsoDate } from '../dates';

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  reportSection: string | null;
  debitMinor: number;
  creditMinor: number;
  /** Debits minus credits. Positive means a net debit balance. */
  netDebitMinor: number;
  /** Positive when the account sits on its natural side. */
  signedMinor: number;
  normalSide: 'debit' | 'credit';
  lineCount: number;
}

export interface TrialBalance {
  companyId: string;
  asOf: IsoDate;
  from: IsoDate | null;
  rows: AccountBalance[];
  /**
   * Gross movement: every debit and every credit summed separately, across
   * all listed accounts. Two different figures from the net columns below —
   * an account settled to zero still moved money — so a screen that shows
   * one must say which it means (issue #478).
   */
  totalDebitMinor: number;
  totalCreditMinor: number;
  /** Net balances: the column totals a trial balance is read by. */
  netTotalDebitMinor: number;
  netTotalCreditMinor: number;
  /** Zero in a correct set of books. Non-zero is a defect, not a rounding artefact. */
  differenceMinor: number;
  balanced: boolean;
  currency: string;
}

/**
 * Trial balance (README §37).
 *
 * Built from journal lines only. Nothing here reads a cached total or a
 * denormalised balance column, because a cached balance that drifts from the
 * journals is exactly the failure an accounting system cannot afford. Every
 * figure is recomputed from the entries that produced it.
 */
export function trialBalance(
  db: AppDatabase,
  params: {
    companyId: string;
    asOf: IsoDate;
    from?: IsoDate;
    baseCurrency?: string;
    includeZeroBalances?: boolean;
    /**
     * Leave out year-end closing entries and their reversals (issue #369).
     * A profit-and-loss or tax figure for a year asks what was earned and
     * spent; the close only moves that result into reserves, so counting it
     * would report every closed year as nil. A balance as at a date keeps the
     * close — that is where the result now sits.
     */
    excludeYearEndClose?: boolean;
  },
): TrialBalance {
  const conditions = [
    eq(journalLines.companyId, params.companyId),
    lte(journalEntries.entryDate, params.asOf),
    eq(journalEntries.isPosted, true),
  ];
  if (params.from) conditions.push(gte(journalEntries.entryDate, params.from));
  if (params.excludeYearEndClose) {
    conditions.push(sql`${journalEntries.sourceType} <> 'year_end_close'`);
    conditions.push(sql`(${journalEntries.reversalOfId} IS NULL OR ${journalEntries.reversalOfId} NOT IN (
      SELECT closing.id FROM journal_entries AS closing WHERE closing.source_type = 'year_end_close'))`);
  }

  const rows = db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      reportSection: accounts.reportSection,
      reportOrder: accounts.reportOrder,
      debitMinor: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
      creditMinor: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
      lineCount: sql<number>`COUNT(${journalLines.id})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(...conditions))
    .groupBy(accounts.id)
    .orderBy(accounts.code)
    .all();

  const balances: AccountBalance[] = rows
    .filter((r) => params.includeZeroBalances || r.debitMinor !== 0 || r.creditMinor !== 0)
    .map((r) => ({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      reportSection: r.reportSection,
      debitMinor: r.debitMinor,
      creditMinor: r.creditMinor,
      netDebitMinor: r.debitMinor - r.creditMinor,
      signedMinor: signedBalance(r.type, r.debitMinor, r.creditMinor),
      normalSide: normalBalance(r.type),
      lineCount: r.lineCount,
    }));

  const totalDebitMinor = balances.reduce((s, b) => s + b.debitMinor, 0);
  const totalCreditMinor = balances.reduce((s, b) => s + b.creditMinor, 0);
  const netTotalDebitMinor = balances.reduce((s, b) => s + Math.max(b.netDebitMinor, 0), 0);
  const netTotalCreditMinor = balances.reduce((s, b) => s + Math.max(-b.netDebitMinor, 0), 0);

  return {
    companyId: params.companyId,
    asOf: params.asOf,
    from: params.from ?? null,
    rows: balances,
    totalDebitMinor,
    totalCreditMinor,
    netTotalDebitMinor,
    netTotalCreditMinor,
    differenceMinor: totalDebitMinor - totalCreditMinor,
    balanced: totalDebitMinor === totalCreditMinor,
    currency: params.baseCurrency ?? 'EUR',
  };
}

export interface LedgerLine {
  entryId: string;
  entryNumber: number;
  entryDate: string;
  narrative: string;
  lineId: string;
  memo: string | null;
  debitMinor: number;
  creditMinor: number;
  runningBalanceMinor: number;
  sourceType: string;
  sourceId: string | null;
  isReversal: boolean;
}

/**
 * General ledger for one account, with a running balance (README §37).
 * This is the drill-down target when a user clicks a figure on a report.
 */
export function generalLedger(
  db: AppDatabase,
  params: { companyId: string; accountId: string; from?: IsoDate; to?: IsoDate },
): { account: typeof accounts.$inferSelect; lines: LedgerLine[]; closingBalanceMinor: number } {
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId)))
    .get();
  if (!account) throw new Error(`Account ${params.accountId} not found.`);

  const conditions = [
    eq(journalLines.accountId, params.accountId),
    eq(journalLines.companyId, params.companyId),
    eq(journalEntries.isPosted, true),
  ];
  if (params.from) conditions.push(gte(journalEntries.entryDate, params.from));
  if (params.to) conditions.push(lte(journalEntries.entryDate, params.to));

  const rows = db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      narrative: journalEntries.narrative,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      entryType: journalEntries.entryType,
      lineId: journalLines.id,
      memo: journalLines.memo,
      debitMinor: journalLines.baseDebitMinor,
      creditMinor: journalLines.baseCreditMinor,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(journalEntries.entryDate, journalEntries.entryNumber, journalLines.lineNumber)
    .all();

  const side = normalBalance(account.type);
  let running = 0;
  const lines: LedgerLine[] = rows.map((r) => {
    running += side === 'debit'
      ? r.debitMinor - r.creditMinor
      : r.creditMinor - r.debitMinor;
    return {
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      entryDate: r.entryDate,
      narrative: r.narrative,
      lineId: r.lineId,
      memo: r.memo,
      debitMinor: r.debitMinor,
      creditMinor: r.creditMinor,
      runningBalanceMinor: running,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      isReversal: r.entryType === 'reversal',
    };
  });

  return { account, lines, closingBalanceMinor: running };
}

/** Balance of a single account, in its natural direction. */
export function accountBalance(
  db: AppDatabase,
  params: { companyId: string; accountId: string; asOf?: IsoDate; from?: IsoDate },
): number {
  const account = db.select({ type: accounts.type }).from(accounts)
    .where(eq(accounts.id, params.accountId)).get();
  if (!account) throw new Error(`Account ${params.accountId} not found.`);

  const conditions = [
    eq(journalLines.accountId, params.accountId),
    eq(journalLines.companyId, params.companyId),
    eq(journalEntries.isPosted, true),
  ];
  if (params.asOf) conditions.push(lte(journalEntries.entryDate, params.asOf));
  if (params.from) conditions.push(gte(journalEntries.entryDate, params.from));

  const row = db
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .get();

  return signedBalance(account.type, row?.debit ?? 0, row?.credit ?? 0);
}

/** Balances for several system accounts at once, for dashboards. */
export function balancesBySystemKey(
  db: AppDatabase,
  params: { companyId: string; keys: string[]; asOf?: IsoDate },
): Record<string, number> {
  const accountRows = db.select({ id: accounts.id, key: accounts.systemKey, type: accounts.type })
    .from(accounts)
    .where(and(
      eq(accounts.companyId, params.companyId),
      inArray(accounts.systemKey, params.keys),
    )).all();

  const result: Record<string, number> = {};
  for (const account of accountRows) {
    if (!account.key) continue;
    result[account.key] = accountBalance(db, {
      companyId: params.companyId,
      accountId: account.id,
      asOf: params.asOf,
    });
  }
  return result;
}

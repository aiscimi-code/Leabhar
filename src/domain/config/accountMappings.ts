import { and, eq, lte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, accountMappings, auditEvents, journalEntries, journalLines } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import type { IsoDate } from '../dates';
import { ConfigurationError } from './mutations';

/**
 * Mapping Leabhar accounts onto an external chart (issue #362).
 *
 * Only bank-statement *column* mappings existed before this — there was no way
 * to say "our 4000 is the accountant's 400", so a trial balance handed over for
 * the annual accounts still had to be re-coded by hand.
 *
 * A mapping is a recorded correspondence, not a re-posting: figures stay in the
 * Leabhar ledger, and the mapped trial balance presents the same balances under
 * the external chart's codes. Accounts with no mapping are listed with a blank
 * external code rather than dropped — a figure that quietly disappears from an
 * export is worse than one the recipient has to code themselves.
 */

export interface AccountMapping {
  id: string;
  accountId: string;
  code: string;
  name: string;
  chartName: string;
  externalCode: string;
  externalName: string | null;
  notes: string | null;
}

function requireAccount(
  db: AppDatabase, companyId: string, accountId: string,
): { id: string; code: string; name: string } {
  const account = db.select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId))).get();
  if (!account) throw new ConfigurationError(`Account ${accountId} not found.`);
  return account;
}

/**
 * Record (or replace) one account's mapping in one external chart. Replacing is
 * an overwrite of the correspondence, not of any figure — the previous mapping
 * is kept in the audit trail with its before and after values.
 */
export function setAccountMapping(
  db: AppDatabase,
  params: {
    companyId: string;
    accountId: string;
    chartName: string;
    externalCode: string;
    externalName?: string | null;
    notes?: string | null;
    actor?: string;
  },
): AccountMapping {
  const chartName = params.chartName?.trim();
  const externalCode = params.externalCode?.trim();
  if (!chartName) {
    throw new ConfigurationError(
      'A mapping needs the name of the external chart it belongs to, so two charts '
        + 'cannot be confused with each other.',
    );
  }
  if (!externalCode) {
    throw new ConfigurationError(
      'A mapping needs the account\'s code in the external chart. An account deliberately '
        + 'left unmapped is simply not mapped — that is the correct state, not a blank code.',
    );
  }
  const account = requireAccount(db, params.companyId, params.accountId);

  const existing = db.select().from(accountMappings)
    .where(and(
      eq(accountMappings.companyId, params.companyId),
      eq(accountMappings.accountId, account.id),
      eq(accountMappings.chartName, chartName),
    )).get();

  const timestamp = nowIso();
  db.transaction((tx) => {
    if (existing) {
      tx.update(accountMappings).set({
        externalCode,
        externalName: params.externalName?.trim() || null,
        notes: params.notes?.trim() || null,
        updatedAt: timestamp,
      }).where(eq(accountMappings.id, existing.id)).run();
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'account_mapping', entityId: existing.id,
        action: 'mapped', field: chartName,
        previousValue: `${existing.externalCode} ${existing.externalName ?? ''}`.trim(),
        newValue: `${externalCode} ${params.externalName?.trim() ?? ''}`.trim(),
        source: 'user', actor: params.actor ?? 'user',
      }).run();
    } else {
      const id = ids.accountMapping();
      tx.insert(accountMappings).values({
        id,
        companyId: params.companyId,
        accountId: account.id,
        chartName,
        externalCode,
        externalName: params.externalName?.trim() || null,
        notes: params.notes?.trim() || null,
      }).run();
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'account_mapping', entityId: id,
        action: 'mapped', field: chartName,
        previousValue: '',
        newValue: `${externalCode} ${params.externalName?.trim() ?? ''}`.trim(),
        source: 'user', actor: params.actor ?? 'user',
      }).run();
    }
  });

  return {
    id: existing?.id ?? '',
    accountId: account.id,
    code: account.code,
    name: account.name,
    chartName,
    externalCode,
    externalName: params.externalName?.trim() || null,
    notes: params.notes?.trim() || null,
  };
}

/** Remove an account's mapping in one chart. The correspondence is a record, so its removal is audited. */
export function clearAccountMapping(
  db: AppDatabase,
  params: { companyId: string; accountId: string; chartName: string; actor?: string },
): void {
  const existing = db.select().from(accountMappings)
    .where(and(
      eq(accountMappings.companyId, params.companyId),
      eq(accountMappings.accountId, params.accountId),
      eq(accountMappings.chartName, params.chartName.trim()),
    )).get();
  if (!existing) {
    throw new ConfigurationError(
      `No mapping of account ${params.accountId} in the chart "${params.chartName.trim()}" `
        + 'to remove.',
    );
  }

  db.transaction((tx) => {
    tx.delete(accountMappings).where(eq(accountMappings.id, existing.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'account_mapping', entityId: existing.id,
      action: 'unmapped', field: existing.chartName,
      previousValue: `${existing.externalCode} ${existing.externalName ?? ''}`.trim(),
      newValue: '',
      source: 'user', actor: params.actor ?? 'user',
    }).run();
  });
}

/** All mappings, or one chart's, each with its Leabhar account's code and name. */
export function listAccountMappings(
  db: AppDatabase, params: { companyId: string; chartName?: string },
): AccountMapping[] {
  const conditions = [eq(accountMappings.companyId, params.companyId)];
  if (params.chartName) conditions.push(eq(accountMappings.chartName, params.chartName.trim()));
  return db.select({
    id: accountMappings.id,
    accountId: accountMappings.accountId,
    code: accounts.code,
    name: accounts.name,
    chartName: accountMappings.chartName,
    externalCode: accountMappings.externalCode,
    externalName: accountMappings.externalName,
    notes: accountMappings.notes,
  }).from(accountMappings)
    .innerJoin(accounts, eq(accountMappings.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(accountMappings.chartName, accountMappings.externalCode)
    .all();
}

export interface MappedTrialBalanceRow {
  externalCode: string | null;
  externalName: string | null;
  code: string;
  name: string;
  type: string;
  reportSection: string | null;
  debitMinor: number;
  creditMinor: number;
  lineCount: number;
}

export interface MappedTrialBalance {
  companyId: string;
  chartName: string;
  asOf: IsoDate;
  /** Debit and credit totals in the external chart's own codes — these must agree. */
  totalDebitMinor: number;
  totalCreditMinor: number;
  rows: MappedTrialBalanceRow[];
  /** Accounts with balances but no mapping in this chart, so nothing is silently dropped. */
  unmapped: Array<{ code: string; name: string; balanceMinor: number }>;
}

/**
 * The trial balance restated in an external chart's codes (issue #362): the
 * same posted balances, presented under the mapping. Unmapped accounts appear
 * with their Leabhar code and a blank external code — a balance that vanishes
 * from an export without trace is the one mistake this exists to prevent.
 */
export function mappedTrialBalance(
  db: AppDatabase,
  params: { companyId: string; chartName: string; asOf: IsoDate },
): MappedTrialBalance {
  const chartName = params.chartName.trim();
  if (!chartName) throw new ConfigurationError('Name the external chart to present.');

  const mappings = new Map(
    listAccountMappings(db, { companyId: params.companyId, chartName })
      .map((m) => [m.accountId, m]),
  );

  const rows = db.select({
    accountId: accounts.id,
    code: accounts.code,
    name: accounts.name,
    type: accounts.type,
    reportSection: accounts.reportSection,
    debitMinor: sql<number>`COALESCE(SUM(${journalLines.baseDebitMinor}), 0)`,
    creditMinor: sql<number>`COALESCE(SUM(${journalLines.baseCreditMinor}), 0)`,
    lineCount: sql<number>`COUNT(${journalLines.id})`,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(
      eq(journalLines.companyId, params.companyId),
      eq(journalEntries.isPosted, true),
      lte(journalEntries.entryDate, params.asOf),
    ))
    .groupBy(
      accounts.id, accounts.code, accounts.name, accounts.type, accounts.reportSection,
    )
    .orderBy(accounts.code)
    .all();

  const mappedRows: MappedTrialBalanceRow[] = rows.map((row) => {
    const mapping = mappings.get(row.accountId);
    return {
      externalCode: mapping?.externalCode ?? null,
      externalName: mapping?.externalName ?? null,
      code: row.code,
      name: row.name,
      type: row.type,
      reportSection: row.reportSection,
      debitMinor: row.debitMinor,
      creditMinor: row.creditMinor,
      lineCount: row.lineCount,
    };
  });

  return {
    companyId: params.companyId,
    chartName,
    asOf: params.asOf,
    totalDebitMinor: mappedRows.reduce((sum, r) => sum + r.debitMinor, 0),
    totalCreditMinor: mappedRows.reduce((sum, r) => sum + r.creditMinor, 0),
    rows: mappedRows,
    unmapped: mappedRows
      .filter((r) => r.externalCode === null && r.debitMinor !== r.creditMinor)
      .map((r) => ({ code: r.code, name: r.name, balanceMinor: r.debitMinor - r.creditMinor })),
  };
}

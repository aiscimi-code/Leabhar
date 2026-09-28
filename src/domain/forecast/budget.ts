/**
 * Company budget and budget vs actual (issue #569, epic #333).
 *
 * A company budget is an amount per account per month for a financial year,
 * versioned: a revision is a new version with its date and reason, never an
 * overwrite (AGENTS.md #6). One version is marked current; earlier versions
 * stay readable.
 *
 * Budget vs actual reads actuals from incomeExpenseByMonth, with variances.
 *
 * Nothing is posted.
 */

import { and, eq, lte, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companyBudgets, companyBudgetLines, accounts, companies, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, startOfMonth, addMonths, type IsoDate } from '../dates';
import { incomeExpenseByMonth } from '../reports/analysis';
import { ForecastError } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetLineInput {
  accountId: string;
  /** ISO month start, e.g. '2026-01-01' */
  monthStart: string;
  /** Budgeted amount in base minor units (positive for income and expense) */
  amountMinor: number;
}

export interface BudgetSummary {
  id: string;
  financialYearEnd: string;
  version: number;
  name: string;
  status: 'current' | 'superseded';
  source: 'entered' | 'import' | 'copied_actuals' | 'copied_budget';
  reason: string | null;
  recordedBy: string;
  createdAt: string;
  lineCount: number;
}

export interface BudgetVsActualLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  months: Array<{
    monthStart: string;
    budgetMinor: number;
    actualMinor: number;
    varianceMinor: number;
    variancePct: number | null;
  }>;
  totalBudgetMinor: number;
  totalActualMinor: number;
  totalVarianceMinor: number;
}

// ---------------------------------------------------------------------------
// Create a new budget version
// ---------------------------------------------------------------------------

export function createCompanyBudget(
  db: AppDatabase,
  params: {
    companyId: string;
    financialYearEnd: string;
    name: string;
    source: 'entered' | 'import' | 'copied_actuals' | 'copied_budget';
    reason?: string | null;
    lines: BudgetLineInput[];
    recordedBy: string;
  },
): string {
  if (!params.name.trim()) throw new ForecastError('A budget needs a name.');
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording this budget.');
  if (params.lines.length === 0) throw new ForecastError('A budget needs at least one line.');

  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ForecastError(`Company ${params.companyId} not found.`);

  // Validate account IDs and amounts
  for (const line of params.lines) {
    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, params.companyId))).get();
    if (!account) throw new ForecastError(`Account ${line.accountId} not found.`);
    if (!Number.isInteger(line.amountMinor) || line.amountMinor < 0) {
      throw new ForecastError(`Budget amount for account ${line.accountId} must be a non-negative integer in minor units.`);
    }
  }

  // Find next version number for this year
  const existing = db.select().from(companyBudgets)
    .where(and(
      eq(companyBudgets.companyId, params.companyId),
      eq(companyBudgets.financialYearEnd, params.financialYearEnd),
    )).all();
  const maxVersion = existing.reduce((max, b) => Math.max(max, b.version), 0);
  const version = maxVersion + 1;

  const id = ids.companyBudget();
  db.transaction(() => {
    // Supersede the current version
    for (const prev of existing.filter((b) => b.status === 'current')) {
      db.update(companyBudgets).set({ status: 'superseded', updatedAt: nowIso() })
        .where(eq(companyBudgets.id, prev.id)).run();
    }

    db.insert(companyBudgets).values({
      id, companyId: params.companyId, financialYearEnd: params.financialYearEnd,
      version, name: params.name.trim(), status: 'current', source: params.source,
      reason: params.reason ?? null, recordedBy: params.recordedBy,
    }).run();

    for (const line of params.lines) {
      db.insert(companyBudgetLines).values({
        id: ids.companyBudgetLine(), budgetId: id, companyId: params.companyId,
        accountId: line.accountId, monthStart: line.monthStart, amountMinor: line.amountMinor,
      }).run();
    }

    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'company_budget', entityId: id, action: 'created',
      newValue: JSON.stringify({ version, name: params.name, financialYearEnd: params.financialYearEnd, lines: params.lines.length }),
      source: 'user', actor: params.recordedBy,
    }).run();
  });
  return id;
}

// ---------------------------------------------------------------------------
// Copy from actuals or previous budget
// ---------------------------------------------------------------------------

/**
 * Copy last year's actuals or a previous budget into a new budget version.
 * `adjustmentBasisPoints`: optional overall adjustment (positive = increase).
 * `perAccountAdjustments`: optional per-account adjustments, overrides overall.
 */
export function copyBudget(
  db: AppDatabase,
  params: {
    companyId: string;
    financialYearEnd: string;
    name: string;
    reason: string;
    source: 'copied_actuals' | 'copied_budget';
    /** For copied_actuals: the year to copy from (YYYY). */
    fromYear?: number;
    /** For copied_budget: the budget id to copy from. */
    fromBudgetId?: string;
    adjustmentBasisPoints?: number;
    perAccountAdjustments?: Record<string, number>;
    recordedBy: string;
  },
): string {
  let sourceLines: BudgetLineInput[] = [];

  if (params.source === 'copied_actuals') {
    if (!params.fromYear) throw new ForecastError('Specify the year to copy actuals from.');
    // Read actuals from incomeExpenseByMonth for the given year
    const from = asIsoDate(`${params.fromYear}-01-01`);
    const to = asIsoDate(`${params.fromYear}-12-31`);
    const report = incomeExpenseByMonth(db, { companyId: params.companyId, from, to });
    const allActualRows = [...report.income, ...report.expenses];
    for (const row of allActualRows) {
      report.months.forEach((m, i) => {
        const amountMinor = Math.abs(row.byMonthMinor[i] ?? 0);
        if (amountMinor !== 0) {
          sourceLines.push({ accountId: row.accountId, monthStart: `${m}-01`, amountMinor });
        }
      });
    }
  } else {
    if (!params.fromBudgetId) throw new ForecastError('Specify the budget to copy from.');
    const lines = db.select().from(companyBudgetLines)
      .where(eq(companyBudgetLines.budgetId, params.fromBudgetId)).all();
    sourceLines = lines.map((l) => ({ accountId: l.accountId, monthStart: l.monthStart, amountMinor: l.amountMinor }));
  }

  // Apply adjustments
  const adjusted = sourceLines.map((line) => {
    const perAccount = params.perAccountAdjustments?.[line.accountId];
    const bp = perAccount ?? params.adjustmentBasisPoints ?? 0;
    const adjusted = Math.round(line.amountMinor * (1 + bp / 10_000));
    return { ...line, amountMinor: adjusted };
  });

  return createCompanyBudget(db, {
    companyId: params.companyId,
    financialYearEnd: params.financialYearEnd,
    name: params.name,
    source: params.source,
    reason: params.reason,
    lines: adjusted,
    recordedBy: params.recordedBy,
  });
}

// ---------------------------------------------------------------------------
// Budget vs actual
// ---------------------------------------------------------------------------

export function budgetVsActual(
  db: AppDatabase,
  params: {
    companyId: string;
    budgetId: string;
    from: IsoDate;
    to: IsoDate;
  },
): { lines: BudgetVsActualLine[]; totalBudgetMinor: number; totalActualMinor: number; totalVarianceMinor: number } {
  const budget = db.select().from(companyBudgets)
    .where(and(eq(companyBudgets.id, params.budgetId), eq(companyBudgets.companyId, params.companyId))).get();
  if (!budget) throw new ForecastError(`Budget ${params.budgetId} not found.`);

  const budgetLines = db.select().from(companyBudgetLines)
    .where(eq(companyBudgetLines.budgetId, params.budgetId)).all();

  // Actuals by account by month
  const report = incomeExpenseByMonth(db, { companyId: params.companyId, from: params.from, to: params.to });
  // report.months is ['YYYY-MM', ...]; map to 'YYYY-MM-01' for month start
  const actualByAccountMonth = new Map<string, number>();
  const allRows = [...report.income, ...report.expenses];
  for (const row of allRows) {
    report.months.forEach((m, i) => {
      const monthStart = `${m}-01`;
      actualByAccountMonth.set(`${row.accountId}:${monthStart}`, row.byMonthMinor[i] ?? 0);
    });
  }

  // Build months in range (as 'YYYY-MM-01' strings)
  const months: string[] = [];
  let cursor = startOfMonth(params.from);
  while (cursor <= params.to) {
    months.push(cursor);
    cursor = startOfMonth(addMonths(cursor, 1));
  }

  // Group budget lines by account
  const byAccount = new Map<string, Map<string, number>>();
  for (const line of budgetLines) {
    if (!byAccount.has(line.accountId)) byAccount.set(line.accountId, new Map());
    byAccount.get(line.accountId)!.set(line.monthStart, line.amountMinor);
  }

  const chart = db.select().from(accounts).where(eq(accounts.companyId, params.companyId)).all();
  const byId = new Map(chart.map((a) => [a.id, a]));

  const lines: BudgetVsActualLine[] = [];
  for (const [accountId, budgetByMonth] of byAccount) {
    const account = byId.get(accountId);
    if (!account) continue;
    const monthLines = months.map((monthStart) => {
      const budgetMinor = budgetByMonth.get(monthStart) ?? 0;
      const actualMinor = actualByAccountMonth.get(`${accountId}:${monthStart}`) ?? 0;
      const varianceMinor = actualMinor - budgetMinor;
      const variancePct = budgetMinor !== 0 ? Math.round((varianceMinor / budgetMinor) * 10_000) / 100 : null;
      return { monthStart, budgetMinor, actualMinor, varianceMinor, variancePct };
    });
    const totalBudget = monthLines.reduce((s, m) => s + m.budgetMinor, 0);
    const totalActual = monthLines.reduce((s, m) => s + m.actualMinor, 0);
    lines.push({
      accountId,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      months: monthLines,
      totalBudgetMinor: totalBudget,
      totalActualMinor: totalActual,
      totalVarianceMinor: totalActual - totalBudget,
    });
  }

  lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  const totalBudgetMinor = lines.reduce((s, l) => s + l.totalBudgetMinor, 0);
  const totalActualMinor = lines.reduce((s, l) => s + l.totalActualMinor, 0);

  return { lines, totalBudgetMinor, totalActualMinor, totalVarianceMinor: totalActualMinor - totalBudgetMinor };
}

// ---------------------------------------------------------------------------
// List budgets
// ---------------------------------------------------------------------------

export function listBudgets(
  db: AppDatabase, params: { companyId: string },
): BudgetSummary[] {
  const budgets = db.select().from(companyBudgets)
    .where(eq(companyBudgets.companyId, params.companyId))
    .orderBy(desc(companyBudgets.financialYearEnd), desc(companyBudgets.version))
    .all();
  return budgets.map((b) => {
    const lineCount = db.select().from(companyBudgetLines).where(eq(companyBudgetLines.budgetId, b.id)).all().length;
    return {
      id: b.id, financialYearEnd: b.financialYearEnd, version: b.version, name: b.name,
      status: b.status, source: b.source, reason: b.reason, recordedBy: b.recordedBy, createdAt: b.createdAt, lineCount,
    };
  });
}

/**
 * The company budget (issue #569, epic #333).
 *
 * A budget is an amount per income or expense account per month of one
 * financial year, in base minor units and the account's natural direction
 * (income and expense both positive). It is entered, imported from a CSV, or
 * copied from last year's actuals or an earlier budget with percentage
 * changes (decisions on #333). A new budget for the same year is the next
 * version; the earlier one is marked superseded and its lines are kept.
 *
 * Budget against actual reads the posted ledger through the same report the
 * income and expense screens use (`incomeExpenseByMonth`).
 */

import Papa from 'papaparse';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, companies, companyBudgetLines, companyBudgets } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, addMonths, addYears, asIsoDate, endOfMonth, isIsoDate, type IsoDate } from '../dates';
import { isAmbiguousAmount, MoneyError, multiplyRational, parseAmount } from '../money';
import { atomically } from '../accounting/journal';
import { incomeExpenseByMonth } from '../reports/analysis';
import { ForecastError } from './types';

export type CompanyBudget = typeof companyBudgets.$inferSelect;
export interface BudgetLineInput { accountId: string; monthStart: string; amountMinor: number }

/** The twelve month starts of the financial year ending `financialYearEnd`. */
export function budgetMonths(financialYearEnd: IsoDate): IsoDate[] {
  const first = addDays(addYears(financialYearEnd, -1), 1);
  const start = asIsoDate(`${first.slice(0, 7)}-01`);
  return Array.from({ length: 12 }, (_, i) => addMonths(start, i));
}

function checkYearEnd(financialYearEnd: string): IsoDate {
  if (!isIsoDate(financialYearEnd) || endOfMonth(financialYearEnd as IsoDate) !== financialYearEnd) {
    throw new ForecastError('The financial year end is the last day of a month, YYYY-MM-DD.');
  }
  return financialYearEnd as IsoDate;
}

function budgetAccounts(db: AppDatabase, companyId: string) {
  return db.select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), inArray(accounts.type, ['income', 'expense']))).all();
}

function saveBudget(db: AppDatabase, params: {
  companyId: string; financialYearEnd: string; name: string; recordedBy: string; reason?: string | null;
  source: CompanyBudget['source']; adjustments?: unknown; lines: BudgetLineInput[];
}): CompanyBudget {
  const fye = checkYearEnd(params.financialYearEnd);
  if (!params.name.trim()) throw new ForecastError('Name the budget.');
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording the budget.');
  const company = db.select({ id: companies.id }).from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ForecastError(`Company ${params.companyId} not found.`);
  const months = new Set<string>(budgetMonths(fye));
  const chart = new Map(budgetAccounts(db, params.companyId).map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const l of params.lines) {
    if (!chart.has(l.accountId)) throw new ForecastError(`Account ${l.accountId} is not one of this company's income or expense accounts.`);
    if (!months.has(l.monthStart)) throw new ForecastError(`${l.monthStart} is not the start of a month in the year ending ${fye}.`);
    if (!Number.isInteger(l.amountMinor)) throw new ForecastError('Budget amounts are whole numbers of cents.');
    const k = `${l.accountId}:${l.monthStart}`;
    if (seen.has(k)) throw new ForecastError(`${chart.get(l.accountId)!.code} ${l.monthStart} is given twice.`);
    seen.add(k);
  }
  const id = ids.companyBudget();
  atomically(db, () => {
    const prior = db.select().from(companyBudgets).where(and(
      eq(companyBudgets.companyId, params.companyId), eq(companyBudgets.financialYearEnd, fye),
    )).orderBy(desc(companyBudgets.version)).get();
    if (prior?.status === 'current') {
      db.update(companyBudgets).set({ status: 'superseded' }).where(eq(companyBudgets.id, prior.id)).run();
    }
    db.insert(companyBudgets).values({
      id, companyId: params.companyId, financialYearEnd: fye, version: (prior?.version ?? 0) + 1, name: params.name.trim(),
      status: 'current', source: params.source, reason: params.reason ?? null,
      adjustmentsJson: params.adjustments === undefined ? null : JSON.stringify(params.adjustments), recordedBy: params.recordedBy,
    }).run();
    for (const l of params.lines.filter((x) => x.amountMinor !== 0)) {
      db.insert(companyBudgetLines).values({
        id: ids.companyBudgetLine(), budgetId: id, companyId: params.companyId, accountId: l.accountId, monthStart: l.monthStart, amountMinor: l.amountMinor,
      }).run();
    }
  });
  return db.select().from(companyBudgets).where(eq(companyBudgets.id, id)).get()!;
}

/** A budget a person entered. */
export function createBudget(db: AppDatabase, params: {
  companyId: string; financialYearEnd: string; name: string; recordedBy: string; reason?: string | null; lines: BudgetLineInput[];
}): CompanyBudget {
  return saveBudget(db, { ...params, source: 'entered' });
}

/**
 * Import a budget from CSV: an `account` column (the account code or its exact
 * name), then one column per month headed YYYY-MM. Every row is checked
 * before anything is saved; an unknown account or a bad amount stops the import.
 */
export function importBudgetCsv(db: AppDatabase, params: {
  companyId: string; financialYearEnd: string; name: string; recordedBy: string; reason?: string | null; csv: string;
}): CompanyBudget {
  const fye = checkYearEnd(params.financialYearEnd);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ForecastError(`Company ${params.companyId} not found.`);
  const parsed = Papa.parse<Record<string, string>>(params.csv.replace(/^﻿/, ''), {
    header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim(),
  });
  const headers = parsed.meta.fields ?? [];
  const accountColumn = headers.find((h) => h.toLowerCase() === 'account');
  if (!accountColumn) throw new ForecastError('The CSV needs an "account" column.');
  const months = budgetMonths(fye);
  const monthColumns = headers.filter((h) => h !== accountColumn);
  const unknownMonths = monthColumns.filter((h) => !months.some((m) => m.startsWith(`${h}-`)));
  if (unknownMonths.length) throw new ForecastError(`These columns are not months of the year ending ${fye}: ${unknownMonths.join(', ')}.`);
  const chart = budgetAccounts(db, params.companyId);
  const errors: string[] = [];
  const lines: BudgetLineInput[] = [];
  parsed.data.forEach((row, i) => {
    const ref = (row[accountColumn] ?? '').trim();
    const account = chart.find((a) => a.code === ref) ?? chart.find((a) => a.name.toLowerCase() === ref.toLowerCase());
    if (!account) { errors.push(`Row ${i + 2}: "${ref}" is not an income or expense account of this company.`); return; }
    for (const h of monthColumns) {
      const text = (row[h] ?? '').trim();
      if (!text) continue;
      if (isAmbiguousAmount(text, company.baseCurrency)) {
        errors.push(`Row ${i + 2}, ${h}: "${text}" could be read two ways; write it with a decimal point and no thousands separator.`);
        continue;
      }
      try {
        lines.push({ accountId: account.id, monthStart: `${h}-01`, amountMinor: parseAmount(text, company.baseCurrency) });
      } catch (e) {
        if (!(e instanceof MoneyError)) throw e;
        errors.push(`Row ${i + 2}, ${h}: ${e.message}`);
      }
    }
  });
  if (errors.length) throw new ForecastError(`The budget was not imported:\n${errors.join('\n')}`);
  return saveBudget(db, { ...params, source: 'import', lines });
}

export interface BudgetAdjustments {
  /** A change applied to every account, in basis points (+500 is 5% more). */
  allBasisPoints?: number;
  /** A change for one account, in place of the overall one. */
  byAccount?: Record<string, number>;
}

function adjust(amount: number, accountId: string, a: BudgetAdjustments | undefined): number {
  const bp = a?.byAccount?.[accountId] ?? a?.allBasisPoints ?? 0;
  if (!Number.isInteger(bp) || bp < -10_000) throw new ForecastError('A change is a whole number of basis points, not below -100%.');
  return bp === 0 ? amount : multiplyRational(amount, 10_000 + bp, 10_000);
}

/**
 * Copy a budget from the year before's posted actuals, or from an earlier
 * budget, each month moved on a year, with percentage changes.
 */
export function copyBudget(db: AppDatabase, params: {
  companyId: string; financialYearEnd: string; name: string; recordedBy: string; reason?: string | null;
  from: { kind: 'actuals' } | { kind: 'budget'; budgetId: string }; adjustments?: BudgetAdjustments;
}): CompanyBudget {
  const fye = checkYearEnd(params.financialYearEnd);
  const lines: BudgetLineInput[] = [];
  if (params.from.kind === 'actuals') {
    const priorEnd = endOfMonth(addYears(fye, -1));
    const priorStart = budgetMonths(priorEnd)[0]!;
    const report = incomeExpenseByMonth(db, { companyId: params.companyId, from: priorStart, to: priorEnd });
    for (const row of [...report.income, ...report.expenses]) {
      row.byMonthMinor.forEach((amount, i) => {
        if (amount === 0) return;
        lines.push({ accountId: row.accountId, monthStart: addYears(asIsoDate(`${report.months[i]}-01`), 1), amountMinor: adjust(amount, row.accountId, params.adjustments) });
      });
    }
  } else {
    const source = db.select().from(companyBudgets)
      .where(and(eq(companyBudgets.id, params.from.budgetId), eq(companyBudgets.companyId, params.companyId))).get();
    if (!source) throw new ForecastError(`Budget ${params.from.budgetId} not found.`);
    const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    const shift = monthIndex(fye) - monthIndex(source.financialYearEnd);
    for (const l of db.select().from(companyBudgetLines).where(eq(companyBudgetLines.budgetId, source.id)).all()) {
      lines.push({ accountId: l.accountId, monthStart: addMonths(l.monthStart as IsoDate, shift), amountMinor: adjust(l.amountMinor, l.accountId, params.adjustments) });
    }
  }
  return saveBudget(db, {
    ...params, source: params.from.kind === 'actuals' ? 'copied_actuals' : 'copied_budget',
    adjustments: { from: params.from, ...params.adjustments }, lines,
  });
}

export function listBudgets(db: AppDatabase, companyId: string): CompanyBudget[] {
  return db.select().from(companyBudgets).where(eq(companyBudgets.companyId, companyId))
    .orderBy(desc(companyBudgets.financialYearEnd), desc(companyBudgets.version)).all();
}

export interface BudgetVsActual {
  budget: CompanyBudget;
  months: string[];
  /** Up to and including this date the actuals are posted; later months show no actual. */
  actualTo: IsoDate;
  rows: Array<{
    accountId: string; code: string; name: string; type: 'income' | 'expense';
    budgetByMonthMinor: number[]; actualByMonthMinor: Array<number | null>;
    budgetMinor: number; actualMinor: number; budgetToDateMinor: number;
    /** Actual less budget to date: for income, positive is better; for expense, positive is worse. */
    varianceMinor: number;
  }>;
  totals: { incomeBudgetToDateMinor: number; incomeActualMinor: number; expenseBudgetToDateMinor: number; expenseActualMinor: number };
}

/** A budget against the posted actuals up to `asOf` (each month compared only once it has started). */
export function budgetVsActual(db: AppDatabase, params: { companyId: string; budgetId: string; asOf: IsoDate }): BudgetVsActual {
  const budget = db.select().from(companyBudgets)
    .where(and(eq(companyBudgets.id, params.budgetId), eq(companyBudgets.companyId, params.companyId))).get();
  if (!budget) throw new ForecastError(`Budget ${params.budgetId} not found.`);
  const monthStarts = budgetMonths(budget.financialYearEnd as IsoDate);
  const months = monthStarts.map((m) => m.slice(0, 7));
  const actualTo = (params.asOf < budget.financialYearEnd ? params.asOf : budget.financialYearEnd) as IsoDate;
  const report = actualTo >= monthStarts[0]!
    ? incomeExpenseByMonth(db, { companyId: params.companyId, from: monthStarts[0]!, to: actualTo })
    : null;
  const actualRows = new Map([...(report?.income ?? []), ...(report?.expenses ?? [])].map((r) => [r.accountId, r]));
  const lines = db.select().from(companyBudgetLines).where(eq(companyBudgetLines.budgetId, budget.id)).all();
  const chart = budgetAccounts(db, params.companyId);
  const used = new Set([...lines.map((l) => l.accountId), ...actualRows.keys()]);
  const rows = chart.filter((a) => used.has(a.id)).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
    const budgetByMonthMinor = monthStarts.map((m) => lines.find((l) => l.accountId === a.id && l.monthStart === m)?.amountMinor ?? 0);
    const actual = actualRows.get(a.id);
    const actualByMonthMinor = months.map((m, i) => {
      if (monthStarts[i]! > actualTo) return null;
      const idx = report?.months.indexOf(m) ?? -1;
      return idx >= 0 && actual ? actual.byMonthMinor[idx]! : 0;
    });
    const started = actualByMonthMinor.map((v) => v !== null);
    const budgetToDateMinor = budgetByMonthMinor.reduce((s, v, i) => s + (started[i] ? v : 0), 0);
    const actualMinor = actualByMonthMinor.reduce<number>((s, v) => s + (v ?? 0), 0);
    return {
      accountId: a.id, code: a.code, name: a.name, type: a.type as 'income' | 'expense',
      budgetByMonthMinor, actualByMonthMinor, budgetMinor: budgetByMonthMinor.reduce((s, v) => s + v, 0),
      actualMinor, budgetToDateMinor, varianceMinor: actualMinor - budgetToDateMinor,
    };
  });
  const sumOf = (type: 'income' | 'expense', f: 'budgetToDateMinor' | 'actualMinor') =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + r[f], 0);
  return {
    budget, months, actualTo, rows,
    totals: {
      incomeBudgetToDateMinor: sumOf('income', 'budgetToDateMinor'), incomeActualMinor: sumOf('income', 'actualMinor'),
      expenseBudgetToDateMinor: sumOf('expense', 'budgetToDateMinor'), expenseActualMinor: sumOf('expense', 'actualMinor'),
    },
  };
}

export function budgetLines(db: AppDatabase, budgetId: string) {
  return db.select().from(companyBudgetLines).where(eq(companyBudgetLines.budgetId, budgetId))
    .orderBy(asc(companyBudgetLines.accountId), asc(companyBudgetLines.monthStart)).all();
}

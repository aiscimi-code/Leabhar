import { and, eq, gte, lte, sql, isNotNull, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, companies, customers, invoices, journalEntries, journalLines, suppliers } from '@/db/schema';
import { signedBalance } from '../config/chartOfAccounts';
import { addYears, endOfMonth, parts, type IsoDate } from '../dates';
import { profitAndLoss, balanceSheet } from './financial';
import type { Explained } from './explain';

/**
 * Comparative statements and income and expense analysis (issue #553).
 * Each is read from the same domain figures as the statements themselves, so
 * the comparative column for a year is exactly what that year's statement
 * said, and the monthly analysis totals to the profit and loss account.
 */

export interface ComparativeRow {
  label: string;
  /** 0 for a section or total, 1 for an account within a section. */
  depth: 0 | 1;
  isTotal: boolean;
  accountId?: string;
  currentMinor: number;
  priorMinor: number;
  changeMinor: number;
}

export interface ComparativeStatements {
  companyId: string;
  currency: string;
  current: { from: IsoDate; to: IsoDate };
  prior: { from: IsoDate; to: IsoDate };
  profitAndLoss: ComparativeRow[];
  balanceSheet: ComparativeRow[];
  balances: { current: boolean; prior: boolean };
}

/** The same period a year earlier. A period ending on a month end ends on that month's end (29 February included). */
export function priorYearPeriod(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate } {
  const priorTo = to === endOfMonth(to) ? endOfMonth(addYears(to, -1)) : addYears(to, -1);
  return { from: addYears(from, -1), to: priorTo };
}

export function comparativeStatements(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): ComparativeStatements {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const prior = priorYearPeriod(params.from, params.to);
  const plNow = profitAndLoss(db, { companyId: params.companyId, from: params.from, to: params.to });
  const plThen = profitAndLoss(db, { companyId: params.companyId, from: prior.from, to: prior.to });
  const bsNow = balanceSheet(db, { companyId: params.companyId, asOf: params.to, financialYearStart: params.from });
  const bsThen = balanceSheet(db, { companyId: params.companyId, asOf: prior.to, financialYearStart: prior.from });

  const pl: ComparativeRow[] = [
    ...section(plNow.revenue, plThen.revenue), ...section(plNow.costOfSales, plThen.costOfSales),
    total('Gross profit', plNow.grossProfit, plThen.grossProfit),
    ...section(plNow.operatingExpenses, plThen.operatingExpenses),
    total('Operating profit', plNow.operatingProfit, plThen.operatingProfit),
    ...section(plNow.otherIncome, plThen.otherIncome, true), ...section(plNow.financeCosts, plThen.financeCosts, true),
    total('Net profit', plNow.netProfit, plThen.netProfit),
  ];
  const bs: ComparativeRow[] = [
    ...section(bsNow.fixedAssets, bsThen.fixedAssets), ...section(bsNow.currentAssets, bsThen.currentAssets),
    total('Total assets', bsNow.totalAssets, bsThen.totalAssets),
    ...section(bsNow.currentLiabilities, bsThen.currentLiabilities), ...section(bsNow.longTermLiabilities, bsThen.longTermLiabilities, true),
    total('Net assets', bsNow.netAssets, bsThen.netAssets),
    ...section(bsNow.shareCapital, bsThen.shareCapital), row(0, false, 'Retained earnings', bsNow.retainedEarnings.valueMinor, bsThen.retainedEarnings.valueMinor),
    row(0, false, 'Profit for the period', bsNow.profitForPeriod.valueMinor, bsThen.profitForPeriod.valueMinor),
    total('Total equity', bsNow.totalEquity, bsThen.totalEquity),
  ];
  return {
    companyId: params.companyId, currency: company.baseCurrency, current: { from: params.from, to: params.to }, prior,
    profitAndLoss: pl, balanceSheet: bs, balances: { current: bsNow.balances, prior: bsThen.balances },
  };
}

function row(depth: 0 | 1, isTotal: boolean, label: string, currentMinor: number, priorMinor: number, accountId?: string): ComparativeRow {
  return { label, depth, isTotal, ...(accountId ? { accountId } : {}), currentMinor, priorMinor, changeMinor: currentMinor - priorMinor };
}

function total(label: string, now: Explained, then: Explained): ComparativeRow {
  return row(0, true, label, now.valueMinor, then.valueMinor);
}

/** A section's total and its accounts, matched across the two periods by account. */
function section(now: Explained, then: Explained, omitIfEmpty = false): ComparativeRow[] {
  if (omitIfEmpty && now.components.length === 0 && then.components.length === 0) return [];
  const key = (c: Explained) => c.sources[0]?.entityId ?? c.label;
  const merged = new Map<string, { label: string; accountId?: string; now: number; then: number }>();
  for (const c of then.components) merged.set(key(c), { label: c.label, accountId: c.sources[0]?.entityId, now: 0, then: c.valueMinor });
  for (const c of now.components) {
    const existing = merged.get(key(c));
    if (existing) { existing.now = c.valueMinor; existing.label = c.label; } else merged.set(key(c), { label: c.label, accountId: c.sources[0]?.entityId, now: c.valueMinor, then: 0 });
  }
  const lines = [...merged.values()].sort((a, b) => a.label.localeCompare(b.label));
  return [row(0, false, now.label, now.valueMinor, then.valueMinor), ...lines.map((l) => row(1, false, l.label, l.now, l.then, l.accountId))];
}

// ---------------------------------------------------------------------------

export interface AccountMonthRow {
  accountId: string;
  code: string;
  name: string;
  /** Natural-direction amounts per month, in the order of `months`. */
  byMonthMinor: number[];
  totalMinor: number;
}

export interface IncomeExpenseByMonth {
  companyId: string;
  currency: string;
  from: IsoDate;
  to: IsoDate;
  /** YYYY-MM, every month the period touches. */
  months: string[];
  income: AccountMonthRow[];
  expenses: AccountMonthRow[];
  incomeByMonthMinor: number[];
  expensesByMonthMinor: number[];
  netByMonthMinor: number[];
  totalIncomeMinor: number;
  totalExpensesMinor: number;
  /** Equals the net profit on the profit and loss account for the same period. */
  netMinor: number;
}

/** Income and expense by account by month (issue #553), from posted journal lines, before the year-end close. */
export function incomeExpenseByMonth(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): IncomeExpenseByMonth {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const months: string[] = [];
  for (let { year, month } = parts(params.from); `${year}-${String(month).padStart(2, '0')}` <= params.to.slice(0, 7);) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  const index = new Map(months.map((m, i) => [m, i]));
  const rows = db.select({
    accountId: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type,
    month: sql<string>`substr(${journalEntries.entryDate}, 1, 7)`,
    debit: sql<number>`coalesce(sum(${journalLines.baseDebitMinor}), 0)`,
    credit: sql<number>`coalesce(sum(${journalLines.baseCreditMinor}), 0)`,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(
      eq(journalLines.companyId, params.companyId), eq(journalEntries.isPosted, true),
      gte(journalEntries.entryDate, params.from), lte(journalEntries.entryDate, params.to),
      sql`${accounts.type} IN ('income', 'expense')`,
      sql`${journalEntries.sourceType} <> 'year_end_close'`,
      sql`(${journalEntries.reversalOfId} IS NULL OR ${journalEntries.reversalOfId} NOT IN (
        SELECT closing.id FROM journal_entries AS closing WHERE closing.source_type = 'year_end_close'))`,
    ))
    .groupBy(accounts.id, sql`substr(${journalEntries.entryDate}, 1, 7)`).all();

  const byAccount = new Map<string, AccountMonthRow & { type: string }>();
  for (const r of rows) {
    const entry = byAccount.get(r.accountId) ?? { accountId: r.accountId, code: r.code, name: r.name, type: r.type, byMonthMinor: months.map(() => 0), totalMinor: 0 };
    const amount = signedBalance(r.type, r.debit, r.credit);
    entry.byMonthMinor[index.get(r.month)!]! += amount;
    entry.totalMinor += amount;
    byAccount.set(r.accountId, entry);
  }
  const list = [...byAccount.values()].filter((a) => a.byMonthMinor.some((v) => v !== 0)).sort((a, b) => a.code.localeCompare(b.code));
  const strip = ({ type: _type, ...rest }: AccountMonthRow & { type: string }): AccountMonthRow => rest;
  const income = list.filter((a) => a.type === 'income').map(strip);
  const expenses = list.filter((a) => a.type === 'expense').map(strip);
  const sumBy = (set: AccountMonthRow[]) => months.map((_, i) => set.reduce((s, a) => s + a.byMonthMinor[i]!, 0));
  const incomeByMonthMinor = sumBy(income);
  const expensesByMonthMinor = sumBy(expenses);
  const totalIncomeMinor = income.reduce((s, a) => s + a.totalMinor, 0);
  const totalExpensesMinor = expenses.reduce((s, a) => s + a.totalMinor, 0);
  return {
    companyId: params.companyId, currency: company.baseCurrency, from: params.from, to: params.to, months,
    income, expenses, incomeByMonthMinor, expensesByMonthMinor,
    netByMonthMinor: months.map((_, i) => incomeByMonthMinor[i]! - expensesByMonthMinor[i]!),
    totalIncomeMinor, totalExpensesMinor, netMinor: totalIncomeMinor - totalExpensesMinor,
  };
}

export interface PartyTotal {
  partyId: string | null;
  name: string;
  invoiceCount: number;
  creditNoteCount: number;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}

export interface InvoicesByParty {
  companyId: string;
  currency: string;
  direction: 'sales' | 'purchase';
  from: IsoDate;
  to: IsoDate;
  rows: PartyTotal[];
  total: Omit<PartyTotal, 'partyId' | 'name'>;
  method: string;
}

/**
 * Income by customer, or expense by supplier (issue #553): the invoices posted
 * with an invoice date in the period, in base currency, credit notes taken off.
 * Amounts are as printed (net of VAT); a credit note's sign comes from its type.
 */
export function invoicesByParty(db: AppDatabase, params: { companyId: string; direction: 'sales' | 'purchase'; from: IsoDate; to: IsoDate }): InvoicesByParty {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const rows = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId), eq(invoices.direction, params.direction),
    gte(invoices.invoiceDate, params.from), lte(invoices.invoiceDate, params.to),
    isNotNull(invoices.journalEntryId), notInArray(invoices.status, ['draft', 'void']),
  )).all();
  const names = new Map<string, string>(params.direction === 'sales'
    ? db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, params.companyId)).all().map((c) => [c.id, c.name])
    : db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.companyId, params.companyId)).all().map((s) => [s.id, s.name]));
  const byParty = new Map<string, PartyTotal>();
  for (const inv of rows) {
    const partyId = (params.direction === 'sales' ? inv.customerId : inv.supplierId) ?? null;
    const key = partyId ?? '';
    const entry = byParty.get(key) ?? { partyId, name: partyId ? names.get(partyId) ?? partyId : 'No party recorded', invoiceCount: 0, creditNoteCount: 0, netMinor: 0, vatMinor: 0, grossMinor: 0 };
    // The type carries the sign, whatever the stored figures' (as receivables.ts reads them).
    const sign = inv.isCreditNote ? -1 : 1;
    if (inv.isCreditNote) entry.creditNoteCount += 1; else entry.invoiceCount += 1;
    entry.netMinor += sign * Math.abs(inv.baseNetMinor);
    entry.vatMinor += sign * Math.abs(inv.baseVatMinor);
    entry.grossMinor += sign * Math.abs(inv.baseGrossMinor);
    byParty.set(key, entry);
  }
  const list = [...byParty.values()].sort((a, b) => b.netMinor - a.netMinor || a.name.localeCompare(b.name));
  const sum = (f: (p: PartyTotal) => number) => list.reduce((s, p) => s + f(p), 0);
  return {
    companyId: params.companyId, currency: company.baseCurrency, direction: params.direction, from: params.from, to: params.to, rows: list,
    total: { invoiceCount: sum((p) => p.invoiceCount), creditNoteCount: sum((p) => p.creditNoteCount), netMinor: sum((p) => p.netMinor), vatMinor: sum((p) => p.vatMinor), grossMinor: sum((p) => p.grossMinor) },
    method: `The ${params.direction === 'sales' ? 'sales' : 'purchase'} invoices posted to the ledger with an invoice date from ${params.from} to ${params.to}, in base currency. `
      + 'Credit notes are taken off. Drafts and voided invoices are left out. This counts invoices, not the ledger: a sale or cost booked without an invoice is on the account analysis, not here.',
  };
}

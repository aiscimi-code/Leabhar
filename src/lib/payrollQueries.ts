import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { bankAccounts, bankTransactions, payslips } from '@/db/schema';
import {
  listEmployees, listTerms, listRpns, listPayRuns, payRunTotals, monthlyPayrollSummary, getPayRun, payslipsOfRun,
} from '@/domain/payroll';
import { requireCompany } from './queries';

/**
 * Read models for the payroll screens (EPIC 20). Every figure comes from the
 * payroll domain; these only gather it for a page.
 */

/** Money-out bank lines not yet posted: candidates for paying wages or Revenue. */
function unpostedMoneyOut(companyId: string) {
  return getDb().select({
    id: bankTransactions.id, transactionDate: bankTransactions.transactionDate, description: bankTransactions.description,
    amountMinor: bankTransactions.amountMinor, currency: bankTransactions.currency, bankName: bankAccounts.bankName,
  }).from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankTransactions.bankAccountId, bankAccounts.id))
    .where(and(
      eq(bankTransactions.companyId, companyId), isNull(bankTransactions.journalEntryId),
      ne(bankTransactions.status, 'rolled_back'), sql`${bankTransactions.amountMinor} < 0`,
    )).orderBy(desc(bankTransactions.transactionDate)).limit(200).all();
}

export function payrollPage() {
  const db = getDb();
  const company = requireCompany();
  const employees = listEmployees(db, company.id).map((e) => ({ ...e, terms: listTerms(db, e.id), rpns: listRpns(db, e.id) }));
  const runs = listPayRuns(db, company.id).map((r) => ({ ...r, totals: payRunTotals(db, r.id) }));
  const months = [...new Set(runs.filter((r) => r.status === 'posted').map((r) => r.payDate.slice(0, 7)))].sort().reverse();
  return {
    company,
    employees,
    runs,
    months: months.map((m) => monthlyPayrollSummary(db, company.id, m)),
    bankLines: unpostedMoneyOut(company.id),
  };
}

export function payRunPage(runId: string) {
  const db = getDb();
  const company = requireCompany();
  try {
    const run = getPayRun(db, company.id, runId);
    return { company, run, totals: payRunTotals(db, run.id), payslips: payslipsOfRun(db, run.id), bankLines: unpostedMoneyOut(company.id) };
  } catch {
    return null;
  }
}

export function payslipPage(payslipId: string) {
  const db = getDb();
  const company = requireCompany();
  const row = db.select().from(payslips).where(and(eq(payslips.id, payslipId), eq(payslips.companyId, company.id))).get();
  if (!row) return null;
  const run = getPayRun(db, company.id, row.payRunId);
  const slip = payslipsOfRun(db, run.id).find((p) => p.id === payslipId)!;
  const employee = listEmployees(db, company.id).find((e) => e.id === row.employeeId)!;
  return { company, run, slip, employee };
}

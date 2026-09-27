import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, companies, employees, payRuns, payrollRemittances, payslips, revenuePayrollNotifications,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso, type IsoDate } from '../dates';
import { atomically, assertAccountingPeriodOpen, postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { PayrollError } from './figures';
import { markBankLinePosted, resolvePayment } from './runs';

/**
 * Payroll reports, the monthly remittance to Revenue, and the payroll
 * reconciliation (issue #527). Every figure is summed from the posted
 * payslips; the screens and the CLI render these, never their own sums.
 */

const eur = (minor: number) => (minor / 100).toFixed(2);

export interface PayrollTotals {
  payslips: number;
  grossPayMinor: number;
  notionalPayMinor: number;
  pensionEmployeeMinor: number;
  pensionEmployerMinor: number;
  payForTaxMinor: number;
  taxMinor: number;
  payForUscMinor: number;
  uscMinor: number;
  prsiEmployeeMinor: number;
  /** Employer PRSI and the NTF levy, which Revenue collects with it. */
  prsiEmployerMinor: number;
  netPayMinor: number;
  /** PAYE + USC + all PRSI: what Revenue collects for these payslips. */
  dueToRevenueMinor: number;
}

const TOTALS = {
  payslips: sql<number>`count(*)`,
  grossPayMinor: sql<number>`coalesce(sum(${payslips.grossPayMinor}), 0)`,
  notionalPayMinor: sql<number>`coalesce(sum(${payslips.notionalPayMinor}), 0)`,
  pensionEmployeeMinor: sql<number>`coalesce(sum(${payslips.pensionEmployeeMinor}), 0)`,
  pensionEmployerMinor: sql<number>`coalesce(sum(${payslips.pensionEmployerMinor}), 0)`,
  payForTaxMinor: sql<number>`coalesce(sum(${payslips.payForTaxMinor}), 0)`,
  taxMinor: sql<number>`coalesce(sum(${payslips.taxMinor}), 0)`,
  payForUscMinor: sql<number>`coalesce(sum(${payslips.payForUscMinor}), 0)`,
  uscMinor: sql<number>`coalesce(sum(${payslips.uscMinor}), 0)`,
  prsiEmployeeMinor: sql<number>`coalesce(sum(${payslips.prsiEmployeeMinor}), 0)`,
  prsiEmployerMinor: sql<number>`coalesce(sum(${payslips.prsiEmployerMinor} + ${payslips.ntfLevyMinor}), 0)`,
  netPayMinor: sql<number>`coalesce(sum(${payslips.netPayMinor}), 0)`,
};

function withRevenue(t: Omit<PayrollTotals, 'dueToRevenueMinor'>): PayrollTotals {
  return { ...t, dueToRevenueMinor: t.taxMinor + t.uscMinor + t.prsiEmployeeMinor + t.prsiEmployerMinor };
}

/** Totals of one run's payslips (any status: a draft's are the figures under review). */
export function payRunTotals(db: AppDatabase, runId: string): PayrollTotals {
  return withRevenue(db.select(TOTALS).from(payslips).where(eq(payslips.payRunId, runId)).get()!);
}

/** Posted, unreversed payslips whose pay date is in a month (YYYY-MM). */
function monthWhere(companyId: string, month: string) {
  return and(eq(payRuns.companyId, companyId), eq(payRuns.status, 'posted'), sql`substr(${payRuns.payDate}, 1, 7) = ${month}`);
}

export interface MonthlyPayrollSummary {
  month: string;
  runs: Array<{ id: string; payDate: string; payFrequency: string; periodNumber: number; totals: PayrollTotals }>;
  totals: PayrollTotals;
  /** Draft runs dated in the month: not in the totals until posted. */
  draftRuns: number;
  remittance: typeof payrollRemittances.$inferSelect | null;
}

/**
 * The month's payroll by pay date: what Revenue's monthly statement should
 * show, built from the payroll submissions made on or before each pay date
 * (TDM 42-04-35A, chapter 18).
 */
export function monthlyPayrollSummary(db: AppDatabase, companyId: string, month: string): MonthlyPayrollSummary {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new PayrollError('A month is YYYY-MM.');
  const runs = db.select().from(payRuns).where(monthWhere(companyId, month)).orderBy(asc(payRuns.payDate)).all();
  const drafts = db.select({ n: sql<number>`count(*)` }).from(payRuns)
    .where(and(eq(payRuns.companyId, companyId), eq(payRuns.status, 'draft'), sql`substr(${payRuns.payDate}, 1, 7) = ${month}`)).get()!.n;
  return {
    month,
    runs: runs.map((r) => ({ id: r.id, payDate: r.payDate, payFrequency: r.payFrequency, periodNumber: r.periodNumber, totals: payRunTotals(db, r.id) })),
    totals: withRevenue(db.select(TOTALS).from(payslips).innerJoin(payRuns, eq(payslips.payRunId, payRuns.id)).where(monthWhere(companyId, month)).get()!),
    draftRuns: drafts,
    remittance: db.select().from(payrollRemittances)
      .where(and(eq(payrollRemittances.companyId, companyId), eq(payrollRemittances.month, month))).get() ?? null,
  };
}

/**
 * Pay Revenue a month's PAYE, USC and PRSI: exactly what the month's posted
 * runs credited to the payroll liability accounts. Refused while a run dated
 * in the month is still a draft, or once the month is paid.
 */
export function payPayrollLiabilities(db: AppDatabase, params: {
  companyId: string; month: string; bankTransactionId?: string | null; bankAccountId?: string | null; date?: string | null;
  paidBy: string; requestId?: string;
}): typeof payrollRemittances.$inferSelect {
  const summary = monthlyPayrollSummary(db, params.companyId, params.month);
  if (summary.remittance) throw new PayrollError(`${params.month} was already paid to Revenue on ${summary.remittance.paidOn}.`);
  if (summary.draftRuns) {
    throw new PayrollError(`${summary.draftRuns} pay run(s) dated in ${params.month} are still drafts. Post or delete them before `
      + 'paying the month, so the payment covers every run in it.');
  }
  const t = summary.totals;
  const prsi = t.prsiEmployeeMinor + t.prsiEmployerMinor;
  const total = t.taxMinor + t.uscMinor + prsi;
  if (total <= 0) throw new PayrollError(`Nothing is due to Revenue for ${params.month}.`);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const payment = resolvePayment(db, { ...params, amountMinor: total });
  const lastPayDate = summary.runs.at(-1)!.payDate;
  if (payment.date < lastPayDate) throw new PayrollError(`The payment (${payment.date}) cannot precede the month's last pay date (${lastPayDate}).`);
  const id = ids.payrollRemittance();
  return atomically(db, () => {
    assertAccountingPeriodOpen(db, params.companyId, payment.date);
    const lines = [
      { key: 'paye_payable' as const, amount: t.taxMinor, memo: `PAYE for ${params.month}` },
      { key: 'usc_payable' as const, amount: t.uscMinor, memo: `USC for ${params.month}` },
      { key: 'prsi_payable' as const, amount: prsi, memo: `PRSI for ${params.month}` },
    ].filter((l) => l.amount !== 0).map((l) => {
      const accountId = systemAccountId(db, params.companyId, l.key);
      return l.amount > 0 ? { accountId, debitMinor: l.amount, memo: l.memo } : { accountId, creditMinor: -l.amount, memo: l.memo };
    });
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: payment.date, narrative: `Payroll taxes paid to Revenue for ${params.month}`,
      sourceType: 'payroll_payment', sourceId: id, baseCurrency: company.baseCurrency,
      createdBy: params.paidBy, createdVia: 'user', requestId: params.requestId,
      lines: [...lines, { accountId: payment.moneyAccountId, creditMinor: total, memo: `Revenue: payroll ${params.month}` }],
    });
    if (payment.transaction) markBankLinePosted(db, payment.transaction.id, journal.id);
    db.insert(payrollRemittances).values({
      id, companyId: params.companyId, month: params.month, payeMinor: t.taxMinor, uscMinor: t.uscMinor, prsiMinor: prsi,
      paidOn: payment.date, journalEntryId: journal.id, bankTransactionId: payment.transaction?.id ?? null, recordedBy: params.paidBy,
    }).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'payroll_remittance', entityId: id,
      action: 'payroll_paid', newValue: JSON.stringify({ month: params.month, totalMinor: total, journalEntryId: journal.id }),
      source: 'user', actor: params.paidBy, requestId: params.requestId ?? null,
    }).run();
    return db.select().from(payrollRemittances).where(eq(payrollRemittances.id, id)).get()!;
  });
}

export interface EmployeeYearSummary {
  employeeId: string;
  name: string;
  ppsn: string | null;
  employerReference: string;
  totals: PayrollTotals;
  insurableWeeks: number;
}

/** Each employee's posted figures for a tax year: the year-end summary (issue #527). */
export function yearEndSummary(db: AppDatabase, companyId: string, taxYear: number): EmployeeYearSummary[] {
  const rows = db.select({
    employeeId: payslips.employeeId, first: employees.firstName, last: employees.lastName, ppsn: employees.ppsn,
    ref: employees.employerReference, weeks: sql<number>`coalesce(sum(${payslips.insurableWeeks}), 0)`, ...TOTALS,
  }).from(payslips)
    .innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .innerJoin(employees, eq(payslips.employeeId, employees.id))
    .where(and(eq(payRuns.companyId, companyId), eq(payRuns.status, 'posted'), eq(payRuns.taxYear, taxYear)))
    .groupBy(payslips.employeeId).orderBy(employees.lastName, employees.firstName).all();
  return rows.map(({ employeeId, first, last, ppsn, ref, weeks, ...t }) => ({
    employeeId, name: `${first} ${last}`, ppsn, employerReference: ref, insurableWeeks: weeks, totals: withRevenue(t),
  }));
}

/** One employee's posted payslips in a tax year, in pay date order, with the running totals. */
export function employeeYearToDate(db: AppDatabase, companyId: string, employeeId: string, taxYear: number) {
  const slips = db.select({ p: payslips, payDate: payRuns.payDate }).from(payslips)
    .innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .where(and(eq(payRuns.companyId, companyId), eq(payslips.employeeId, employeeId), eq(payRuns.status, 'posted'), eq(payRuns.taxYear, taxYear)))
    .orderBy(asc(payRuns.payDate), asc(payRuns.postedAt)).all();
  return slips.map(({ p, payDate }) => ({ ...p, payDate }));
}

export interface PayrollReconciliation {
  asOf: string;
  accounts: Array<{
    key: 'paye_payable' | 'usc_payable' | 'prsi_payable' | 'net_wages_payable' | 'pension_payable';
    /** The ledger balance in the account's natural (credit) direction. */
    ledgerMinor: number;
    /** What the posted runs credited, less what was paid through payroll. Null where payments are made outside payroll (pension). */
    expectedMinor: number | null;
    differenceMinor: number | null;
  }>;
  /** Posted runs whose net pay has not left the bank. */
  unpaidNetPay: Array<{ runId: string; payDate: string; netPayMinor: number }>;
  /** Months with posted runs and no payment to Revenue. */
  unremittedMonths: Array<{ month: string; dueMinor: number }>;
  /** Employees whose cumulative figures do not equal the sum of their posted payslips. */
  cumulativeMismatches: Array<{ employeeId: string; name: string; payslipId: string; detail: string }>;
}

/**
 * Reconcile the payroll control accounts with the posted runs (issue #527).
 * A difference is reported and raised as a review item; nothing is adjusted
 * (invariant 7).
 */
export function reconcilePayroll(db: AppDatabase, params: { companyId: string; asOf: string }): PayrollReconciliation {
  if (!isIsoDate(params.asOf)) throw new PayrollError('The reconciliation date is a YYYY-MM-DD date.');
  const asOf: IsoDate = asIsoDate(params.asOf);
  const { companyId } = params;
  const posted = and(eq(payRuns.companyId, companyId), eq(payRuns.status, 'posted'), lte(payRuns.payDate, asOf));
  const credited = db.select(TOTALS).from(payslips).innerJoin(payRuns, eq(payslips.payRunId, payRuns.id)).where(posted).get()!;
  const remitted = db.select({
    paye: sql<number>`coalesce(sum(${payrollRemittances.payeMinor}), 0)`,
    usc: sql<number>`coalesce(sum(${payrollRemittances.uscMinor}), 0)`,
    prsi: sql<number>`coalesce(sum(${payrollRemittances.prsiMinor}), 0)`,
  }).from(payrollRemittances).where(and(eq(payrollRemittances.companyId, companyId), lte(payrollRemittances.paidOn, asOf))).get()!;
  const runs = db.select().from(payRuns).where(posted).all();
  const netPaid = runs.filter((r) => r.netPaidOn && r.netPaidOn <= asOf)
    .reduce((s, r) => s + payRunTotals(db, r.id).netPayMinor, 0);

  const ledger = (key: PayrollReconciliation['accounts'][number]['key']) =>
    accountBalance(db, { companyId, accountId: systemAccountId(db, companyId, key), asOf });
  const row = (key: PayrollReconciliation['accounts'][number]['key'], expected: number | null) => {
    const l = ledger(key);
    return { key, ledgerMinor: l, expectedMinor: expected, differenceMinor: expected === null ? null : l - expected };
  };
  const accounts = [
    row('paye_payable', credited.taxMinor - remitted.paye),
    row('usc_payable', credited.uscMinor - remitted.usc),
    row('prsi_payable', credited.prsiEmployeeMinor + credited.prsiEmployerMinor - remitted.prsi),
    row('net_wages_payable', credited.netPayMinor - netPaid),
    row('pension_payable', null),
  ];

  const unpaidNetPay = runs.filter((r) => !r.netPaidOn || r.netPaidOn > asOf)
    .map((r) => ({ runId: r.id, payDate: r.payDate, netPayMinor: payRunTotals(db, r.id).netPayMinor }))
    .filter((r) => r.netPayMinor > 0);
  const months = [...new Set(runs.map((r) => r.payDate.slice(0, 7)))].sort();
  const unremittedMonths = months.filter((m) => !db.select({ id: payrollRemittances.id }).from(payrollRemittances)
    .where(and(eq(payrollRemittances.companyId, companyId), eq(payrollRemittances.month, m), lte(payrollRemittances.paidOn, asOf))).get())
    .map((m) => ({ month: m, dueMinor: monthlyPayrollSummary(db, companyId, m).totals.dueToRevenueMinor }));

  // Each posted payslip's cumulative pay must equal the RPN's previous pay (on the cumulative basis) plus
  // the sum of the employee's posted payslips that year up to and including it.
  const cumulativeMismatches: PayrollReconciliation['cumulativeMismatches'] = [];
  const staff = db.select().from(employees).where(eq(employees.companyId, companyId)).all();
  for (const e of staff) {
    const years = [...new Set(runs.map((r) => r.taxYear))];
    for (const year of years) {
      let running = 0;
      for (const p of employeeYearToDate(db, companyId, e.id, year).filter((s) => s.payDate <= asOf)) {
        running += p.payForTaxMinor;
        const previous = p.taxBasis === 'cumulative' && p.rpnId
          ? db.select({ v: revenuePayrollNotifications.previousPayMinor }).from(revenuePayrollNotifications)
            .where(eq(revenuePayrollNotifications.id, p.rpnId)).get()?.v ?? 0
          : 0;
        if (p.cumulativePayForTaxMinor !== previous + running) {
          cumulativeMismatches.push({
            employeeId: e.id, name: `${e.firstName} ${e.lastName}`, payslipId: p.id,
            detail: `The payslip of ${p.payDate} shows cumulative pay of ${eur(p.cumulativePayForTaxMinor)}, but the posted payslips `
              + `sum to ${eur(previous + running)}.`,
          });
        }
      }
    }
  }

  for (const a of accounts) {
    if (a.differenceMinor) {
      upsertReviewItem(db, {
        companyId, kind: 'reconciliation_difference', severity: 'warning',
        title: `Payroll: ${a.key.replace(/_/g, ' ')} differs from the posted runs by ${eur(a.differenceMinor)}`,
        detail: `On ${asOf} the ledger shows ${eur(a.ledgerMinor)} owed, and the posted pay runs less payroll payments come to `
          + `${eur(a.expectedMinor!)}. Something was posted to this account outside payroll (a bank line classified to it, say). `
          + 'Find the entry and correct it with a reversing entry; nothing has been adjusted.',
        entityType: 'company', entityId: companyId, dedupeKey: `payroll_reconciliation:${a.key}:${asOf}`,
        context: { asOf, ...a },
      });
    }
  }
  for (const m of cumulativeMismatches) {
    upsertReviewItem(db, {
      companyId, kind: 'reconciliation_difference', severity: 'error',
      title: `Payroll: ${m.name}'s cumulative pay does not match their payslips`, detail: m.detail,
      entityType: 'payslip', entityId: m.payslipId, dedupeKey: `payroll_cumulative:${m.payslipId}`,
    });
  }
  return { asOf, accounts, unpaidNetPay, unremittedMonths, cumulativeMismatches };
}

import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, bankAccounts, bankTransactions, companies, employees, payRuns, payrollRemittances, payslipLines, payslips,
  type PayFrequency, PAY_FREQUENCIES,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso, parts, type IsoDate } from '../dates';
import { atomically, assertAccountingPeriodOpen, postJournalEntry, reverseJournalEntry, type JournalLineInput } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { defaultInsurableWeeks, periodDates, periodNumber } from './calendar';
import { computePayslip, type ComputedPayslip, type PayInputs, type RunContext } from './compute';
import { employeesForRun, getEmployee } from './employees';
import { PayrollError } from './figures';

/**
 * Pay runs (issue #527): the lifecycle draft → posted → (reversed).
 *
 * A draft run's payslips are computed and may be recomputed as often as the
 * inputs or the RPNs change: a draft is a working, not evidence. Posting
 * re-computes every payslip and refuses if any figure differs from the draft
 * the person reviewed, then posts one payroll journal at the pay date. A
 * posted run is immutable; it is corrected only by reversing it, which posts
 * a reversing journal and takes its payslips out of later runs' cumulative
 * figures.
 */

export type PayRun = typeof payRuns.$inferSelect;
export type Payslip = typeof payslips.$inferSelect;
export type PayslipLine = typeof payslipLines.$inferSelect;

const eur = (minor: number) => (minor / 100).toFixed(2);

export function getPayRun(db: AppDatabase, companyId: string, runId: string): PayRun {
  const run = db.select().from(payRuns).where(and(eq(payRuns.id, runId), eq(payRuns.companyId, companyId))).get();
  if (!run) throw new PayrollError(`Pay run ${runId} not found in this company.`, { runId });
  return run;
}

export function listPayRuns(db: AppDatabase, companyId: string, taxYear?: number): PayRun[] {
  return db.select().from(payRuns)
    .where(taxYear ? and(eq(payRuns.companyId, companyId), eq(payRuns.taxYear, taxYear)) : eq(payRuns.companyId, companyId))
    .orderBy(desc(payRuns.payDate), sql`rowid desc`).all();
}

export function payslipsOfRun(db: AppDatabase, runId: string): Array<Payslip & { lines: PayslipLine[]; employeeName: string }> {
  const rows = db.select({ p: payslips, first: employees.firstName, last: employees.lastName }).from(payslips)
    .innerJoin(employees, eq(payslips.employeeId, employees.id))
    .where(eq(payslips.payRunId, runId)).orderBy(employees.lastName, employees.firstName).all();
  return rows.map(({ p, first, last }) => ({
    ...p,
    employeeName: `${first} ${last}`,
    lines: db.select().from(payslipLines).where(eq(payslipLines.payslipId, p.id)).orderBy(payslipLines.sortOrder).all(),
  }));
}

function context(run: PayRun): RunContext {
  return {
    id: run.id, payFrequency: run.payFrequency, payDate: asIsoDate(run.payDate),
    periodStart: asIsoDate(run.periodStart), periodEnd: asIsoDate(run.periodEnd),
    taxYear: run.taxYear, periodNumber: run.periodNumber, insurableWeeks: run.insurableWeeks,
  };
}

function insertPayslip(db: AppDatabase, companyId: string, runId: string, c: ComputedPayslip, inputs: PayInputs): void {
  const id = ids.payslip();
  const { lines, ...figures } = c;
  db.insert(payslips).values({ id, companyId, payRunId: runId, ...figures, inputs: inputs as Record<string, unknown> }).run();
  lines.forEach((l, i) => {
    db.insert(payslipLines).values({ id: ids.payslipLine(), payslipId: id, ...l, sortOrder: i }).run();
  });
}

function deletePayslip(db: AppDatabase, payslipId: string): void {
  db.delete(payslipLines).where(eq(payslipLines.payslipId, payslipId)).run();
  db.delete(payslips).where(eq(payslips.id, payslipId)).run();
}

function requireDraft(run: PayRun): void {
  if (run.status !== 'draft') {
    throw new PayrollError(`This pay run is ${run.status}. A posted run is never changed: reverse it and run the period again.`,
      { runId: run.id, status: run.status });
  }
}

/**
 * Start a pay run for one pay frequency and pay date. Every employee on that
 * frequency employed in the period is included unless `employeeIds` names
 * who. Each payslip is computed now; one that cannot be computed stops the
 * run with the reason, rather than leaving that person out silently.
 */
export function createPayRun(db: AppDatabase, params: {
  companyId: string;
  payFrequency: PayFrequency;
  payDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** PRSI insurable weeks; required for a monthly run (issue #529). */
  insurableWeeks?: number | null;
  employeeIds?: string[] | null;
  inputs?: Record<string, PayInputs>;
  createdBy: string;
  notes?: string | null;
}): PayRun {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new PayrollError(`Company ${params.companyId} not found.`);
  if (company.baseCurrency !== 'EUR') throw new PayrollError('Payroll is computed in euro; this book\'s base currency is not EUR.');
  if (!PAY_FREQUENCIES.includes(params.payFrequency)) throw new PayrollError('The pay frequency is weekly, fortnightly or monthly.');
  if (!isIsoDate(params.payDate)) throw new PayrollError('The pay date is a YYYY-MM-DD date.');
  if (!params.createdBy.trim()) throw new PayrollError('Say who is running this payroll.');
  const payDate = asIsoDate(params.payDate);
  const taxYear = parts(payDate).year;
  const period = periodNumber(params.payFrequency, payDate);
  const defaults = periodDates(params.payFrequency, taxYear, period);
  const periodStart = params.periodStart ? asIsoDate(params.periodStart) : defaults.start;
  const periodEnd = params.periodEnd ? asIsoDate(params.periodEnd) : defaults.end;
  if (periodEnd < periodStart) throw new PayrollError('The pay period ends before it starts.');
  const weeks = params.insurableWeeks ?? defaultInsurableWeeks(params.payFrequency);
  if (weeks === null) {
    throw new PayrollError('Give the number of PRSI insurable weeks in this month (4 or 5): the PRSI thresholds are weekly '
      + '(SWCA 2005 s.13(2); issue #529).');
  }
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 5) throw new PayrollError('Insurable weeks in a pay period are 1 to 5.');

  const staff = params.employeeIds?.length
    ? params.employeeIds.map((id) => getEmployee(db, params.companyId, id))
    : employeesForRun(db, params.companyId, params.payFrequency, periodStart, payDate);
  for (const e of staff) {
    if (e.payFrequency !== params.payFrequency) {
      throw new PayrollError(`${e.firstName} ${e.lastName} is paid ${e.payFrequency}, not ${params.payFrequency}.`, { employeeId: e.id });
    }
    if (e.startDate > payDate) throw new PayrollError(`${e.firstName} ${e.lastName} starts on ${e.startDate}, after this pay date.`);
  }
  if (!staff.length) throw new PayrollError(`No ${params.payFrequency} employee is employed in this period.`);

  const id = ids.payRun();
  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    tx.insert(payRuns).values({
      id, companyId: params.companyId, payFrequency: params.payFrequency, taxYear, periodNumber: period,
      periodStart, periodEnd, payDate, insurableWeeks: weeks, status: 'draft',
      createdBy: params.createdBy, notes: params.notes ?? null,
    }).run();
    const run = tx.select().from(payRuns).where(eq(payRuns.id, id)).get()!;
    for (const employee of staff) {
      const inputs = params.inputs?.[employee.id] ?? {};
      insertPayslip(txDb, params.companyId, id, computePayslip(txDb, { companyId: params.companyId, run: context(run), employee, inputs }), inputs);
    }
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'pay_run', entityId: id,
      action: 'created', newValue: JSON.stringify({ payDate, payFrequency: params.payFrequency, periodNumber: period, employees: staff.length }),
      source: 'user', actor: params.createdBy, requestId: null,
    }).run();
    return run;
  });
}

/** Replace one employee's inputs on a draft run (adding them if absent) and recompute their payslip. */
export function setPayslipInputs(db: AppDatabase, params: {
  companyId: string; runId: string; employeeId: string; inputs: PayInputs;
}): Payslip {
  const run = getPayRun(db, params.companyId, params.runId);
  requireDraft(run);
  const employee = getEmployee(db, params.companyId, params.employeeId);
  if (employee.payFrequency !== run.payFrequency) {
    throw new PayrollError(`${employee.firstName} ${employee.lastName} is paid ${employee.payFrequency}, not ${run.payFrequency}.`);
  }
  const computed = computePayslip(db, { companyId: params.companyId, run: context(run), employee, inputs: params.inputs });
  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    const existing = tx.select().from(payslips)
      .where(and(eq(payslips.payRunId, run.id), eq(payslips.employeeId, employee.id))).get();
    if (existing) deletePayslip(txDb, existing.id);
    insertPayslip(txDb, params.companyId, run.id, computed, params.inputs);
    return tx.select().from(payslips).where(and(eq(payslips.payRunId, run.id), eq(payslips.employeeId, employee.id))).get()!;
  });
}

/** Take an employee off a draft run. */
export function removeFromPayRun(db: AppDatabase, params: { companyId: string; runId: string; employeeId: string }): void {
  const run = getPayRun(db, params.companyId, params.runId);
  requireDraft(run);
  const existing = db.select().from(payslips)
    .where(and(eq(payslips.payRunId, run.id), eq(payslips.employeeId, params.employeeId))).get();
  if (!existing) throw new PayrollError('That employee is not on this run.');
  db.transaction((tx) => deletePayslip(tx as unknown as AppDatabase, existing.id));
}

/** Recompute every payslip on a draft run from its stored inputs (after a new RPN, say). */
export function recomputePayRun(db: AppDatabase, params: { companyId: string; runId: string }): void {
  const run = getPayRun(db, params.companyId, params.runId);
  requireDraft(run);
  const current = db.select().from(payslips).where(eq(payslips.payRunId, run.id)).all();
  const fresh = current.map((p) => ({
    old: p, inputs: p.inputs as PayInputs,
    computed: computePayslip(db, { companyId: params.companyId, run: context(run), employee: getEmployee(db, params.companyId, p.employeeId), inputs: p.inputs as PayInputs }),
  }));
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    for (const f of fresh) {
      deletePayslip(txDb, f.old.id);
      insertPayslip(txDb, params.companyId, run.id, f.computed, f.inputs);
    }
  });
}

/** The figures a person reviews on a payslip: if any differs on re-computation, the draft is stale. */
const REVIEWED: Array<keyof ComputedPayslip & keyof Payslip> = [
  'grossPayMinor', 'notionalPayMinor', 'pensionEmployeeMinor', 'pensionEmployerMinor', 'payForTaxMinor', 'taxMinor',
  'payForUscMinor', 'uscMinor', 'prsiEmployeeMinor', 'prsiEmployerMinor', 'ntfLevyMinor', 'netPayMinor', 'taxBasis', 'uscBasis', 'rpnId',
];

/** The payroll journal's lines: costs debited, deductions and net pay credited (issue #527). */
function journalLines(db: AppDatabase, companyId: string, slips: Payslip[]): JournalLineInput[] {
  const lines: JournalLineInput[] = [];
  const add = (key: Parameters<typeof systemAccountId>[2], signedDebit: number, memo: string, officerId?: string | null) => {
    if (signedDebit === 0) return;
    const accountId = systemAccountId(db, companyId, key);
    lines.push(signedDebit > 0
      ? { accountId, debitMinor: signedDebit, memo, officerId: officerId ?? null }
      : { accountId, creditMinor: -signedDebit, memo, officerId: officerId ?? null });
  };
  const sum = (f: (p: Payslip) => number, ps = slips) => ps.reduce((s, p) => s + f(p), 0);
  const staff = new Map(db.select().from(employees).where(inArray(employees.id, slips.map((s) => s.employeeId))).all().map((e) => [e.id, e]));
  const directors = slips.filter((p) => staff.get(p.employeeId)?.isDirector);
  const others = slips.filter((p) => !staff.get(p.employeeId)?.isDirector);

  add('wages_expense', sum((p) => p.grossPayMinor, others), 'Gross wages');
  for (const p of directors) {
    const e = staff.get(p.employeeId)!;
    add('directors_remuneration', p.grossPayMinor, `Director's pay: ${e.firstName} ${e.lastName}`, e.officerId);
  }
  add('employer_prsi_expense', sum((p) => p.prsiEmployerMinor + p.ntfLevyMinor), 'Employer PRSI and National Training Fund levy');
  add('employer_pension_expense', sum((p) => p.pensionEmployerMinor), 'Employer pension contributions');
  add('paye_payable', -sum((p) => p.taxMinor), 'PAYE deducted');
  add('usc_payable', -sum((p) => p.uscMinor), 'USC deducted');
  add('prsi_payable', -sum((p) => p.prsiEmployeeMinor + p.prsiEmployerMinor + p.ntfLevyMinor), 'PRSI (employee and employer) and NTF levy');
  add('pension_payable', -sum((p) => p.pensionEmployeeMinor + p.pensionEmployerMinor), 'Pension contributions held for the provider');
  add('net_wages_payable', -sum((p) => p.netPayMinor), 'Net pay owed to employees');
  return lines;
}

/**
 * Post a draft run: re-compute, refuse if the draft is stale or out of
 * order, then post the payroll journal at the pay date and freeze the run.
 */
export function postPayRun(db: AppDatabase, params: { companyId: string; runId: string; postedBy: string; requestId?: string }): PayRun {
  const run = getPayRun(db, params.companyId, params.runId);
  requireDraft(run);
  if (!params.postedBy.trim()) throw new PayrollError('Say who is posting this pay run.');
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  assertAccountingPeriodOpen(db, params.companyId, run.payDate);
  const slips = db.select().from(payslips).where(eq(payslips.payRunId, run.id)).all();
  if (!slips.length) throw new PayrollError('This run has no payslips.');

  for (const p of slips) {
    // A later posted run already counted this period's cumulative figures without it.
    const later = db.select({ payDate: payRuns.payDate }).from(payslips).innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
      .where(and(eq(payslips.employeeId, p.employeeId), eq(payRuns.status, 'posted'), eq(payRuns.taxYear, run.taxYear),
        gt(payRuns.payDate, run.payDate))).get();
    if (later) {
      const e = getEmployee(db, params.companyId, p.employeeId);
      throw new PayrollError(`${e.firstName} ${e.lastName} already has a posted run paid on ${later.payDate}, after this one. `
        + 'Runs post in pay date order, because each payslip\'s cumulative tax counts the ones before it.');
    }
    const fresh = computePayslip(db, {
      companyId: params.companyId, run: context(run), employee: getEmployee(db, params.companyId, p.employeeId), inputs: p.inputs as PayInputs,
    });
    const changed = REVIEWED.filter((k) => fresh[k] !== p[k]);
    if (changed.length) {
      const e = getEmployee(db, params.companyId, p.employeeId);
      throw new PayrollError(`${e.firstName} ${e.lastName}'s payslip is out of date (${changed.join(', ')} changed since it was `
        + 'computed, for example by a new RPN or a rule decision). Recompute the run and review it before posting.',
      { employeeId: p.employeeId, changed });
    }
  }

  const lines = journalLines(db, params.companyId, slips);
  if (lines.length < 2) throw new PayrollError('Nothing on this run moves money: every payslip is nil.');
  return atomically(db, () => {
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: asIsoDate(run.payDate),
      narrative: `Payroll: ${run.payFrequency} period ${run.periodNumber} of ${run.taxYear}, paid ${run.payDate}`,
      sourceType: 'payroll_run', sourceId: run.id, baseCurrency: company.baseCurrency,
      createdBy: params.postedBy, createdVia: 'user', requestId: params.requestId, lines,
    });
    const at = nowIso();
    db.update(payRuns).set({ status: 'posted', journalEntryId: journal.id, postedBy: params.postedBy, postedAt: at, updatedAt: at })
      .where(eq(payRuns.id, run.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at, entityType: 'pay_run', entityId: run.id, action: 'payroll_posted',
      newValue: JSON.stringify({ journalEntryId: journal.id, payslips: slips.length, netPayMinor: slips.reduce((s, p) => s + p.netPayMinor, 0) }),
      source: 'user', actor: params.postedBy, requestId: params.requestId ?? null,
    }).run();
    return getPayRun(db, params.companyId, run.id);
  });
}

/**
 * Reverse a posted run: its journal is reversed (never edited) and its
 * payslips drop out of later cumulative figures. Refused once the net pay
 * has left the bank or the month's liabilities have been paid to Revenue, and
 * while a later run for the same employees stands on its figures: those are
 * reversed first, latest first.
 */
export function reversePayRun(db: AppDatabase, params: {
  companyId: string; runId: string; reason: string; reversedBy: string; reversalDate?: string | null; requestId?: string;
}): PayRun {
  const run = getPayRun(db, params.companyId, params.runId);
  if (run.status !== 'posted') throw new PayrollError(`Only a posted run is reversed; this one is ${run.status}.`);
  if (!params.reason.trim()) throw new PayrollError('Give the reason the run is being reversed.');
  if (run.netPayJournalEntryId) {
    throw new PayrollError('The net pay of this run has already been paid. Reversing the run would leave that payment owed back '
      + 'by the employees: record the correction as a new run instead.');
  }
  const remitted = db.select({ id: payrollRemittances.id }).from(payrollRemittances)
    .where(and(eq(payrollRemittances.companyId, params.companyId), eq(payrollRemittances.month, run.payDate.slice(0, 7)))).get();
  if (remitted) {
    throw new PayrollError(`The PAYE, USC and PRSI for ${run.payDate.slice(0, 7)} have been paid to Revenue. Correct it in a `
      + 'later run instead of reversing one already remitted.');
  }
  const ids_ = db.select({ id: payslips.employeeId }).from(payslips).where(eq(payslips.payRunId, run.id)).all().map((r) => r.id);
  const later = db.select({ id: payRuns.id, payDate: payRuns.payDate }).from(payslips).innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .where(and(inArray(payslips.employeeId, ids_), eq(payRuns.status, 'posted'), eq(payRuns.taxYear, run.taxYear), ne(payRuns.id, run.id),
      sql`(${payRuns.payDate} > ${run.payDate} or (${payRuns.payDate} = ${run.payDate} and ${payRuns.postedAt} > ${run.postedAt}))`)).get();
  if (later) {
    throw new PayrollError(`A later run (paid ${later.payDate}) counts this run's figures in its cumulative tax. Reverse that one first.`);
  }
  const reversalDate = asIsoDate(params.reversalDate && isIsoDate(params.reversalDate) ? params.reversalDate : run.payDate);
  return atomically(db, () => {
    assertAccountingPeriodOpen(db, params.companyId, reversalDate);
    const reversal = reverseJournalEntry(db, {
      companyId: params.companyId, entryId: run.journalEntryId!, reversalDate, reason: params.reason.trim(),
      createdBy: params.reversedBy, requestId: params.requestId,
    });
    const at = nowIso();
    db.update(payRuns).set({
      status: 'reversed', reversalJournalEntryId: reversal.id, reversalReason: params.reason.trim(), reversedBy: params.reversedBy, updatedAt: at,
    }).where(eq(payRuns.id, run.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at, entityType: 'pay_run', entityId: run.id, action: 'payroll_reversed',
      newValue: JSON.stringify({ reversalJournalEntryId: reversal.id, reason: params.reason.trim() }),
      source: 'user', actor: params.reversedBy, requestId: params.requestId ?? null,
    }).run();
    return getPayRun(db, params.companyId, run.id);
  });
}

/** Where money left, and when: from a bank line, or a bank account and a date given by hand. */
export function resolvePayment(db: AppDatabase, params: {
  companyId: string; amountMinor: number; bankTransactionId?: string | null; bankAccountId?: string | null; date?: string | null;
}): { moneyAccountId: string; date: IsoDate; transaction: typeof bankTransactions.$inferSelect | null } {
  if (params.bankTransactionId) {
    const t = db.select().from(bankTransactions)
      .where(and(eq(bankTransactions.id, params.bankTransactionId), eq(bankTransactions.companyId, params.companyId))).get();
    if (!t) throw new PayrollError(`Bank transaction ${params.bankTransactionId} not found.`);
    if (t.status === 'rolled_back') throw new PayrollError('That line\'s statement import was undone, so it is not part of the books.');
    if (t.journalEntryId) throw new PayrollError('That bank line is already posted: the same money would be recorded twice.');
    if (t.amountMinor >= 0) throw new PayrollError('That bank line is money coming in; a payment is money out.');
    if (Math.abs(t.amountMinor) !== params.amountMinor) {
      throw new PayrollError(`The bank line is ${eur(Math.abs(t.amountMinor))} but ${eur(params.amountMinor)} is owed. The payment `
        + 'must match exactly: record a difference deliberately, not by absorbing it.');
    }
    const ba = db.select().from(bankAccounts).where(eq(bankAccounts.id, t.bankAccountId)).get();
    return { moneyAccountId: ba?.accountId ?? systemAccountId(db, params.companyId, 'bank_control'), date: asIsoDate(t.transactionDate), transaction: t };
  }
  if (!params.date || !isIsoDate(params.date)) throw new PayrollError('A payment recorded without a bank line needs the date it was paid.');
  let moneyAccountId = systemAccountId(db, params.companyId, 'bank_control');
  if (params.bankAccountId) {
    const ba = db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.id, params.bankAccountId), eq(bankAccounts.companyId, params.companyId))).get();
    if (!ba) throw new PayrollError(`Bank account ${params.bankAccountId} not found.`);
    moneyAccountId = ba.accountId ?? moneyAccountId;
  }
  return { moneyAccountId, date: asIsoDate(params.date), transaction: null };
}

/** Mark a bank line as the evidence of a posted payment. */
export function markBankLinePosted(db: AppDatabase, transactionId: string, journalEntryId: string): void {
  db.update(bankTransactions).set({
    journalEntryId, status: 'posted', source: 'user', provenanceStatus: 'user_confirmed', updatedAt: nowIso(),
  }).where(eq(bankTransactions.id, transactionId)).run();
}

/** The net pay of a posted run leaving the bank: Dr net wages payable / Cr bank, for exactly the run's net pay. */
export function payNetWages(db: AppDatabase, params: {
  companyId: string; runId: string; bankTransactionId?: string | null; bankAccountId?: string | null; date?: string | null;
  paidBy: string; requestId?: string;
}): PayRun {
  const run = getPayRun(db, params.companyId, params.runId);
  if (run.status !== 'posted') throw new PayrollError(`Net pay is paid on a posted run; this one is ${run.status}.`);
  if (run.netPayJournalEntryId) throw new PayrollError(`This run's net pay was already paid on ${run.netPaidOn}.`);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const net = db.select({ n: sql<number>`coalesce(sum(${payslips.netPayMinor}), 0)` }).from(payslips)
    .where(eq(payslips.payRunId, run.id)).get()!.n;
  if (net <= 0) throw new PayrollError('This run has no net pay to pay.');
  const payment = resolvePayment(db, { ...params, amountMinor: net });
  if (payment.date < run.payDate) throw new PayrollError(`Net pay cannot leave the bank (${payment.date}) before the pay run's date (${run.payDate}).`);
  return atomically(db, () => {
    assertAccountingPeriodOpen(db, params.companyId, payment.date);
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: payment.date,
      narrative: `Net pay: ${run.payFrequency} period ${run.periodNumber} of ${run.taxYear}`,
      sourceType: 'payroll_payment', sourceId: run.id, baseCurrency: company.baseCurrency,
      createdBy: params.paidBy, createdVia: 'user', requestId: params.requestId,
      lines: [
        { accountId: systemAccountId(db, params.companyId, 'net_wages_payable'), debitMinor: net, memo: 'Net pay paid' },
        { accountId: payment.moneyAccountId, creditMinor: net, memo: 'Net pay paid' },
      ],
    });
    if (payment.transaction) markBankLinePosted(db, payment.transaction.id, journal.id);
    const at = nowIso();
    db.update(payRuns).set({
      netPayJournalEntryId: journal.id, netPaidOn: payment.date, netPayBankTransactionId: payment.transaction?.id ?? null, updatedAt: at,
    }).where(eq(payRuns.id, run.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at, entityType: 'pay_run', entityId: run.id, action: 'payroll_paid',
      newValue: JSON.stringify({ journalEntryId: journal.id, amountMinor: net, paidOn: payment.date, bankTransactionId: payment.transaction?.id ?? null }),
      source: 'user', actor: params.paidBy, requestId: params.requestId ?? null,
    }).run();
    return getPayRun(db, params.companyId, run.id);
  });
}

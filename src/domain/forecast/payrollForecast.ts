/**
 * Payroll forecast: projected pay runs from employment terms (issue #568, epic #333).
 *
 * Projects future pay runs for each active employee through the horizon, using
 * employment terms and pay frequency. Each projected payslip is an estimate.
 * The payslip engine (computePayslip) is used for salaried employees.
 *
 * Nothing is created, posted or stored — this is purely a view.
 *
 * Finds:
 * - A leaver's cessation date ends their projection.
 * - Terms changes applied from a future date are honoured.
 * - Every figure is marked as an estimate: RPNs may change; overtime and
 *   bonuses are excluded by default.
 */

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  employees, payRuns, payslips,
} from '@/db/schema';
import { asIsoDate, addDays, endOfMonth, parts, type IsoDate } from '../dates';
import { periodDates, periodNumber } from '../payroll/calendar';
import { termsOn } from '../payroll/employees';
import { computePayslip, type RunContext } from '../payroll/compute';
import type { ForecastLine } from './types';

interface ProjectedRun {
  employeeId: string;
  employeeName: string;
  payDate: IsoDate;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  grossPayMinor: number;
  prsiEmployerMinor: number;
  netPayMinor: number;
  findings: string[];
}

/** Next pay date after `after` for a given frequency and start date. */
function nextPayDate(frequency: 'weekly' | 'fortnightly' | 'monthly', after: IsoDate): IsoDate {
  if (frequency === 'weekly') return addDays(after, 7);
  if (frequency === 'fortnightly') return addDays(after, 14);
  // Monthly: end of next month
  return endOfMonth(addDays(after, 1));
}

/**
 * Project pay runs for a single employee through the horizon.
 * Returns a list of projected outflow lines (net wages on pay day +
 * employer PRSI contribution, which is an additional outflow on top of the net).
 */
function projectEmployee(
  db: AppDatabase,
  params: {
    companyId: string;
    employeeId: string;
    employeeName: string;
    asOf: IsoDate;
    horizonEnd: IsoDate;
    lastPostedPayDate: string | null;
    taxYear: number;
  },
): { lines: ForecastLine[]; findings: string[] } {
  const employee = db.select().from(employees).where(eq(employees.id, params.employeeId)).get();
  if (!employee) return { lines: [], findings: [] };
  if (employee.leftOn && employee.leftOn <= params.asOf) return { lines: [], findings: [] };

  const freq = employee.payFrequency;
  const lines: ForecastLine[] = [];
  const allFindings: string[] = [];

  // Start from the day after the last posted pay date, or from asOf
  let payDate: IsoDate = params.lastPostedPayDate
    ? nextPayDate(freq, asIsoDate(params.lastPostedPayDate))
    : asOf_startDate(freq, params.asOf, employee.startDate);

  while (payDate <= params.horizonEnd) {
    // Stop at cessation
    if (employee.leftOn && payDate > asIsoDate(employee.leftOn)) break;

    const period = periodNumber(freq, payDate);
    const { start: periodStart, end: periodEnd } = periodDates(freq, parts(payDate).year, period);

    const terms = termsOn(db, params.employeeId, payDate);
    if (!terms) {
      payDate = nextPayDate(freq, payDate);
      continue;
    }

    // Try to compute the payslip — if it throws (e.g. unsupported PRSI class), skip with a finding
    let grossPayMinor = 0;
    let prsiEmployerMinor = 0;
    let netPayMinor = 0;
    const runFindings: string[] = [];
    try {
      const runCtx: RunContext = {
        id: `proj_${params.employeeId}_${payDate}`,
        payFrequency: freq,
        payDate,
        periodStart,
        periodEnd,
        taxYear: parts(payDate).year,
        periodNumber: period,
        insurableWeeks: freq === 'weekly' ? 1 : freq === 'fortnightly' ? 2 : 4,
      };
      const computed = computePayslip(db, {
        companyId: params.companyId, run: runCtx, employee, inputs: {},
      });
      grossPayMinor = computed.grossPayMinor;
      prsiEmployerMinor = computed.prsiEmployerMinor;
      netPayMinor = computed.netPayMinor;
      runFindings.push(...computed.findings);
    } catch {
      // Unsupported: add a finding but don't block the forecast
      runFindings.push(`Could not project pay for ${params.employeeName} on ${payDate}: PRSI class or terms not supported. Exclude this employee or compute separately.`);
      payDate = nextPayDate(freq, payDate);
      continue;
    }

    // Net wages outflow on pay day
    lines.push({
      key: `payroll:${params.employeeId}:${payDate}:net`,
      date: payDate,
      amountMinor: -netPayMinor,
      description: `Net wages: ${params.employeeName} (${payDate})`,
      source: 'ledger',
      isEstimate: true,
      estimateBasis: 'Projected from employment terms and latest RPN. Overtime and bonuses excluded.',
      entityRef: { kind: 'employee', id: params.employeeId },
    });

    // Employer PRSI is an additional cost (not deducted from net wages)
    if (prsiEmployerMinor > 0) {
      lines.push({
        key: `payroll:${params.employeeId}:${payDate}:prsi_er`,
        date: payDate,
        amountMinor: -prsiEmployerMinor,
        description: `Employer PRSI: ${params.employeeName} (${payDate})`,
        source: 'ledger',
        isEstimate: true,
        estimateBasis: 'Projected employer PRSI contribution.',
        entityRef: { kind: 'employee', id: params.employeeId },
      });
    }

    allFindings.push(...runFindings);
    payDate = nextPayDate(freq, payDate);
  }

  return { lines, findings: allFindings };
}

/** First pay date on or after `asOf` for a given frequency, respecting the employment start. */
function asOf_startDate(
  frequency: 'weekly' | 'fortnightly' | 'monthly',
  asOf: IsoDate,
  startDate: string,
): IsoDate {
  const base = startDate > asOf ? asIsoDate(startDate) : asOf;
  if (frequency === 'monthly') {
    // Next month-end on or after base
    return endOfMonth(base);
  }
  return base;
}

/**
 * Project payroll outflows for all active employees through the horizon.
 */
export function payrollForecastLines(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; horizonEnd: IsoDate },
): { lines: ForecastLine[]; findings: string[] } {
  const allEmployees = db.select().from(employees)
    .where(eq(employees.companyId, params.companyId))
    .all()
    .filter((e) => !e.leftOn || e.leftOn > params.asOf);

  const allLines: ForecastLine[] = [];
  const allFindings: string[] = [];
  const taxYear = parts(params.asOf).year;

  for (const emp of allEmployees) {
    // Last posted pay date for this employee
    const lastPosted = db.select({ d: payRuns.payDate }).from(payslips)
      .innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
      .where(and(
        eq(payslips.employeeId, emp.id),
        eq(payRuns.status, 'posted'),
      ))
      .orderBy(payRuns.payDate)
      .all();
    const lastPayDate = lastPosted.length > 0 ? lastPosted[lastPosted.length - 1]!.d : null;

    const { lines, findings } = projectEmployee(db, {
      companyId: params.companyId,
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      asOf: params.asOf,
      horizonEnd: params.horizonEnd,
      lastPostedPayDate: lastPayDate,
      taxYear,
    });
    allLines.push(...lines);
    allFindings.push(...findings);
  }

  return { lines: allLines, findings: allFindings };
}

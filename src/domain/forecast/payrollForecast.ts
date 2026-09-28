/**
 * Payroll in the forecast (issue #568, epic #333).
 *
 * - Net pay on posted runs that has not left the bank, on the run's pay date.
 * - PAYE, USC and PRSI of posted months not yet remitted.
 * - Future runs, projected from the last posted run of each pay frequency:
 *   the next pay dates step by the frequency, each employee employed on the
 *   date is paid under the terms in force then, and the payslip engine
 *   computes the figures. Payroll is cumulative, so the engine is run once
 *   for the first projected period of each employee's terms in each tax year
 *   and that period's figures are repeated; running it again on unposted
 *   periods would not see the earlier projected pay.
 *
 * The date Revenue is paid has no curated rule (S.I. 345/2018 does not state
 * it), so remittances are listed undated, totalled apart, and never placed on
 * a guessed day (#566).
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { payRuns, type PayFrequency } from '@/db/schema';
import { addDays, addMonths, parts, type IsoDate } from '../dates';
import { computePayslip, type ComputedPayslip } from '../payroll/compute';
import { periodDates, periodNumber } from '../payroll/calendar';
import { listEmployees, termsOn } from '../payroll/employees';
import { payRunTotals, reconcilePayroll } from '../payroll/reports';
import type { ForecastLine, ForecastOptions } from './types';

const NO_DATE = 'No curated rule states when payroll deductions are paid to Revenue, so this is not placed on a date.';

/** Pay dates after `last`, up to `upTo`, stepped by the calendar from `last`. */
export function nextPayDates(frequency: PayFrequency, last: IsoDate, upTo: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let k = 1; k < 1_000; k++) {
    const date = frequency === 'monthly' ? addMonths(last, k) : addDays(last, (frequency === 'weekly' ? 7 : 14) * k);
    if (date > upTo) break;
    out.push(date);
  }
  return out;
}

export function payrollForecastLines(db: AppDatabase, o: ForecastOptions): { lines: ForecastLine[]; findings: string[] } {
  const lines: ForecastLine[] = [];
  const findings: string[] = [];
  const anyRun = db.select({ id: payRuns.id }).from(payRuns)
    .where(and(eq(payRuns.companyId, o.companyId), eq(payRuns.status, 'posted'))).get();
  if (!anyRun) return { lines, findings };

  // ---- Posted runs: net pay not yet paid, and months not yet remitted ----
  const rec = reconcilePayroll(db, { companyId: o.companyId, asOf: o.asOf });
  const unpaid = [
    ...rec.unpaidNetPay,
    // Runs posted ahead of a pay date after the forecast date.
    ...db.select().from(payRuns).where(and(eq(payRuns.companyId, o.companyId), eq(payRuns.status, 'posted'),
      gt(payRuns.payDate, o.asOf), isNull(payRuns.netPaidOn))).all()
      .map((r) => ({ runId: r.id, payDate: r.payDate, netPayMinor: payRunTotals(db, r.id).netPayMinor })),
  ];
  for (const r of unpaid) {
    if (r.netPayMinor <= 0 || r.payDate > o.horizonEnd) continue;
    const line: ForecastLine = {
      key: `net_pay:${r.runId}`, date: r.payDate as IsoDate, amountMinor: -r.netPayMinor,
      description: `Net pay: run of ${r.payDate}`, category: 'payroll', source: 'ledger', isEstimate: false,
      entityRef: { kind: 'pay_run', id: r.runId },
    };
    lines.push(r.payDate < o.asOf ? { ...line, date: o.asOf, overdue: true, dueDate: r.payDate as IsoDate } : line);
  }
  for (const m of rec.unremittedMonths) {
    if (m.dueMinor <= 0) continue;
    lines.push({
      key: `remittance:${m.month}`, date: null, amountMinor: -m.dueMinor,
      description: `PAYE, USC and PRSI for ${m.month}`, category: 'payroll', source: 'ledger', isEstimate: false,
      estimateBasis: NO_DATE,
    });
  }

  // ---- Projected runs ----
  const projectedDue = new Map<string, number>();
  // One line per projected run: an employee's own pay is payroll data, not for every reader of the forecast.
  const projectedPay = new Map<string, { frequency: PayFrequency; payDate: IsoDate; last: string; netMinor: number; employees: number }>();
  let pension = false;
  const staff = listEmployees(db, o.companyId);
  for (const frequency of ['weekly', 'fortnightly', 'monthly'] as const) {
    const onFrequency = staff.filter((e) => e.payFrequency === frequency);
    if (onFrequency.length === 0) continue;
    const last = db.select().from(payRuns).where(and(eq(payRuns.companyId, o.companyId), eq(payRuns.payFrequency, frequency),
      eq(payRuns.status, 'posted'))).orderBy(desc(payRuns.payDate)).get();
    if (!last) {
      findings.push(`No ${frequency} pay run is posted, so ${frequency} pay is not projected: there is no pay date to project from.`);
      continue;
    }
    const dates = nextPayDates(frequency, last.payDate as IsoDate, o.horizonEnd);
    const skipped = dates.filter((d) => d < o.asOf);
    if (skipped.length) {
      findings.push(`${skipped.length} ${frequency} pay date(s) between the last posted run (${last.payDate}) and the forecast date `
        + 'have no posted run. They are not forecast: post them, or add them as a scenario payment if they are still to be paid.');
    }
    // The first projected period of each employee's terms in each tax year, reused for the rest.
    const computed = new Map<string, ComputedPayslip | null>();
    for (const payDate of dates.filter((d) => d >= o.asOf)) {
      const taxYear = parts(payDate).year;
      const period = periodNumber(frequency, payDate);
      const { start, end } = periodDates(frequency, taxYear, period);
      for (const e of onFrequency) {
        if (e.startDate > payDate || (e.leftOn !== null && e.leftOn < start)) continue;
        const name = `${e.firstName} ${e.lastName}`;
        const terms = termsOn(db, e.id, payDate);
        if (!terms) {
          findings.push(`${name} has no employment terms in force on ${payDate}: their pay is not forecast from then.`);
          continue;
        }
        const k = `${e.id}:${terms.id}:${taxYear}`;
        if (!computed.has(k)) {
          if (terms.payBasis === 'hourly' && terms.normalHoursHundredths === null) {
            findings.push(`${name} is paid by the hour with no normal hours recorded, so their pay is not forecast.`);
            computed.set(k, null);
          } else {
            try {
              computed.set(k, computePayslip(db, {
                companyId: o.companyId, employee: e,
                run: {
                  id: `forecast:${frequency}:${payDate}`, payFrequency: frequency, payDate, periodStart: start, periodEnd: end,
                  taxYear, periodNumber: period, insurableWeeks: last.insurableWeeks,
                },
                inputs: terms.payBasis === 'hourly' ? { hoursHundredths: terms.normalHoursHundredths } : {},
              }));
            } catch (err) {
              findings.push(`${name}'s pay is not forecast: ${(err as Error).message}`);
              computed.set(k, null);
            }
          }
        }
        const slip = computed.get(k);
        if (!slip) continue;
        if (terms.pensionScheme !== 'none') pension = true;
        const run = projectedPay.get(`${frequency}:${payDate}`) ?? { frequency, payDate, last: last.payDate, netMinor: 0, employees: 0 };
        run.netMinor += slip.netPayMinor;
        run.employees += 1;
        projectedPay.set(`${frequency}:${payDate}`, run);
        const month = payDate.slice(0, 7);
        const due = slip.taxMinor + slip.uscMinor + slip.prsiEmployeeMinor + slip.prsiEmployerMinor;
        projectedDue.set(month, (projectedDue.get(month) ?? 0) + due);
      }
    }
  }
  for (const run of [...projectedPay.values()].sort((a, b) => a.payDate.localeCompare(b.payDate) || a.frequency.localeCompare(b.frequency))) {
    lines.push({
      key: `projected_pay:${run.frequency}:${run.payDate}`, date: run.payDate, amountMinor: -run.netMinor,
      description: `Net pay: ${run.frequency} run (${run.employees} employee${run.employees === 1 ? '' : 's'})`,
      category: 'payroll', source: 'ledger', isEstimate: true,
      estimateBasis: `Projected ${run.frequency} from the last posted run (${run.last}), under each employee's terms in force on the pay date. `
        + 'The first projected period\'s payslip under those terms is repeated: bonuses, overtime and changes of credits are not known.',
    });
  }
  for (const [month, due] of [...projectedDue].sort()) {
    if (due <= 0) continue;
    lines.push({
      key: `projected_remittance:${month}`, date: null, amountMinor: -due,
      description: `PAYE, USC and PRSI for ${month} (projected)`, category: 'payroll', source: 'ledger', isEstimate: true,
      estimateBasis: `From the projected payslips of ${month}. ${NO_DATE}`,
    });
  }
  if (pension) {
    findings.push('Pension contributions are not forecast: when they are paid to the scheme is not recorded.');
  }
  if (lines.some((l) => l.category === 'payroll' && l.date === null)) {
    findings.push(`Payroll deductions owed to Revenue are listed under "Not dated". ${NO_DATE}`);
  }
  return { lines, findings: [...new Set(findings)] };
}

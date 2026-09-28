import { describe, it, expect, beforeEach } from 'vitest';
import { seedTestBook } from '@/db/testing';
import type { AppDatabase } from '@/db';
import { createEmployee, setEmploymentTerms } from '../payroll/employees';
import { recordRpn } from '../payroll/rpn';
import { createPayRun, postPayRun, payslipsOfRun, payNetWages } from '../payroll/runs';
import { payRunTotals, monthlyPayrollSummary } from '../payroll/reports';
import type { IsoDate } from '../dates';
import { forecastOptions, nextPayDates, payrollForecastLines } from '.';

/** Issue #568: payroll in the forecast. */

const USC_2026 = [
  { rateBasisPoints: 50, yearlyBandMinor: 1_201_200 },
  { rateBasisPoints: 200, yearlyBandMinor: 1_668_800 },
  { rateBasisPoints: 300, yearlyBandMinor: 4_134_400 },
  { rateBasisPoints: 800, yearlyBandMinor: null },
];
const d = (s: string) => s as IsoDate;

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let employeeId: string;

beforeEach(() => {
  ({ db, companyId, bankAccountId } = seedTestBook({ seedYears: [2026] }));
  const e = createEmployee(db, {
    companyId, recordedBy: 'owner', firstName: 'Aoife', lastName: 'Byrne', ppsn: '1234567T',
    employerReference: 'E001', startDate: '2025-06-01', payFrequency: 'monthly',
  });
  employeeId = e.id;
  setEmploymentTerms(db, { companyId, employeeId, effectiveFrom: e.startDate, recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 4_800_000 });
  recordRpn(db, {
    companyId, employeeId, recordedBy: 'owner', rpnNumber: '1', taxYear: 2026, effectiveFrom: '2026-01-01',
    taxBasis: 'cumulative', yearlyTaxCreditsMinor: 400_000, yearlySrcopMinor: 4_400_000,
    uscStatus: 'ordinary', uscBasis: 'cumulative', uscBands: USC_2026,
  });
});

const run = (payDate: string) => createPayRun(db, { companyId, payFrequency: 'monthly', payDate, insurableWeeks: 4, createdBy: 'owner' });
const options = (asOf: string, horizonDays: number) => forecastOptions(db, { companyId, asOf: d(asOf), overrides: { horizonDays } });

describe('pay dates', () => {
  it('step from the last posted run by the calendar', () => {
    expect(nextPayDates('monthly', d('2026-01-30'), d('2026-04-30'))).toEqual(['2026-02-28', '2026-03-30', '2026-04-30']);
    expect(nextPayDates('fortnightly', d('2026-01-02'), d('2026-02-01'))).toEqual(['2026-01-16', '2026-01-30']);
  });
});

describe('payroll in the forecast', () => {
  it('forecasts nothing without a posted run', () => {
    expect(payrollForecastLines(db, options('2026-01-01', 90))).toEqual({ lines: [], findings: [] });
  });

  it('dates unpaid net pay on the pay date, and lists PAYE, USC and PRSI owed with no date', () => {
    const jan = run('2026-01-30');
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    const net = payRunTotals(db, jan.id).netPayMinor;
    const { lines, findings } = payrollForecastLines(db, options('2026-01-30', 1));
    expect(lines.find((l) => l.key === `net_pay:${jan.id}`)).toMatchObject({ date: '2026-01-30', amountMinor: -net, isEstimate: false });
    const remittance = lines.find((l) => l.key === 'remittance:2026-01')!;
    expect(remittance).toMatchObject({ date: null, amountMinor: -monthlyPayrollSummary(db, companyId, '2026-01').totals.dueToRevenueMinor });
    expect(findings.join(' ')).toMatch(/No curated rule states when payroll deductions are paid to Revenue/);
  });

  it('once net pay is paid, only the remittance is left', () => {
    const jan = run('2026-01-30');
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    payNetWages(db, { companyId, runId: jan.id, date: '2026-01-30', bankAccountId, paidBy: 'owner' });
    const { lines } = payrollForecastLines(db, options('2026-01-31', 1));
    expect(lines.map((l) => l.key)).toEqual(['remittance:2026-01']);
  });

  it('projects later runs from the engine\'s first projected payslip, repeated, with the remittances undated', () => {
    const jan = run('2026-01-30');
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    payNetWages(db, { companyId, runId: jan.id, date: '2026-01-30', bankAccountId, paidBy: 'owner' });
    // February's payslip as the engine computes it, before it is posted.
    const feb = run('2026-02-28');
    const [slip] = payslipsOfRun(db, feb.id);
    const { lines } = payrollForecastLines(db, options('2026-02-01', 89));
    const projected = lines.filter((l) => l.key.startsWith('projected_pay:'));
    expect(projected.map((l) => [l.date, l.amountMinor])).toEqual([
      ['2026-02-28', -slip!.netPayMinor], ['2026-03-30', -slip!.netPayMinor], ['2026-04-30', -slip!.netPayMinor],
    ]);
    expect(projected.every((l) => l.isEstimate && l.category === 'payroll')).toBe(true);
    const due = slip!.taxMinor + slip!.uscMinor + slip!.prsiEmployeeMinor + slip!.prsiEmployerMinor;
    expect(lines.filter((l) => l.key.startsWith('projected_remittance:')).map((l) => [l.date, l.amountMinor]))
      .toEqual([[null, -due], [null, -due], [null, -due]]);
  });

  it('follows a change of terms from the date it takes effect', () => {
    const jan = run('2026-01-30');
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    payNetWages(db, { companyId, runId: jan.id, date: '2026-01-30', bankAccountId, paidBy: 'owner' });
    setEmploymentTerms(db, { companyId, employeeId, effectiveFrom: '2026-03-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 6_000_000 });
    const { lines } = payrollForecastLines(db, options('2026-02-01', 89));
    const [feb, mar, apr] = lines.filter((l) => l.key.startsWith('projected_pay:'));
    expect(feb!.amountMinor).not.toBe(mar!.amountMinor);
    expect(mar!.amountMinor).toBe(apr!.amountMinor);
    expect(mar!.description).toBe('Net pay: monthly run (1 employee)');
  });

  it('says so when pay dates since the last run have no posted run', () => {
    const jan = run('2026-01-30');
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    const { findings } = payrollForecastLines(db, options('2026-04-01', 30));
    expect(findings.join(' ')).toMatch(/2 monthly pay date\(s\) between the last posted run \(2026-01-30\)/);
  });
});

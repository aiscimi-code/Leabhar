import { readFileSync } from 'node:fs';
import type { AppDatabase } from '@/db';
import { getFlag, hasFlag } from '@/cli/args';
import { parseAmount, parsePercentBasisPoints } from '@/domain/money';
import {
  createEmployee, setEmploymentTerms, recordPpsn, recordCessation, listEmployees, listTerms,
  recordRpn, listRpns, parseUscBands,
  createPayRun, setPayslipInputs, recomputePayRun, postPayRun, reversePayRun, payNetWages, getPayRun, payslipsOfRun, listPayRuns,
  payRunTotals, monthlyPayrollSummary, yearEndSummary, employeeYearToDate, payPayrollLiabilities, reconcilePayroll,
  type PayInputs,
} from '@/domain/payroll';

/**
 * Payroll from the terminal (EPIC 20): the same domain functions the payroll
 * screen calls, so the two cannot disagree about a figure.
 */

export const PAYROLL_USAGE = `
Payroll (EPIC 20, issues #524–#527):
  add-employee --first <name> --last <name> --ref <staff id> --start <date>
            --frequency weekly|fortnightly|monthly --by <name>
            [--ppsn <ppsn>] [--dob <date>] [--address <text>] [--email <text>]
            [--director] [--proprietary-director] [--officer <id>]
                                         Record an employee (S.I. 345/2018 reg.17)
  record-ppsn --employee <id> --ppsn <ppsn> --by <name>
  record-cessation --employee <id> --date <date> --by <name>
  set-employment-terms --employee <id> --from <date> --by <name>
            (--salary <euro a year> | --hourly <euro an hour>) [--hours <per period>]
            [--pension occupational|prsa|rac] [--pension-ee <pct>|--pension-ee-fixed <euro>]
            [--pension-er <pct>|--pension-er-fixed <euro>]
                                         Effective-dated pay basis and pension terms
  record-rpn --employee <id> --rpn <number> --year <yyyy> --from <date> --by <name>
            --basis cumulative|week1|emergency --credits <euro a year> --srcop <euro a year>
            (--usc-exempt | --usc-bands "0.5:12012,2:16688,3:41344,8") [--usc-basis <basis>]
            [--previous-pay <euro>] [--previous-tax <euro>] [--previous-usc-pay <euro>] [--previous-usc <euro>]
                                         A Revenue payroll notification, copied from ROS
  list-employees                         Employees with their terms and RPNs
  create-pay-run --frequency <f> --pay-date <date> --by <name> [--weeks <insurable weeks>]
            [--inputs <file.json>]       A draft run; inputs map employee id to
                                          { hoursHundredths, overtime, bonuses, benefits }
  set-pay-inputs --run <id> --employee <id> --inputs <json>
  recompute-pay-run --run <id>
  show-pay-run --run <id>                The run, its payslips, their working and totals
  post-pay-run --run <id> --by <name>    Post the payroll journal; the run is then fixed
  reverse-pay-run --run <id> --reason <text> --by <name> [--date <date>]
  pay-net-wages --run <id> --by <name> (--bank-transaction <id> | --date <date> [--bank <id>])
  pay-payroll-taxes --month <yyyy-mm> --by <name> (--bank-transaction <id> | --date <date> [--bank <id>])
  payroll-report (--month <yyyy-mm> | --year <yyyy> [--employee <id>])
  reconcile-payroll --as-of <date>       Payroll control accounts against the posted runs
`;

export { parseUscBands };

export const PAYROLL_COMMANDS = [
  'add-employee', 'record-ppsn', 'record-cessation', 'set-employment-terms', 'record-rpn', 'list-employees',
  'create-pay-run', 'set-pay-inputs', 'recompute-pay-run', 'show-pay-run', 'post-pay-run', 'reverse-pay-run',
  'pay-net-wages', 'pay-payroll-taxes', 'payroll-report', 'reconcile-payroll',
] as const;

type Flags = Record<string, string | boolean>;

function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

const euro = (v: string) => parseAmount(v, 'EUR');
const optEuro = (flags: Flags, name: string) => { const v = getFlag(flags, name); return v === undefined ? undefined : euro(v); };
const pct = (v: string) => {
  const bp = parsePercentBasisPoints(v);
  if (bp === null) throw new Error(`"${v}" is not a percentage.`);
  return bp;
};

function paymentFlags(flags: Flags) {
  return {
    bankTransactionId: getFlag(flags, 'bank-transaction') ?? null,
    bankAccountId: getFlag(flags, 'bank') ?? null,
    date: getFlag(flags, 'date') ?? null,
  };
}

export function runPayrollCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  switch (command) {
    case 'add-employee':
      return createEmployee(db, {
        companyId, recordedBy: need(flags, 'by'), firstName: need(flags, 'first'), lastName: need(flags, 'last'),
        employerReference: need(flags, 'ref'), startDate: need(flags, 'start'),
        payFrequency: need(flags, 'frequency') as 'weekly', ppsn: getFlag(flags, 'ppsn') ?? null,
        dateOfBirth: getFlag(flags, 'dob') ?? null, address: getFlag(flags, 'address') ?? null, email: getFlag(flags, 'email') ?? null,
        isDirector: hasFlag(flags, 'director') || hasFlag(flags, 'proprietary-director'),
        isProprietaryDirector: hasFlag(flags, 'proprietary-director'), officerId: getFlag(flags, 'officer') ?? null,
      });
    case 'record-ppsn':
      return recordPpsn(db, { companyId, employeeId: need(flags, 'employee'), ppsn: need(flags, 'ppsn'), recordedBy: need(flags, 'by') });
    case 'record-cessation':
      return recordCessation(db, { companyId, employeeId: need(flags, 'employee'), leftOn: need(flags, 'date'), recordedBy: need(flags, 'by') });
    case 'set-employment-terms': {
      const salary = optEuro(flags, 'salary');
      const hourly = optEuro(flags, 'hourly');
      if ((salary === undefined) === (hourly === undefined)) throw new Error('Give one of --salary or --hourly.');
      const hours = getFlag(flags, 'hours');
      const ee = getFlag(flags, 'pension-ee');
      const er = getFlag(flags, 'pension-er');
      return setEmploymentTerms(db, {
        companyId, employeeId: need(flags, 'employee'), effectiveFrom: need(flags, 'from'), recordedBy: need(flags, 'by'),
        payBasis: salary !== undefined ? 'salary' : 'hourly', annualSalaryMinor: salary ?? null, hourlyRateMinor: hourly ?? null,
        normalHoursHundredths: hours ? Math.round(Number(hours) * 100) : null,
        pensionScheme: (getFlag(flags, 'pension') ?? 'none') as 'none',
        pensionEmployeeBasisPoints: ee ? pct(ee) : null, pensionEmployeeFixedMinor: optEuro(flags, 'pension-ee-fixed') ?? null,
        pensionEmployerBasisPoints: er ? pct(er) : null, pensionEmployerFixedMinor: optEuro(flags, 'pension-er-fixed') ?? null,
      });
    }
    case 'record-rpn': {
      const exempt = hasFlag(flags, 'usc-exempt');
      const basis = need(flags, 'basis') as 'cumulative';
      return recordRpn(db, {
        companyId, employeeId: need(flags, 'employee'), recordedBy: need(flags, 'by'), rpnNumber: need(flags, 'rpn'),
        taxYear: Number(need(flags, 'year')), effectiveFrom: need(flags, 'from'), taxBasis: basis,
        yearlyTaxCreditsMinor: euro(need(flags, 'credits')), yearlySrcopMinor: euro(need(flags, 'srcop')),
        uscStatus: exempt ? 'exempt' : 'ordinary', uscBasis: (getFlag(flags, 'usc-basis') ?? basis) as 'cumulative',
        uscBands: exempt ? [] : parseUscBands(need(flags, 'usc-bands')),
        previousPayMinor: optEuro(flags, 'previous-pay'), previousTaxMinor: optEuro(flags, 'previous-tax'),
        previousUscPayMinor: optEuro(flags, 'previous-usc-pay'), previousUscMinor: optEuro(flags, 'previous-usc'),
      });
    }
    case 'list-employees':
      return listEmployees(db, companyId).map((e) => ({ ...e, terms: listTerms(db, e.id), rpns: listRpns(db, e.id) }));
    case 'create-pay-run': {
      const file = getFlag(flags, 'inputs');
      const weeks = getFlag(flags, 'weeks');
      return createPayRun(db, {
        companyId, payFrequency: need(flags, 'frequency') as 'weekly', payDate: need(flags, 'pay-date'), createdBy: need(flags, 'by'),
        insurableWeeks: weeks ? Number(weeks) : null,
        inputs: file ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, PayInputs> : undefined,
      });
    }
    case 'set-pay-inputs':
      return setPayslipInputs(db, {
        companyId, runId: need(flags, 'run'), employeeId: need(flags, 'employee'), inputs: JSON.parse(need(flags, 'inputs')) as PayInputs,
      });
    case 'recompute-pay-run':
      recomputePayRun(db, { companyId, runId: need(flags, 'run') });
      return showRun(db, companyId, need(flags, 'run'));
    case 'show-pay-run':
      return showRun(db, companyId, need(flags, 'run'));
    case 'post-pay-run':
      return postPayRun(db, { companyId, runId: need(flags, 'run'), postedBy: need(flags, 'by') });
    case 'reverse-pay-run':
      return reversePayRun(db, {
        companyId, runId: need(flags, 'run'), reason: need(flags, 'reason'), reversedBy: need(flags, 'by'), reversalDate: getFlag(flags, 'date') ?? null,
      });
    case 'pay-net-wages':
      return payNetWages(db, { companyId, runId: need(flags, 'run'), paidBy: need(flags, 'by'), ...paymentFlags(flags) });
    case 'pay-payroll-taxes':
      return payPayrollLiabilities(db, { companyId, month: need(flags, 'month'), paidBy: need(flags, 'by'), ...paymentFlags(flags) });
    case 'payroll-report': {
      const month = getFlag(flags, 'month');
      if (month) return monthlyPayrollSummary(db, companyId, month);
      const year = Number(need(flags, 'year'));
      const employee = getFlag(flags, 'employee');
      return employee ? employeeYearToDate(db, companyId, employee, year) : { year, employees: yearEndSummary(db, companyId, year), runs: listPayRuns(db, companyId, year) };
    }
    case 'reconcile-payroll':
      return reconcilePayroll(db, { companyId, asOf: need(flags, 'as-of') });
    default:
      throw new Error(`Unknown payroll command: ${command}`);
  }
}

function showRun(db: AppDatabase, companyId: string, runId: string) {
  return { run: getPayRun(db, companyId, runId), totals: payRunTotals(db, runId), payslips: payslipsOfRun(db, runId) };
}

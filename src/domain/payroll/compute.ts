import { and, eq, lte, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  payRuns, payslips, type PayFrequency, type PayLineKind, type PayslipRuleFigure, type PayslipTaxBasis,
} from '@/db/schema';
import { addDays, addMonths, asIsoDate, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { PERIODS_IN_YEAR, isExtraPeriod } from './calendar';
import type { Employee, EmploymentTerms } from './employees';
import { termsOn } from './employees';
import { PayrollError, PayrollFigures } from './figures';
import { rpnOn, type Rpn } from './rpn';
import { classAPrsi, cumulativeShare, taxToCutOff, uscOnBands, type UscBandShare } from './statutory';

/**
 * One employee's payslip on one run (issues #525, #526): the pay lines, then
 * PAYE, USC and PRSI, then net pay. Pure of side effects: it reads the book
 * and returns figures; `runs.ts` stores them.
 */

/** What the person records for a pay period. Everything else is computed. */
export interface PayInputs {
  /** Hours worked at the basic rate, in hundredths (an hourly employment). */
  hoursHundredths?: number | null;
  /** A salary figure for a part period (a joiner or leaver), in place of the period's share. */
  salaryOverrideMinor?: number | null;
  overtime?: Array<{ hoursHundredths: number; multiplierBasisPoints: number; description?: string }>;
  bonuses?: Array<{ kind: 'bonus' | 'commission'; amountMinor: number; description?: string }>;
  benefits?: Array<{
    category: 'car' | 'van' | 'preferential_loan' | 'employer_asset' | 'other';
    amountMinor: number; description?: string;
  }>;
}

export interface ComputedLine {
  kind: PayLineKind;
  description: string;
  quantityHundredths: number | null;
  rateMinor: number | null;
  multiplierBasisPoints: number | null;
  benefitCategory: 'car' | 'van' | 'preferential_loan' | 'employer_asset' | 'other' | null;
  amountMinor: number;
}

export interface ComputedPayslip {
  employeeId: string;
  rpnId: string | null;
  employmentTermsId: string;
  taxBasis: PayslipTaxBasis;
  uscBasis: 'cumulative' | 'week1' | 'emergency' | 'exempt';
  periodNumber: number;
  lines: ComputedLine[];
  grossPayMinor: number;
  notionalPayMinor: number;
  pensionEmployeeMinor: number;
  pensionEmployerMinor: number;
  payForTaxMinor: number;
  taxMinor: number;
  cumulativePayForTaxMinor: number;
  cumulativeTaxMinor: number;
  cumulativeSrcopMinor: number;
  cumulativeCreditsMinor: number;
  payForUscMinor: number;
  uscMinor: number;
  cumulativePayForUscMinor: number;
  cumulativeUscMinor: number;
  prsiClass: string;
  insurableWeeks: number;
  reckonableEarningsMinor: number;
  prsiEmployeeMinor: number;
  prsiEmployerMinor: number;
  ntfLevyMinor: number;
  netPayMinor: number;
  ruleFigures: PayslipRuleFigure[];
  working: string[];
  findings: string[];
}

export interface RunContext {
  id: string;
  payFrequency: PayFrequency;
  payDate: IsoDate;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  taxYear: number;
  periodNumber: number;
  insurableWeeks: number;
}

const eur = (minor: number) => (minor / 100).toFixed(2);
const pct = (bp: number) => `${bp / 100}%`;

/** Year to date: the employee's posted payslips this tax year on or before the pay date, other than this run's. */
export function yearToDate(db: AppDatabase, employeeId: string, run: Pick<RunContext, 'id' | 'taxYear' | 'payDate'>) {
  const row = db.select({
    payForTax: sql<number>`coalesce(sum(${payslips.payForTaxMinor}), 0)`,
    tax: sql<number>`coalesce(sum(${payslips.taxMinor}), 0)`,
    payForUsc: sql<number>`coalesce(sum(${payslips.payForUscMinor}), 0)`,
    usc: sql<number>`coalesce(sum(${payslips.uscMinor}), 0)`,
    count: sql<number>`count(*)`,
  }).from(payslips).innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .where(and(
      eq(payslips.employeeId, employeeId),
      eq(payRuns.taxYear, run.taxYear),
      eq(payRuns.status, 'posted'),
      ne(payRuns.id, run.id),
      lte(payRuns.payDate, run.payDate),
    )).get()!;
  return { payForTaxMinor: row.payForTax, taxMinor: row.tax, payForUscMinor: row.payForUsc, uscMinor: row.usc, count: row.count };
}

/** The first pay date on which this employer paid the employee: the start of the emergency window (reg.19(3)(a)). */
function firstPayDate(db: AppDatabase, employeeId: string, runId: string): string | null {
  return db.select({ d: sql<string | null>`min(${payRuns.payDate})` }).from(payslips)
    .innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .where(and(eq(payslips.employeeId, employeeId), eq(payRuns.status, 'posted'), ne(payRuns.id, runId))).get()?.d ?? null;
}

function payLines(terms: EmploymentTerms, run: RunContext, inputs: PayInputs, findings: string[], working: string[]): ComputedLine[] {
  const lines: ComputedLine[] = [];
  const periods = PERIODS_IN_YEAR[run.payFrequency];
  const blank = { quantityHundredths: null, rateMinor: null, multiplierBasisPoints: null, benefitCategory: null };
  if (terms.payBasis === 'salary') {
    const annual = terms.annualSalaryMinor!;
    if (inputs.salaryOverrideMinor !== null && inputs.salaryOverrideMinor !== undefined) {
      const amount = asMinor(inputs.salaryOverrideMinor);
      if (amount < 0) throw new PayrollError('A salary figure cannot be negative.');
      lines.push({ kind: 'salary', description: 'Salary (the figure recorded for this period)', ...blank, amountMinor: amount });
      working.push(`Salary: ${eur(amount)} recorded for this period in place of the period's share of ${eur(annual)}.`);
    } else if (isExtraPeriod(run.payFrequency, run.periodNumber)) {
      const amount = Math.floor(annual / periods);
      lines.push({ kind: 'salary', description: `Salary: ${eur(annual)} ÷ ${periods}`, ...blank, amountMinor: amount });
      findings.push(`Period ${run.periodNumber} is beyond the ${periods} periods a year holds, so this salary payment is one more `
        + `${eur(amount)} on top of the year's ${eur(annual)}. If the contract pays the salary over ${periods} periods only, `
        + 'record the figure for this period instead.');
    } else {
      // The year's salary spread over its periods: the remainder of the division falls to the periods
      // whose cumulative share crosses a cent, so the year's payments sum exactly to the salary.
      const k = run.periodNumber;
      const amount = Math.floor((annual * k) / periods) - Math.floor((annual * (k - 1)) / periods);
      lines.push({ kind: 'salary', description: `Salary: ${eur(annual)} a year, period ${k} of ${periods}`, ...blank, amountMinor: amount });
    }
  } else {
    const hours = inputs.hoursHundredths ?? 0;
    if (!Number.isInteger(hours) || hours < 0) throw new PayrollError('Hours are recorded in hundredths, and are not negative.');
    const rate = terms.hourlyRateMinor!;
    if (hours > 0) {
      lines.push({
        kind: 'hourly', description: `${(hours / 100).toFixed(2)} hours at ${eur(rate)}`,
        quantityHundredths: hours, rateMinor: rate, multiplierBasisPoints: null, benefitCategory: null,
        amountMinor: multiplyRational(rate, hours, 100),
      });
    }
  }
  for (const ot of inputs.overtime ?? []) {
    if (!Number.isInteger(ot.hoursHundredths) || ot.hoursHundredths <= 0) throw new PayrollError('Overtime hours are a positive number of hundredths.');
    if (!Number.isInteger(ot.multiplierBasisPoints) || ot.multiplierBasisPoints <= 0) {
      throw new PayrollError('Record the overtime multiplier (15000 for time and a half): no premium is assumed.');
    }
    const base = terms.hourlyRateMinor;
    if (!base) {
      throw new PayrollError('Overtime is hours × the hourly rate × the multiplier, and these terms state no hourly rate. '
        + 'Record the hourly rate on the employment terms, or pay the overtime as a bonus.');
    }
    lines.push({
      kind: 'overtime',
      description: ot.description?.trim() || `Overtime: ${(ot.hoursHundredths / 100).toFixed(2)} hours at ${eur(base)} × ${ot.multiplierBasisPoints / 10_000}`,
      quantityHundredths: ot.hoursHundredths, rateMinor: base, multiplierBasisPoints: ot.multiplierBasisPoints, benefitCategory: null,
      amountMinor: multiplyRational(base * ot.hoursHundredths, ot.multiplierBasisPoints, 100 * 10_000),
    });
  }
  for (const b of inputs.bonuses ?? []) {
    const amount = asMinor(b.amountMinor);
    if (amount <= 0) throw new PayrollError('A bonus or commission is a positive amount.');
    lines.push({ kind: b.kind, description: b.description?.trim() || (b.kind === 'bonus' ? 'Bonus' : 'Commission'), ...blank, amountMinor: amount });
  }
  for (const b of inputs.benefits ?? []) {
    const amount = asMinor(b.amountMinor);
    if (amount <= 0) throw new PayrollError('A benefit in kind is a positive taxable value.');
    lines.push({
      kind: 'benefit_in_kind', description: b.description?.trim() || `Benefit in kind (${b.category.replace('_', ' ')})`,
      quantityHundredths: null, rateMinor: null, multiplierBasisPoints: null, benefitCategory: b.category, amountMinor: amount,
    });
  }
  if (inputs.benefits?.length) {
    findings.push('Benefits in kind are taxed at the value recorded: their valuation (TCA s.119–s.122) is not computed here. '
      + 'A car, van, preferential loan or employer-asset benefit is the period\'s share of the year\'s value (S.I. 345/2018 reg.14).');
  }
  return lines;
}

function pensionOf(basisPoints: number | null, fixed: number | null, grossMinor: number): number {
  if (fixed !== null) return fixed;
  if (basisPoints !== null) return multiplyRational(grossMinor, basisPoints, 10_000);
  return 0;
}

/** Compute one employee's payslip on a run. Throws a PayrollError rather than produce a figure it cannot stand behind. */
export function computePayslip(db: AppDatabase, params: {
  companyId: string; run: RunContext; employee: Employee; inputs: PayInputs;
}): ComputedPayslip {
  const { run, employee, inputs } = params;
  const name = `${employee.firstName} ${employee.lastName}`;
  const findings: string[] = [];
  const working: string[] = [];
  const periods = PERIODS_IN_YEAR[run.payFrequency];
  const extra = isExtraPeriod(run.payFrequency, run.periodNumber);

  if (employee.prsiClass !== 'A' && employee.prsiClass !== 'S') {
    throw new PayrollError(`${name} is recorded on PRSI Class ${employee.prsiClass}. Only Classes A and S are computed; `
      + 'no other class is approximated. Record the payslip outside Leabhar until that class is built.', { employeeId: employee.id });
  }
  const terms = termsOn(db, employee.id, run.payDate);
  if (!terms) throw new PayrollError(`${name} has no employment terms in force on ${run.payDate}. Record the pay basis first.`, { employeeId: employee.id });
  if (employee.startDate > run.periodStart || (employee.leftOn && employee.leftOn < run.periodEnd)) {
    findings.push(`${name} joined or left during this period: a salary is paid in full unless the part period's figure is recorded.`);
  }

  const figures = new PayrollFigures(db, params.companyId, run.payDate);
  const lines = payLines(terms, run, inputs, findings, working);
  const gross = lines.filter((l) => l.kind !== 'benefit_in_kind').reduce((s, l) => s + l.amountMinor, 0);
  const notional = lines.filter((l) => l.kind === 'benefit_in_kind').reduce((s, l) => s + l.amountMinor, 0);

  // ---- Pension (S.I. 345/2018 reg.31) ----
  const pensionEe = terms.pensionScheme === 'none' ? 0 : pensionOf(terms.pensionEmployeeBasisPoints, terms.pensionEmployeeFixedMinor, gross);
  const pensionEr = terms.pensionScheme === 'none' ? 0 : pensionOf(terms.pensionEmployerBasisPoints, terms.pensionEmployerFixedMinor, gross);
  if (pensionEe || pensionEr) {
    figures.cite('paye.pension_deduction');
    working.push(`Pension (${terms.pensionScheme}): employee ${eur(pensionEe)}, employer ${eur(pensionEr)}. The employee's `
      + 'contribution comes off pay for income tax only; USC and PRSI are charged on pay before it.');
    findings.push('Pension relief is given in full through payroll: the age-related percentage limits and the earnings cap '
      + '(TCA s.790A) are not checked here.');
  }
  const payForTax = gross + notional - pensionEe;

  // ---- PAYE (S.I. 345/2018) ----
  const rpn = rpnOn(db, employee.id, run.payDate);
  const ytd = yearToDate(db, employee.id, run);
  const standardBp = figures.rate('income_tax.band_single');
  const higherBp = figures.value('income_tax.rate_higher');
  let taxBasis: PayslipTaxBasis;
  let tax: number;
  let cumSrcop: number;
  let cumCredits: number;
  let cumPayForTax = ytd.payForTaxMinor + payForTax;
  let cumTax: number;

  const week1 = (r: Rpn) => {
    figures.cite(extra ? 'paye.week53' : 'paye.week1_basis');
    const srcop = cumulativeShare(r.yearlySrcopMinor, 1, periods);
    const credits = cumulativeShare(r.yearlyTaxCreditsMinor, 1, periods);
    const t = taxToCutOff({ payMinor: payForTax, cutOffMinor: srcop, creditsMinor: credits, standardBp, higherBp });
    working.push(`PAYE, ${extra ? 'week 53 (as if paid on 1 January, reg.15)' : 'week 1 basis (reg.20)'}: `
      + `${eur(t.atStandardMinor)} at ${pct(standardBp)} + ${eur(t.atHigherMinor)} at ${pct(higherBp)} = ${eur(t.grossTaxMinor)}, `
      + `less credits ${eur(credits)} = ${eur(t.taxMinor)}.`);
    return { tax: t.taxMinor, srcop, credits };
  };

  if (!rpn || rpn.taxBasis === 'emergency') {
    // Emergency basis (reg.19): no RPN, or Revenue's RPN says emergency.
    const first = firstPayDate(db, employee.id, run.id) ?? run.payDate;
    const windowEnd = run.payFrequency === 'monthly' ? addMonths(asIsoDate(first), 1) : addDays(asIsoDate(first), 28);
    cumCredits = 0;
    if (!employee.ppsn) {
      figures.cite('paye.emergency_no_ppsn');
      taxBasis = 'emergency_no_ppsn';
      cumSrcop = 0;
      tax = multiplyRational(payForTax, higherBp, 10_000);
      working.push(`PAYE, emergency basis without a PPSN (reg.19(2)): ${eur(payForTax)} at ${pct(higherBp)} = ${eur(tax)}.`);
    } else if (run.payDate < windowEnd) {
      figures.cite('paye.emergency_ppsn');
      taxBasis = 'emergency_initial';
      const band = figures.value('income_tax.band_single');
      cumSrcop = run.payFrequency === 'monthly'
        ? multiplyRational(band, 1, 12)
        : multiplyRational(band, run.payFrequency === 'weekly' ? 1 : 2, 52);
      const t = taxToCutOff({ payMinor: payForTax, cutOffMinor: cumSrcop, creditsMinor: 0, standardBp, higherBp });
      tax = t.taxMinor;
      working.push(`PAYE, emergency basis with a PPSN, within the first ${run.payFrequency === 'monthly' ? 'month' : '4 weeks'} `
        + `(reg.19(3)(a)): cut-off ${eur(cumSrcop)} (the ${eur(band)} single band ÷ ${run.payFrequency === 'monthly' ? '12' : '52'}`
        + `${run.payFrequency === 'fortnightly' ? ' × 2' : ''}), no credits: ${eur(t.atStandardMinor)} at ${pct(standardBp)} + `
        + `${eur(t.atHigherMinor)} at ${pct(higherBp)} = ${eur(tax)}.`);
    } else {
      figures.cite('paye.emergency_ppsn');
      taxBasis = 'emergency_higher';
      cumSrcop = 0;
      tax = multiplyRational(payForTax, higherBp, 10_000);
      working.push(`PAYE, emergency basis after the first ${run.payFrequency === 'monthly' ? 'month' : '4 weeks'} (reg.19(3)(b)): `
        + `${eur(payForTax)} at ${pct(higherBp)} = ${eur(tax)}.`);
    }
    findings.push(rpn
      ? `RPN ${rpn.rpnNumber} puts ${name} on the emergency basis.`
      : `No RPN is recorded for ${name} for ${run.taxYear}: tax is deducted on the emergency basis. Record the RPN from ROS; `
        + 'the next payslip then brings the year\'s pay and tax into the cumulative calculation (reg.19(4)).');
    cumTax = ytd.taxMinor + tax;
  } else if (rpn.taxBasis === 'week1' || extra) {
    taxBasis = 'week1';
    ({ tax, srcop: cumSrcop, credits: cumCredits } = week1(rpn));
    cumTax = ytd.taxMinor + tax;
  } else {
    // Cumulative basis (reg.11), with the RPN's previous employment figures (reg.6(1)(b)).
    figures.cite('paye.cumulative_basis');
    taxBasis = 'cumulative';
    cumPayForTax = rpn.previousPayMinor + ytd.payForTaxMinor + payForTax;
    cumSrcop = cumulativeShare(rpn.yearlySrcopMinor, run.periodNumber, periods);
    cumCredits = cumulativeShare(rpn.yearlyTaxCreditsMinor, run.periodNumber, periods);
    const t = taxToCutOff({ payMinor: cumPayForTax, cutOffMinor: cumSrcop, creditsMinor: cumCredits, standardBp, higherBp });
    const previousCumTax = rpn.previousTaxMinor + ytd.taxMinor;
    cumTax = t.taxMinor;
    tax = cumTax - previousCumTax;
    working.push(`PAYE, cumulative basis (reg.11), period ${run.periodNumber} of ${periods}: cumulative pay ${eur(cumPayForTax)}`
      + `${rpn.previousPayMinor ? ` (including ${eur(rpn.previousPayMinor)} from previous employments)` : ''}; cut-off `
      + `${eur(rpn.yearlySrcopMinor)} × ${run.periodNumber}/${periods} = ${eur(cumSrcop)}; credits ${eur(rpn.yearlyTaxCreditsMinor)} × `
      + `${run.periodNumber}/${periods} = ${eur(cumCredits)}. ${eur(t.atStandardMinor)} at ${pct(standardBp)} + ${eur(t.atHigherMinor)} at `
      + `${pct(higherBp)} = ${eur(t.grossTaxMinor)}, less credits = ${eur(cumTax)}; less ${eur(previousCumTax)} already deducted = `
      + `${tax < 0 ? `a refund of ${eur(-tax)}` : eur(tax)}.`);
  }
  if (rpn?.source === 'user') findings.push(`RPN ${rpn.rpnNumber} was entered by hand from ROS: check it against ROS before paying.`);

  // ---- USC (S.I. 510/2018) ----
  const payForUsc = gross + notional;
  let uscBasis: ComputedPayslip['uscBasis'];
  let usc: number;
  let cumPayForUsc = ytd.payForUscMinor + payForUsc;
  let cumUsc: number;
  const knownRates = new Set([
    figures.rate('usc.band_05pct'), figures.rate('usc.band_2pct'), figures.rate('usc.band_3pct'), figures.value('usc.rate_top'),
  ]);
  if (rpn && rpn.uscStatus === 'exempt') {
    uscBasis = 'exempt';
    usc = 0;
    cumUsc = ytd.uscMinor;
    working.push(`USC: RPN ${rpn.rpnNumber} is USC-exempt (S.I. 510/2018 reg.8(2), reg.12(2)): none deducted.`);
  } else if (!rpn || rpn.uscBasis === 'emergency') {
    figures.cite('usc.payroll_emergency');
    uscBasis = 'emergency';
    const top = figures.value('usc.rate_top');
    usc = multiplyRational(payForUsc, top, 10_000);
    cumUsc = ytd.uscMinor + usc;
    working.push(`USC, emergency basis (reg.19(1)): ${eur(payForUsc)} at ${pct(top)} = ${eur(usc)}.`);
  } else {
    for (const b of rpn.uscBands) {
      if (!knownRates.has(b.rateBasisPoints)) {
        findings.push(`RPN ${rpn.rpnNumber} lists a USC rate of ${pct(b.rateBasisPoints)}, which is not one of the s.531AN rates `
          + 'the knowledge base holds for this date. It is used as notified (reg.10(3)); check it against ROS.');
      }
    }
    const weekOne = rpn.uscBasis === 'week1' || extra;
    const c = weekOne ? 1 : run.periodNumber;
    const bands: UscBandShare[] = rpn.uscBands.map((b) => ({
      rateBasisPoints: b.rateBasisPoints,
      bandMinor: b.yearlyBandMinor === null ? null : cumulativeShare(b.yearlyBandMinor, c, periods),
    }));
    const describe = (ls: ReturnType<typeof uscOnBands>['lines']) => ls.map((l) => `${eur(l.payMinor)} at ${pct(l.rateBasisPoints)}`).join(' + ');
    if (weekOne) {
      uscBasis = 'week1';
      const r = uscOnBands(payForUsc, bands);
      usc = r.uscMinor;
      cumUsc = ytd.uscMinor + usc;
      working.push(`USC, ${extra ? 'week 53 (reg.16)' : 'week 1 basis'}: ${describe(r.lines) || '0.00'} = ${eur(usc)}.`);
    } else {
      figures.cite('usc.payroll_cumulative');
      uscBasis = 'cumulative';
      cumPayForUsc = rpn.previousUscPayMinor + ytd.payForUscMinor + payForUsc;
      const r = uscOnBands(cumPayForUsc, bands);
      const previousUsc = rpn.previousUscMinor + ytd.uscMinor;
      usc = r.uscMinor - previousUsc;
      cumUsc = r.uscMinor;
      working.push(`USC, cumulative basis (reg.14), period ${run.periodNumber} of ${periods}: cumulative pay ${eur(cumPayForUsc)}: `
        + `${describe(r.lines)} = ${eur(r.uscMinor)}; less ${eur(previousUsc)} already deducted = `
        + `${usc < 0 ? `a refund of ${eur(-usc)}` : eur(usc)}.`);
    }
  }

  // ---- PRSI: Class A (SWCA 2005 s.13; NTF Act 2000 s.4) or Class S (s.21(1)(c)) ----
  if (rpn?.prsiExempt) {
    throw new PayrollError(`RPN ${rpn.rpnNumber} marks ${name} as exempt from PRSI. The class that applies in its place `
      + '(for example J or M) is not computed; no other class is approximated.', { employeeId: employee.id });
  }
  const reckonable = gross + notional;
  let prsi: ReturnType<typeof classAPrsi>;
  if (employee.prsiClass === 'S') {
    // Class S (SWCA 2005 s.21(1)(c)): the rate on all reckonable emoluments; no threshold, credit or employer share.
    const rate = figures.value('prsi.class_s_emoluments_rate');
    prsi = { employeeMinor: multiplyRational(reckonable, rate, 10_000), creditMinor: 0, employerMinor: 0, ntfLevyMinor: 0, band: 'full' };
    working.push(`PRSI Class S on reckonable emoluments of ${eur(reckonable)} at ${pct(rate)} = ${eur(prsi.employeeMinor)}; `
      + 'no employer contribution and no NTF levy.');
    findings.push(`${name} is on PRSI Class S. The contribution year's €650 minimum (s.21(1)(a), (c), (f)) is tested on the `
      + 'director\'s whole income for the year and settled on their own return, not through payroll.');
  } else {
    prsi = classAPrsi(reckonable, run.insurableWeeks, {
      employeeThresholdMinor: figures.value('prsi.class_a_employee_threshold'),
      creditUpperMinor: figures.value('prsi.class_a_credit_upper'),
      creditMaxMinor: figures.value('prsi.class_a_credit_max'),
      employeeRateBp: figures.value('prsi.class_a_employee_rate'),
      employerThresholdMinor: figures.value('prsi.class_a_employer_threshold'),
      employerLowerRateBp: figures.value('prsi.class_a_employer_rate_lower'),
      employerHigherRateBp: figures.value('prsi.class_a_employer_rate_higher'),
      ntfLevyRateBp: figures.value('prsi.ntf_levy_rate'),
    });
    working.push(`PRSI Class A on reckonable earnings of ${eur(reckonable)} over ${run.insurableWeeks} insurable week`
      + `${run.insurableWeeks === 1 ? '' : 's'}: employee ${eur(prsi.employeeMinor)}`
      + `${prsi.band === 'credit' ? ` (after a PRSI credit of ${eur(prsi.creditMinor)})` : prsi.band === 'nil' ? ' (at or below the threshold)' : ''}; `
      + `employer ${eur(prsi.employerMinor)}; National Training Fund levy ${eur(prsi.ntfLevyMinor)}.`);
    if (run.payFrequency === 'monthly') {
      findings.push(`The PRSI thresholds and credit are applied per insurable week (${run.insurableWeeks} this month). How the `
        + 'weekly figures convert for monthly pay awaits confirmation (issue #529).');
    }
  }

  // ---- Net pay ----
  const net = gross - pensionEe - tax - usc - prsi.employeeMinor;
  working.push(`Net pay: ${eur(gross)} gross − ${eur(pensionEe)} pension − ${eur(tax)} PAYE − ${eur(usc)} USC − `
    + `${eur(prsi.employeeMinor)} PRSI = ${eur(net)}.`);
  if (notional) working.push(`Benefits in kind of ${eur(notional)} are taxed but not paid: they are not in net pay.`);
  if (net < 0) {
    throw new PayrollError(`${name}'s deductions (${eur(gross - net)}) exceed their cash pay of ${eur(gross)} on this run. `
      + 'The tax on a benefit that cash pay cannot cover is a matter for the employer to settle with Revenue (TCA s.985A(4)); '
      + 'it is not computed here.', { employeeId: employee.id });
  }

  return {
    employeeId: employee.id, rpnId: rpn?.id ?? null, employmentTermsId: terms.id,
    taxBasis, uscBasis, periodNumber: run.periodNumber, lines,
    grossPayMinor: gross, notionalPayMinor: notional, pensionEmployeeMinor: pensionEe, pensionEmployerMinor: pensionEr,
    payForTaxMinor: payForTax, taxMinor: tax,
    cumulativePayForTaxMinor: cumPayForTax, cumulativeTaxMinor: cumTax,
    cumulativeSrcopMinor: cumSrcop, cumulativeCreditsMinor: cumCredits,
    payForUscMinor: payForUsc, uscMinor: usc, cumulativePayForUscMinor: cumPayForUsc, cumulativeUscMinor: cumUsc,
    prsiClass: employee.prsiClass, insurableWeeks: run.insurableWeeks, reckonableEarningsMinor: reckonable,
    prsiEmployeeMinor: prsi.employeeMinor, prsiEmployerMinor: prsi.employerMinor, ntfLevyMinor: prsi.ntfLevyMinor,
    netPayMinor: net,
    ruleFigures: figures.snapshot(), working, findings: [...findings, ...figures.findings()],
  };
}

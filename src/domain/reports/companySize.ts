import { and, eq, isNull, lte, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accountingPeriods, companies, companySizeDecisions, employees,
  COMPANY_SIZE_DECISION_KINDS, COMPANY_SIZE_EXCLUSIONS, COMPANY_SIZES,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, addYears, isIsoDate, parts, makeDate, daysInMonth, type IsoDate } from '../dates';
import { auditRuleFigures } from '../rules/ruleFigures';
import { COMPANIES_ACT_2014_CURATED_RULES } from '../rules/companiesAct2014Curation';
import { profitAndLoss } from './financial';
import { schedule3ABalanceSheet } from './schedule3A';

/**
 * Company size under the Companies Act 2014 (issue #554): micro (s.280D),
 * small (s.280A), medium (s.280F) or large, for a financial year.
 *
 * The figures are the books': turnover is the trading income on the profit
 * and loss account; the balance sheet total is fixed plus current assets on
 * the Schedule 3A layout (items A and B); the average number of employees is
 * the person's recorded figure or, failing that, worked out from payroll. The
 * thresholds are the curated rules, resolved as of the year end. The turnover
 * limb is adjusted proportionately for a financial year that is not a year.
 *
 * The two-year rule (s.280A(2), s.280D(2), s.280F(2)) needs the year before:
 * from the books where they hold it, otherwise from what a person records.
 * Exclusions (a holding company, an ineligible company and the rest) are a
 * person's decision too. Where something needed is missing the result says
 * which, and the size is left open rather than guessed.
 */

export class CompanySizeError extends Error {}

export type CompanySize = 'micro' | 'small' | 'medium' | 'large';
type Tested = 'micro' | 'small' | 'medium';
type Tri = boolean | null;
type DecisionKind = (typeof COMPANY_SIZE_DECISION_KINDS)[number];

const RANK: Record<string, number> = { micro: 0, small: 1, medium: 2, large: 3 };
const LIMBS = [
  { limb: 'turnover', key: 'turnover_threshold' },
  { limb: 'balance_sheet', key: 'balance_sheet_threshold' },
  { limb: 'employees', key: 'employee_threshold' },
] as const;
const SECTION: Record<Tested, string> = { micro: 's.280D', small: 's.280A', medium: 's.280F' };

export interface SizeLimb {
  limb: 'turnover' | 'balance_sheet' | 'employees';
  ruleKey: string;
  /** Minor units for money, a count for employees; null when not known. */
  value: number | null;
  threshold: number;
  /** The threshold after a proportionate adjustment (turnover in a short or long year). */
  appliedThreshold: number;
  met: Tri;
}

export interface SizeConditions { size: Tested; limbs: SizeLimb[]; met: Tri }

export interface YearAssessment {
  start: IsoDate;
  end: IsoDate;
  isFullYear: boolean;
  turnoverMinor: number;
  balanceSheetTotalMinor: number;
  employees: { average: number | null; employeeMonths: number | null; months: number; source: 'recorded' | 'payroll' | null; note: string | null };
  /** Null when no thresholds are in force for the year. */
  conditions: SizeConditions[] | null;
}

export interface CompanySizeResult {
  companyId: string;
  status: 'classified' | 'needs_decision' | 'excluded' | 'not_applicable' | 'no_thresholds';
  size: CompanySize | null;
  /** The regime the size opens, in words. */
  consequence: string | null;
  year: YearAssessment;
  previous: YearAssessment | null;
  exclusion: string | null;
  firstFinancialYear: boolean;
  qualifies: Record<Tested, Tri>;
  /** How the two-year rule was applied, one line per size tested. */
  basis: string[];
  openPoints: string[];
  findings: string[];
}

const and3 = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (...xs: Tri[]): Tri => (xs.some((x) => x === true) ? true : xs.some((x) => x === null) ? null : false);
/** Two or more of three, where an unknown limb could go either way. */
function twoOfThree(limbs: Tri[]): Tri {
  const yes = limbs.filter((l) => l === true).length;
  const unknown = limbs.filter((l) => l === null).length;
  if (yes >= 2) return true;
  if (yes + unknown < 2) return false;
  return null;
}

function financialYears(db: AppDatabase, companyId: string) {
  return db.select().from(accountingPeriods)
    .where(and(eq(accountingPeriods.companyId, companyId), eq(accountingPeriods.kind, 'financial_year')))
    .orderBy(accountingPeriods.startDate).all();
}

function decision(db: AppDatabase, companyId: string, kind: DecisionKind, financialYearEnd: string, carryForward = false) {
  return db.select().from(companySizeDecisions).where(and(
    eq(companySizeDecisions.companyId, companyId), eq(companySizeDecisions.kind, kind), isNull(companySizeDecisions.supersededById),
    carryForward ? lte(companySizeDecisions.financialYearEnd, financialYearEnd) : eq(companySizeDecisions.financialYearEnd, financialYearEnd),
  )).orderBy(desc(companySizeDecisions.financialYearEnd)).get();
}

/** Record what the books cannot know about a year's size. Any earlier choice for the same year is kept and marked superseded. */
export function recordCompanySizeDecision(db: AppDatabase, params: {
  companyId: string; financialYearEnd: string; kind: DecisionKind; choice?: string | null; count?: number | null; decidedBy: string; note?: string | null;
}): { id: string } {
  if (!params.decidedBy.trim()) throw new CompanySizeError('Say who is deciding.');
  if (!COMPANY_SIZE_DECISION_KINDS.includes(params.kind)) throw new CompanySizeError(`Unknown decision: ${params.kind}.`);
  const year = financialYears(db, params.companyId).find((y) => y.endDate === params.financialYearEnd);
  if (!year) throw new CompanySizeError(`No financial year ends on ${params.financialYearEnd}.`);
  let choice: string | null = null;
  let count: number | null = null;
  if (params.kind === 'average_employees') {
    if (params.count === null || params.count === undefined || !Number.isInteger(params.count) || params.count < 0) {
      throw new CompanySizeError('The average number of employees is a whole number, zero or more.');
    }
    if (!params.note?.trim()) throw new CompanySizeError('Say how the average was worked out (s.317 counts each month\'s employees).');
    count = params.count;
  } else {
    const allowed: readonly string[] = params.kind === 'exclusion' ? COMPANY_SIZE_EXCLUSIONS
      : params.kind === 'prior_year_size' ? COMPANY_SIZES : COMPANY_SIZES.filter((s) => s !== 'first_financial_year');
    if (!params.choice || !allowed.includes(params.choice)) throw new CompanySizeError(`Choose one of: ${allowed.join(', ')}.`);
    choice = params.choice;
  }
  const id = ids.companySizeDecision();
  const previous = decision(db, params.companyId, params.kind, params.financialYearEnd);
  db.transaction((tx) => {
    tx.insert(companySizeDecisions).values({
      id, companyId: params.companyId, financialYearEnd: params.financialYearEnd, kind: params.kind, choice, count,
      decidedBy: params.decidedBy, note: params.note ?? null,
    }).run();
    if (previous) tx.update(companySizeDecisions).set({ supersededById: id }).where(eq(companySizeDecisions.id, previous.id)).run();
  });
  return { id };
}

/** Employees on payroll in each month of the year, whether throughout the month or not. */
function payrollEmployeeMonths(db: AppDatabase, companyId: string, start: IsoDate, end: IsoDate): { employeeMonths: number; months: number; any: boolean } {
  const staff = db.select({ startDate: employees.startDate, leftOn: employees.leftOn }).from(employees).where(eq(employees.companyId, companyId)).all();
  let months = 0;
  let employeeMonths = 0;
  for (let { year, month } = parts(start); makeDate(year, month, 1) <= end;) {
    const first = makeDate(year, month, 1);
    const last = makeDate(year, month, daysInMonth(year, month));
    months += 1;
    employeeMonths += staff.filter((e) => e.startDate <= last && (!e.leftOn || e.leftOn >= first)).length;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return { employeeMonths, months, any: staff.length > 0 };
}

function assessYear(db: AppDatabase, companyId: string, start: IsoDate, end: IsoDate, findings: Set<string>): YearAssessment {
  const isFullYear = addDays(addYears(start, 1), -1) === end;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  const turnoverMinor = profitAndLoss(db, { companyId, from: start, to: end }).revenue.valueMinor;
  const balanceSheetTotalMinor = schedule3ABalanceSheet(db, { companyId, asOf: end, financialYearStart: start }).balanceSheetTotalMinor;

  const recorded = decision(db, companyId, 'average_employees', end);
  const payroll = payrollEmployeeMonths(db, companyId, start, end);
  const emp: YearAssessment['employees'] = recorded
    ? { average: recorded.count, employeeMonths: recorded.count! * payroll.months, months: payroll.months, source: 'recorded', note: recorded.note }
    : payroll.any
      ? { average: Math.round((payroll.employeeMonths / payroll.months) * 100) / 100, employeeMonths: payroll.employeeMonths, months: payroll.months, source: 'payroll',
        note: 'Employees on payroll in each month (whether throughout the month or not), averaged over the months of the year. Directors on payroll are counted.' }
      : { average: null, employeeMonths: null, months: payroll.months, source: null, note: null };

  const audit = auditRuleFigures(db, { companyId, asOfDate: end, curated: COMPANIES_ACT_2014_CURATED_RULES });
  const figure = (ruleKey: string): number | null => {
    const f = audit.figure(ruleKey);
    if (f.status === 'rejected' || f.status === 'retired') return null;
    if (f.numericValue !== null) return f.numericValue;
    return f.curatedValue !== null && f.curatedInForce ? f.curatedValue : null;
  };
  const conditions: SizeConditions[] = [];
  for (const size of ['micro', 'small', 'medium'] as const) {
    const limbs: SizeLimb[] = [];
    for (const { limb, key } of LIMBS) {
      const ruleKey = `company.${size}_company_${key}`;
      const threshold = figure(ruleKey);
      if (threshold === null) return { start, end, isFullYear, turnoverMinor, balanceSheetTotalMinor, employees: emp, conditions: null };
      if (limb === 'turnover') {
        const applied = isFullYear ? threshold : Math.floor((threshold * days) / 365);
        limbs.push({ limb, ruleKey, value: turnoverMinor, threshold, appliedThreshold: applied,
          met: isFullYear ? turnoverMinor <= threshold : turnoverMinor * 365 <= threshold * days });
      } else if (limb === 'balance_sheet') {
        limbs.push({ limb, ruleKey, value: balanceSheetTotalMinor, threshold, appliedThreshold: threshold, met: balanceSheetTotalMinor <= threshold });
      } else {
        limbs.push({ limb, ruleKey, value: emp.average, threshold, appliedThreshold: threshold,
          met: emp.employeeMonths === null ? null : emp.employeeMonths <= threshold * emp.months });
      }
    }
    conditions.push({ size, limbs, met: twoOfThree(limbs.map((l) => l.met)) });
  }
  for (const f of audit.findings()) findings.add(f);
  return { start, end, isFullYear, turnoverMinor, balanceSheetTotalMinor, employees: emp, conditions };
}

export function companySize(db: AppDatabase, params: { companyId: string; financialYearEnd: string }): CompanySizeResult {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new CompanySizeError(`Company ${params.companyId} not found.`);
  if (!isIsoDate(params.financialYearEnd)) throw new CompanySizeError('The financial year end is a YYYY-MM-DD date.');
  const years = financialYears(db, params.companyId);
  const target = years.find((y) => y.endDate === params.financialYearEnd);
  if (!target) throw new CompanySizeError(`No financial year ends on ${params.financialYearEnd}.`);

  const findings = new Set<string>();
  const assessments = new Map<string, YearAssessment>();
  const assess = (y: typeof target) => {
    const cached = assessments.get(y.endDate);
    if (cached) return cached;
    const a = assessYear(db, params.companyId, y.startDate as IsoDate, y.endDate as IsoDate, findings);
    assessments.set(y.endDate, a);
    return a;
  };
  const year = assess(target);
  const openPoints: string[] = [];
  const basis: string[] = [];
  const exclusionRow = decision(db, params.companyId, 'exclusion', target.endDate, true);
  const exclusion = exclusionRow?.choice ?? null;
  const prevOf = (y: typeof target) => years.find((p) => p.endDate === addDays(y.startDate as IsoDate, -1));
  const previousPeriod = prevOf(target);
  const previous = previousPeriod ? assess(previousPeriod) : null;

  const base = {
    companyId: params.companyId, year, previous, exclusion, basis, openPoints,
  };
  if (company.entityType !== 'company') {
    return { ...base, status: 'not_applicable', size: null, consequence: null, firstFinancialYear: false,
      qualifies: { micro: null, small: null, medium: null }, openPoints: [`Company size applies to companies; this book is a ${company.entityType.replace('_', ' ')}.`], findings: [...findings] };
  }
  if (!year.conditions) {
    return { ...base, status: 'no_thresholds', size: null, consequence: null, firstFinancialYear: false,
      qualifies: { micro: null, small: null, medium: null },
      openPoints: ['No size thresholds are in force for this year in the rules held. The thresholds held apply from 1 July 2024 (S.I. No. 301 of 2024); earlier figures are not in the sources.'],
      findings: [...findings] };
  }

  const isFirst = (y: typeof target) => decision(db, params.companyId, 'prior_year_size', y.endDate)?.choice === 'first_financial_year'
    || (!!company.dateIncorporated && company.dateIncorporated >= y.startDate);
  const met = (size: Tested, y: typeof target): Tri => assess(y).conditions?.find((c) => c.size === size)?.met ?? null;
  const memo = new Map<string, Tri>();
  const qualifies = (size: Tested, y: typeof target): Tri => {
    const k = `${size}:${y.endDate}`;
    if (memo.has(k)) return memo.get(k)!;
    let result: Tri;
    const mY = met(size, y);
    if (isFirst(y)) {
      result = mY;
    } else {
      const prev = prevOf(y);
      let mP: Tri = prev ? met(size, prev) : null;
      let qP: Tri = prev ? qualifies(size, prev) : null;
      if (mP === null) {
        const recorded = decision(db, params.companyId, 'prior_year_conditions', y.endDate)?.choice;
        if (recorded) mP = RANK[recorded]! <= RANK[size]!;
      }
      if (qP === null) {
        const recorded = decision(db, params.companyId, 'prior_year_size', y.endDate)?.choice;
        if (recorded && recorded !== 'first_financial_year') {
          qP = recorded === size || (size === 'small' && recorded === 'micro');
        }
      }
      result = or3(and3(mY, mP), and3(mY, qP), and3(mP, qP));
    }
    memo.set(k, result);
    return result;
  };

  const first = isFirst(target);
  const q: Record<Tested, Tri> = { micro: qualifies('micro', target), small: qualifies('small', target), medium: qualifies('medium', target) };
  for (const size of ['micro', 'small', 'medium'] as const) {
    const mY = met(size, target);
    basis.push(first
      ? `${size} (${SECTION[size]}): the first financial year, so the conditions in this year decide: ${mY === null ? 'not known' : mY ? 'met' : 'not met'}.`
      : `${size} (${SECTION[size]}): conditions ${mY === null ? 'not known' : mY ? 'met' : 'not met'} this year; `
        + `${q[size] === null ? 'the year before is needed to decide' : q[size] ? 'qualifies under the two-year rule' : 'does not qualify'}.`);
  }

  // Exclusions: the person's decision.
  let status: CompanySizeResult['status'] = 'classified';
  if (exclusion === 'holding_company') {
    openPoints.push('A holding company\'s size is its group\'s (s.280B, and s.280F(4)(a) for medium): the group test aggregates every member\'s figures, which these books do not hold. Decide the size from the group figures.');
    return { ...base, status: 'excluded', size: null, consequence: null, firstFinancialYear: first, qualifies: q, findings: [...findings] };
  }
  if (exclusion === 'ineligible_company') { q.small = false; q.micro = false; q.medium = false; basis.push('An ineligible company cannot be small or micro (s.280A(4)(b)) or medium (s.280F(4)(b)).'); }
  if (exclusion === 'investment_undertaking' || exclusion === 'financial_holding_undertaking' || exclusion === 'subsidiary_in_consolidation') {
    q.micro = false; basis.push(`Excluded from the micro companies regime (s.280D(4)): ${exclusion.replace(/_/g, ' ')}.`);
  }
  if (!exclusion) {
    status = 'needs_decision';
    openPoints.push('Record whether an exclusion applies (a holding company, an ineligible company, an investment undertaking, a financial holding undertaking, or a subsidiary in a higher group\'s consolidated statements), or none. The size below assumes none.');
  }

  let size: CompanySize | null;
  if (q.small === true) size = q.micro === true ? 'micro' : q.micro === false ? 'small' : null;
  else if (q.small === false) size = q.medium === true ? 'medium' : q.medium === false ? 'large' : null;
  else size = null;

  if (size === null) {
    status = 'needs_decision';
    if (!first && !previousPeriod) {
      openPoints.push('The year before is not in these books. Record the size the company qualified as in that year (or that this is its first financial year), and the smallest size whose conditions it met that year.');
    } else if (!first) {
      openPoints.push('The year before cannot be assessed from these books. Record the size the company qualified as in that year, and the smallest size whose conditions it met.');
    }
    if (year.employees.source === null) openPoints.push('Record the average number of employees for the year (s.317 methods): payroll holds no employees.');
  } else if (year.employees.source === null) {
    openPoints.push('Payroll holds no employees and no average has been recorded; the employee limb was left out, and the size rests on the other two limbs.');
  }
  if (target.startDate < '2024-07-01') {
    openPoints.push('This year began before 1 July 2024. The thresholds used were substituted from that date by S.I. No. 301 of 2024, "in effect as per reg. 2"; confirm under reg. 2 that they apply to this financial year.');
  }

  const consequence = size === 'micro' ? 'The micro companies regime is open to the company (s.280E), and with it the small companies regime (s.280C): Schedule 3A formats.'
    : size === 'small' ? 'The small companies regime applies (s.280C): the entity financial statements may follow Schedule 3A.'
    : size === 'medium' ? 'A medium company: neither regime applies. The full formats (Schedule 3) are not prepared here.'
    : size === 'large' ? 'A large company: neither regime applies. The full formats (Schedule 3) are not prepared here.'
    : null;
  return { ...base, status, size, consequence, firstFinancialYear: first, qualifies: q, findings: [...findings] };
}

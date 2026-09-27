import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, employees, expenseClaimLines, expenseClaims, reportableBenefits,
  TRAVEL_SUBSISTENCE_SUBCATEGORIES, type TravelSubsistenceSubcategory,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso, parts } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { upsertReviewItem } from '../extraction/service';
import { getEmployee, type Employee } from './employees';
import { PayrollError, PayrollFigures } from './figures';

/**
 * Enhanced Reporting Requirements (EPIC 21, issues #532, #533).
 *
 * An employer reports three kinds of benefit it provides without deducting
 * tax, on or before providing each one (TCA s.897C; S.I. 345/2018 reg.10A,
 * inserted by S.I. 1/2024): small benefits (s.112B), the remote working
 * daily allowance, and travel and subsistence payments. Each is recorded
 * here once, immutable, with its category and relevant particulars. A
 * correction supersedes the row, and a submission is recorded against the
 * row that was submitted.
 *
 * What cannot qualify is refused, never reported: a sixth small benefit, or
 * one that takes the year over €1,500, is taxable in full through payroll;
 * so is any remote working allowance over €3.20 a day.
 */

export type ReportableBenefit = typeof reportableBenefits.$inferSelect;

const eur = (m: number) => (m / 100).toFixed(2);

function requireDate(value: string, what: string) {
  if (!isIsoDate(value)) throw new PayrollError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

function insertBenefit(db: AppDatabase, row: Omit<typeof reportableBenefits.$inferInsert, 'id'>): ReportableBenefit {
  const id = ids.reportableBenefit();
  db.insert(reportableBenefits).values({ id, ...row }).run();
  db.insert(auditEvents).values({
    id: ids.audit(), companyId: row.companyId, occurredAt: nowIso(), entityType: 'reportable_benefit', entityId: id,
    action: 'created', newValue: JSON.stringify({ category: row.category, subcategory: row.subcategory, amountMinor: row.amountMinor, providedOn: row.providedOn }),
    source: 'user', actor: row.recordedBy, requestId: null,
  }).run();
  return db.select().from(reportableBenefits).where(eq(reportableBenefits.id, id)).get()!;
}

const live = ne(reportableBenefits.status, 'superseded');

/** The small benefits already provided to an employee in a tax year (not superseded), in order. */
export function smallBenefitsInYear(db: AppDatabase, employeeId: string, year: number): ReportableBenefit[] {
  return db.select().from(reportableBenefits)
    .where(and(eq(reportableBenefits.employeeId, employeeId), eq(reportableBenefits.category, 'small_benefit'), live,
      sql`substr(${reportableBenefits.providedOn}, 1, 4) = ${String(year)}`))
    .orderBy(asc(reportableBenefits.providedOn), sql`rowid`).all();
}

/**
 * Record a small benefit (a voucher or other non-cash incentive, s.112B).
 * It qualifies only as the first to fifth in the year with the year's
 * cumulative value within €1,500 (FA 2024 s.8); otherwise it is taxable in
 * full and belongs on a payslip as a benefit in kind, so it is refused here.
 */
export function recordSmallBenefit(db: AppDatabase, params: {
  companyId: string; employeeId: string; providedOn: string; amountMinor: number; description: string; recordedBy: string;
}): ReportableBenefit {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  const providedOn = requireDate(params.providedOn, 'The date the benefit is provided');
  const amount = asMinor(params.amountMinor);
  if (amount <= 0) throw new PayrollError('A small benefit has a positive value.');
  if (!params.description.trim()) throw new PayrollError('Describe the benefit (for example "Christmas voucher").');
  const figures = new PayrollFigures(db, params.companyId, providedOn);
  const maxCount = figures.value('small_benefit.max_incentives');
  const limit = figures.value('small_benefit.cumulative_limit');
  const year = parts(providedOn).year;
  const earlier = smallBenefitsInYear(db, employee.id, year);
  const later = earlier.filter((b) => b.providedOn > providedOn);
  if (later.length) {
    throw new PayrollError(`A small benefit dated ${later[0]!.providedOn} is already recorded for ${year}. Each incentive `
      + 'is tested against the ones before it, so record them in date order.');
  }
  const cumulative = earlier.reduce((s, b) => s + b.amountMinor, 0) + amount;
  if (earlier.length + 1 > maxCount) {
    throw new PayrollError(`This would be ${employee.firstName} ${employee.lastName}'s incentive number ${earlier.length + 1} in ${year}; `
      + `only the first ${maxCount} can qualify (TCA s.112B). It is taxable in full: put it on a payslip as a benefit in kind.`);
  }
  if (cumulative > limit) {
    throw new PayrollError(`With this benefit the year's small benefits come to ${eur(cumulative)}, over the ${eur(limit)} limit `
      + '(TCA s.112B). It is taxable in full, not only the excess: put it on a payslip as a benefit in kind.');
  }
  return insertBenefit(db, {
    companyId: params.companyId, employeeId: employee.id, category: 'small_benefit', subcategory: null,
    providedOn, amountMinor: amount, daysHundredths: null, description: params.description.trim(),
    sourceType: 'manual', sourceId: null, sourceLineId: null, recordedBy: params.recordedBy,
  });
}

/**
 * Record a remote working daily allowance: up to €3.20 for each day (or part
 * day) worked from home (TDM 38-03-33 §4.1). More than that is refused: the
 * excess is taxable pay, so the allowance is recorded at no more than the cap
 * and the rest goes through payroll.
 */
export function recordRemoteWorkingAllowance(db: AppDatabase, params: {
  companyId: string; employeeId: string; paidOn: string; daysHundredths: number; amountMinor: number; recordedBy: string;
  description?: string;
}): ReportableBenefit {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  const paidOn = requireDate(params.paidOn, 'The date the allowance is paid');
  const amount = asMinor(params.amountMinor);
  if (amount <= 0) throw new PayrollError('The allowance is a positive amount.');
  if (!Number.isInteger(params.daysHundredths) || params.daysHundredths <= 0) {
    throw new PayrollError('Give the days worked from home that the allowance pays for, in hundredths (part days count).');
  }
  const perDay = new PayrollFigures(db, params.companyId, paidOn).value('err.remote_working_daily_allowance');
  const cap = multiplyRational(perDay, params.daysHundredths, 100);
  if (amount > cap) {
    throw new PayrollError(`${(params.daysHundredths / 100).toFixed(2)} days at ${eur(perDay)} allow at most ${eur(cap)} without tax; `
      + `${eur(amount)} was given. Record ${eur(cap)} here and pay the ${eur(amount - cap)} excess through payroll as taxable pay.`);
  }
  return insertBenefit(db, {
    companyId: params.companyId, employeeId: employee.id, category: 'remote_working_daily_allowance', subcategory: null,
    providedOn: paidOn, amountMinor: amount, daysHundredths: params.daysHundredths,
    description: params.description?.trim() || 'Remote working daily allowance',
    sourceType: 'manual', sourceId: null, sourceLineId: null, recordedBy: params.recordedBy,
  });
}

/** Record a travel and subsistence payment made outside an expense claim, with its subcategory. */
export function recordTravelSubsistence(db: AppDatabase, params: {
  companyId: string; employeeId: string; paidOn: string; subcategory: TravelSubsistenceSubcategory; amountMinor: number;
  description: string; recordedBy: string;
}): ReportableBenefit {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  const paidOn = requireDate(params.paidOn, 'The date the payment is made');
  if (!TRAVEL_SUBSISTENCE_SUBCATEGORIES.includes(params.subcategory)) {
    throw new PayrollError(`The subcategory is one of: ${TRAVEL_SUBSISTENCE_SUBCATEGORIES.join(', ')}.`);
  }
  const amount = asMinor(params.amountMinor);
  if (amount <= 0) throw new PayrollError('A travel and subsistence payment is a positive amount.');
  if (!params.description.trim()) throw new PayrollError('Describe the payment.');
  new PayrollFigures(db, params.companyId, paidOn).cite('err.travel_subsistence_subcategories');
  return insertBenefit(db, {
    companyId: params.companyId, employeeId: employee.id, category: 'travel_and_subsistence', subcategory: params.subcategory,
    providedOn: paidOn, amountMinor: amount, daysHundredths: null, description: params.description.trim(),
    sourceType: 'manual', sourceId: null, sourceLineId: null, recordedBy: params.recordedBy,
  });
}

/** The payroll employee an expense claim's claimant is, by the officer or login the employment is linked to. */
export function employeeForClaim(db: AppDatabase, companyId: string, claim: typeof expenseClaims.$inferSelect): Employee | null {
  const where = claim.officerId
    ? eq(employees.officerId, claim.officerId)
    : claim.userId ? eq(employees.userId, claim.userId) : null;
  if (!where) return null;
  return db.select().from(employees).where(and(eq(employees.companyId, companyId), where)).get() ?? null;
}

/**
 * The travel and subsistence subcategory a claim line's own facts decide
 * (S.I. 1/2024 reg.3(a)), or null where they do not:
 * - mileage and subsistence priced at the civil service rates are unvouched;
 * - a travel line with its receipt attached is vouched travel;
 * - a travel line without a receipt could be either, so it is the person's to classify;
 * - a receipt line is not travel or subsistence, so it is not reported.
 */
export function subcategoryOfClaimLine(line: typeof expenseClaimLines.$inferSelect): TravelSubsistenceSubcategory | 'not_reportable' | null {
  if (line.lineType === 'mileage') return 'travel_unvouched';
  if (line.lineType === 'subsistence') return line.rateId ? 'subsistence_unvouched' : null;
  if (line.lineType === 'travel') return line.documentId ? 'travel_vouched' : null;
  return 'not_reportable';
}

/**
 * Prepare the reportable benefits of a reimbursed expense claim: one per
 * travel or subsistence line, for the business share actually reimbursed,
 * dated the day the reimbursement was paid. A line whose subcategory is not
 * on the record must be classified by the person (`classifications`).
 */
export function reportExpenseClaim(db: AppDatabase, params: {
  companyId: string; claimId: string; recordedBy: string;
  employeeId?: string | null;
  classifications?: Record<string, TravelSubsistenceSubcategory>;
}): ReportableBenefit[] {
  const claim = db.select().from(expenseClaims)
    .where(and(eq(expenseClaims.id, params.claimId), eq(expenseClaims.companyId, params.companyId))).get();
  if (!claim) throw new PayrollError(`Expense claim ${params.claimId} not found.`);
  if (claim.status !== 'reimbursed' || !claim.reimbursementDate) {
    throw new PayrollError(`This claim is ${claim.status}. Its travel and subsistence is reported when it is reimbursed.`);
  }
  const already = db.select({ id: reportableBenefits.id }).from(reportableBenefits)
    .where(and(eq(reportableBenefits.sourceType, 'expense_claim'), eq(reportableBenefits.sourceId, claim.id), live)).get();
  if (already) throw new PayrollError('This claim\'s reportable benefits are already prepared. Correct one by superseding it.');
  const employee = params.employeeId ? getEmployee(db, params.companyId, params.employeeId) : employeeForClaim(db, params.companyId, claim);
  if (!employee) {
    throw new PayrollError('The claimant is not linked to a payroll employee, so there is no PPSN or employer reference to report '
      + 'under. Record them as an employee (linked to the officer or login), or name the employee.');
  }
  const lines = db.select().from(expenseClaimLines).where(eq(expenseClaimLines.claimId, claim.id)).orderBy(expenseClaimLines.lineNumber).all();
  const plan = lines.map((line) => {
    const decided = subcategoryOfClaimLine(line);
    const chosen = params.classifications?.[line.id];
    if (chosen && !TRAVEL_SUBSISTENCE_SUBCATEGORIES.includes(chosen)) throw new PayrollError(`"${chosen}" is not a subcategory.`);
    if (decided === 'not_reportable') return null;
    const subcategory = decided ?? chosen ?? null;
    if (!subcategory) {
      throw new PayrollError(`Line ${line.lineNumber} ("${line.description}") is ${line.lineType} ${line.lineType === 'travel' ? 'without a receipt' : 'without a civil service rate'}: `
        + 'whether it is vouched or unvouched is not on the record. Classify it.', { lineId: line.id });
    }
    if (decided && chosen && chosen !== decided) {
      throw new PayrollError(`Line ${line.lineNumber} is ${decided.replace('_', ' ')} on its own facts; it cannot be reported as ${chosen}.`);
    }
    return { line, subcategory, amount: multiplyRational(line.amountMinor, line.businessUseBasisPoints, 10_000) };
  }).filter((p): p is NonNullable<typeof p> => p !== null && p.amount > 0);
  if (!plan.length) throw new PayrollError('This claim has no travel or subsistence to report.');
  const paidOn = asIsoDate(claim.reimbursementDate);
  new PayrollFigures(db, params.companyId, paidOn).cite('err.travel_subsistence_subcategories');
  return db.transaction((tx) => plan.map((p) => insertBenefit(tx as unknown as AppDatabase, {
    companyId: params.companyId, employeeId: employee.id, category: 'travel_and_subsistence', subcategory: p.subcategory,
    providedOn: paidOn, amountMinor: p.amount, daysHundredths: null, description: `${claim.title}: ${p.line.description}`,
    sourceType: 'expense_claim', sourceId: claim.id, sourceLineId: p.line.id, recordedBy: params.recordedBy,
  })));
}

/**
 * Correct a reportable benefit: the row is superseded (never edited) and a
 * new one records the corrected amount, days or subcategory. A submitted row
 * corrected this way needs its correction submitted too.
 */
export function correctReportableBenefit(db: AppDatabase, params: {
  companyId: string; benefitId: string; reason: string; recordedBy: string;
  amountMinor?: number; daysHundredths?: number; subcategory?: TravelSubsistenceSubcategory; providedOn?: string;
}): ReportableBenefit {
  const old = db.select().from(reportableBenefits)
    .where(and(eq(reportableBenefits.id, params.benefitId), eq(reportableBenefits.companyId, params.companyId))).get();
  if (!old) throw new PayrollError(`Reportable benefit ${params.benefitId} not found.`);
  if (old.status === 'superseded') throw new PayrollError('That benefit was already corrected; correct the row that replaced it.');
  if (!params.reason.trim()) throw new PayrollError('Say why the benefit is being corrected.');
  if (old.category === 'small_benefit' && params.amountMinor !== undefined && params.amountMinor > old.amountMinor) {
    throw new PayrollError('A small benefit\'s value is not increased by correction: the limits are tested in date order. '
      + 'Supersede it at the same or a lower value, or record the difference as a taxable benefit in kind.');
  }
  const amount = params.amountMinor !== undefined ? asMinor(params.amountMinor) : old.amountMinor;
  if (amount <= 0) throw new PayrollError('A reportable benefit has a positive amount.');
  const days = params.daysHundredths ?? old.daysHundredths;
  const providedOn = params.providedOn ? requireDate(params.providedOn, 'The date') : asIsoDate(old.providedOn);
  if (old.category === 'remote_working_daily_allowance') {
    const perDay = new PayrollFigures(db, params.companyId, providedOn).value('err.remote_working_daily_allowance');
    if (amount > multiplyRational(perDay, days!, 100)) throw new PayrollError(`That is over ${eur(perDay)} a day.`);
  }
  if (params.subcategory && old.category !== 'travel_and_subsistence') throw new PayrollError('Only travel and subsistence has a subcategory.');
  return db.transaction((tx) => {
    tx.update(reportableBenefits).set({ status: 'superseded', supersededReason: params.reason.trim(), updatedAt: nowIso() })
      .where(eq(reportableBenefits.id, old.id)).run();
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = old;
    return insertBenefit(tx as unknown as AppDatabase, {
      ...rest, amountMinor: amount, daysHundredths: days, subcategory: params.subcategory ?? old.subcategory, providedOn,
      status: 'prepared', supersedesId: old.id, supersededReason: null, submittedOn: null, submissionReference: null, submittedBy: null,
      recordedBy: params.recordedBy, source: 'user', provenanceStatus: 'manually_entered',
    });
  });
}

/** Record that benefits were notified to Revenue (through ROS, until #528), with the reference ROS gave. */
export function markBenefitsSubmitted(db: AppDatabase, params: {
  companyId: string; benefitIds: string[]; submittedOn: string; reference: string; submittedBy: string;
}): ReportableBenefit[] {
  const submittedOn = requireDate(params.submittedOn, 'The submission date');
  if (!params.reference.trim()) throw new PayrollError('Give the reference ROS gave the submission.');
  const rows = db.select().from(reportableBenefits)
    .where(and(eq(reportableBenefits.companyId, params.companyId), inArray(reportableBenefits.id, params.benefitIds))).all();
  if (rows.length !== params.benefitIds.length) throw new PayrollError('One or more of those benefits are not in this company.');
  const wrong = rows.find((r) => r.status !== 'prepared');
  if (wrong) throw new PayrollError(`Benefit ${wrong.id} is ${wrong.status}; only a prepared benefit is submitted.`);
  db.transaction((tx) => {
    for (const r of rows) {
      tx.update(reportableBenefits).set({
        status: 'submitted', submittedOn, submissionReference: params.reference.trim(), submittedBy: params.submittedBy, updatedAt: nowIso(),
      }).where(eq(reportableBenefits.id, r.id)).run();
    }
  });
  return db.select().from(reportableBenefits).where(inArray(reportableBenefits.id, params.benefitIds)).all();
}

/** One benefit's reg.10A particulars, for the ROS online form. */
export interface ErrParticulars {
  benefitId: string;
  status: string;
  providedOn: string;
  name: string;
  ppsn: string | null;
  /** reg.10A(1)(c)(i), (ii): given only where there is no PPSN. */
  address: string | null;
  dateOfBirth: string | null;
  employerReference: string;
  employmentId: string;
  amountMinor: number;
  category: string;
  /** The relevant particulars: days for the allowance, the subcategory for travel and subsistence. */
  days: number | null;
  subcategory: string | null;
}

/** The particulars of the benefits in a date range (not superseded), in date order. */
export function errParticulars(db: AppDatabase, companyId: string, params: { from: string; to: string; status?: 'prepared' | 'submitted' }): ErrParticulars[] {
  const rows = db.select({ b: reportableBenefits, e: employees }).from(reportableBenefits)
    .innerJoin(employees, eq(reportableBenefits.employeeId, employees.id))
    .where(and(eq(reportableBenefits.companyId, companyId), live,
      sql`${reportableBenefits.providedOn} between ${params.from} and ${params.to}`,
      params.status ? eq(reportableBenefits.status, params.status) : undefined))
    .orderBy(asc(reportableBenefits.providedOn), asc(employees.lastName)).all();
  return rows.map(({ b, e }) => ({
    benefitId: b.id, status: b.status, providedOn: b.providedOn, name: `${e.firstName} ${e.lastName}`,
    ppsn: e.ppsn, address: e.ppsn ? null : e.address, dateOfBirth: e.ppsn ? null : e.dateOfBirth,
    employerReference: e.employerReference, employmentId: e.employmentId, amountMinor: b.amountMinor, category: b.category,
    days: b.daysHundredths === null ? null : b.daysHundredths / 100, subcategory: b.subcategory,
  }));
}

export interface ErrReconciliation {
  asOf: string;
  /** Reimbursed claims whose travel and subsistence is not prepared, or not to the cent. */
  claims: Array<{ claimId: string; title: string; reimbursedOn: string; reportableMinor: number; preparedMinor: number }>;
  /** Benefits not submitted by the date they were provided. */
  unsubmitted: Array<{ benefitId: string; providedOn: string; amountMinor: number }>;
  /** Benefits submitted after the date they were provided. */
  late: Array<{ benefitId: string; providedOn: string; submittedOn: string }>;
  /** Employees whose small benefits in a year break s.112B's limits. */
  smallBenefitBreaches: Array<{ employeeId: string; year: number; count: number; totalMinor: number }>;
}

/**
 * Reimbursed expense claims (from 2024, when ERR began) whose travel and
 * subsistence is not prepared for Revenue, or not to the cent. Reads only.
 */
export function unreportedClaims(db: AppDatabase, companyId: string, asOf: string): ErrReconciliation['claims'] {
  const claims: ErrReconciliation['claims'] = [];
  for (const claim of db.select().from(expenseClaims)
    .where(and(eq(expenseClaims.companyId, companyId), eq(expenseClaims.status, 'reimbursed'),
      sql`${expenseClaims.reimbursementDate} <= ${asOf}`, sql`${expenseClaims.reimbursementDate} >= '2024-01-01'`)).all()) {
    const lines = db.select().from(expenseClaimLines).where(eq(expenseClaimLines.claimId, claim.id)).all();
    const reportable = lines.filter((l) => subcategoryOfClaimLine(l) !== 'not_reportable')
      .reduce((s, l) => s + multiplyRational(l.amountMinor, l.businessUseBasisPoints, 10_000), 0);
    if (!reportable) continue;
    const prepared = db.select({ n: sql<number>`coalesce(sum(${reportableBenefits.amountMinor}), 0)` }).from(reportableBenefits)
      .where(and(eq(reportableBenefits.sourceType, 'expense_claim'), eq(reportableBenefits.sourceId, claim.id), live)).get()!.n;
    if (prepared !== reportable) {
      claims.push({ claimId: claim.id, title: claim.title, reimbursedOn: claim.reimbursementDate!, reportableMinor: reportable, preparedMinor: prepared });
    }
  }
  return claims;
}

/**
 * Reconcile ERR with the books (issue #533). Each difference is reported and
 * raised as a review item; nothing is repaired.
 */
export function reconcileErr(db: AppDatabase, params: { companyId: string; asOf: string }): ErrReconciliation {
  const asOf = requireDate(params.asOf, 'The reconciliation date');
  const { companyId } = params;
  const claims = unreportedClaims(db, companyId, asOf);
  const benefits = db.select().from(reportableBenefits)
    .where(and(eq(reportableBenefits.companyId, companyId), live, sql`${reportableBenefits.providedOn} <= ${asOf}`)).all();
  const unsubmitted = benefits.filter((b) => b.status === 'prepared' && b.providedOn < asOf)
    .map((b) => ({ benefitId: b.id, providedOn: b.providedOn, amountMinor: b.amountMinor }));
  const late = benefits.filter((b) => b.status === 'submitted' && b.submittedOn! > b.providedOn)
    .map((b) => ({ benefitId: b.id, providedOn: b.providedOn, submittedOn: b.submittedOn! }));
  const smallBenefitBreaches: ErrReconciliation['smallBenefitBreaches'] = [];
  const groups = new Map<string, ReportableBenefit[]>();
  for (const b of benefits.filter((x) => x.category === 'small_benefit')) {
    const key = `${b.employeeId}|${b.providedOn.slice(0, 4)}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const [key, group] of groups) {
    const [employeeId, y] = key.split('|');
    const year = Number(y);
    const figures = new PayrollFigures(db, companyId, `${year}-12-31`);
    let maxCount: number;
    let limit: number;
    try {
      maxCount = figures.value('small_benefit.max_incentives');
      limit = figures.value('small_benefit.cumulative_limit');
    } catch {
      continue; // No rule for that year: nothing to test against, and recordSmallBenefit refused it anyway.
    }
    const total = group.reduce((s, b) => s + b.amountMinor, 0);
    if (group.length > maxCount || total > limit) smallBenefitBreaches.push({ employeeId: employeeId!, year, count: group.length, totalMinor: total });
  }

  for (const c of claims) {
    upsertReviewItem(db, {
      companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `ERR: "${c.title}" reimbursed ${c.reimbursedOn} is not fully reported`,
      detail: `Its travel and subsistence comes to ${eur(c.reportableMinor)}, and ${eur(c.preparedMinor)} is prepared for Revenue. `
        + 'Prepare the claim\'s reportable benefits (or correct them); they were due on or before the reimbursement (TCA s.897C).',
      entityType: 'expense_claim', entityId: c.claimId, dedupeKey: `err_claim:${c.claimId}`,
    });
  }
  for (const u of unsubmitted) {
    upsertReviewItem(db, {
      companyId, kind: 'other', severity: 'warning',
      title: `ERR: a benefit provided on ${u.providedOn} has not been submitted to Revenue`,
      detail: `${eur(u.amountMinor)} was due to be notified on or before ${u.providedOn} (S.I. 345/2018 reg.10A). Submit it through `
        + 'ROS and record the reference.',
      entityType: 'reportable_benefit', entityId: u.benefitId, dedupeKey: `err_unsubmitted:${u.benefitId}`,
    });
  }
  for (const s of smallBenefitBreaches) {
    upsertReviewItem(db, {
      companyId, kind: 'other', severity: 'error',
      title: `ERR: small benefits for ${s.year} break the s.112B limits`,
      detail: `${s.count} benefits totalling ${eur(s.totalMinor)} are recorded for one employee. Those beyond the limits are taxable in `
        + 'full through payroll.',
      entityType: 'employee', entityId: s.employeeId, dedupeKey: `err_small_benefit:${s.employeeId}:${s.year}`,
    });
  }
  return { asOf, claims, unsubmitted, late, smallBenefitBreaches };
}

import { and, desc, eq, isNull, lte, or, gt } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, companies, companyOfficers, employees, employmentTerms, payRuns, payslips,
  type PayFrequency, PAY_FREQUENCIES,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { asMinor } from '../money';
import { requireValidPpsn } from './ppsn';
import { PayrollError } from './figures';

/**
 * Employee records and the terms of each employment (issues #524, #525).
 *
 * The identity is what S.I. 345/2018 reg.17(2) and reg.10(1) require an
 * employer to hold and report. The terms (pay basis, pension) are
 * effective-dated: a change is a new row from its date that closes the one
 * before (invariant 6), so a past payslip always resolves the terms of its
 * own pay date.
 */

export type Employee = typeof employees.$inferSelect;
export type EmploymentTerms = typeof employmentTerms.$inferSelect;

function audit(
  db: AppDatabase, companyId: string, entityId: string, action: 'created' | 'updated', actor: string, value: unknown,
  entityType = 'employee', field: string | null = null,
) {
  db.insert(auditEvents).values({
    id: ids.audit(), companyId, occurredAt: nowIso(), entityType, entityId, action, field,
    newValue: JSON.stringify(value), source: 'user', actor, requestId: null,
  }).run();
}

function requireDate(value: string, what: string) {
  if (!isIsoDate(value)) throw new PayrollError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

export function getEmployee(db: AppDatabase, companyId: string, employeeId: string): Employee {
  const e = db.select().from(employees).where(and(eq(employees.id, employeeId), eq(employees.companyId, companyId))).get();
  if (!e) throw new PayrollError(`Employee ${employeeId} not found in this company.`, { employeeId });
  return e;
}

export function listEmployees(db: AppDatabase, companyId: string): Employee[] {
  return db.select().from(employees).where(eq(employees.companyId, companyId))
    .orderBy(employees.lastName, employees.firstName).all();
}

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  ppsn?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  email?: string | null;
  employerReference: string;
  employmentId?: string | null;
  startDate: string;
  payFrequency: PayFrequency;
  isDirector?: boolean;
  isProprietaryDirector?: boolean;
  officerId?: string | null;
  prsiClass?: 'A' | 'S' | 'J' | 'M';
  notes?: string | null;
}

/**
 * Record an employee. Without a PPSN, reg.17(2)(a) requires the address and
 * date of birth instead, and tax is deducted at the higher rate (reg.19(2)).
 */
export function createEmployee(db: AppDatabase, params: EmployeeInput & { companyId: string; recordedBy: string }): Employee {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new PayrollError(`Company ${params.companyId} not found.`);
  if (!params.recordedBy.trim()) throw new PayrollError('Say who is recording this employee.');
  if (!params.firstName.trim() || !params.lastName.trim()) throw new PayrollError('An employee has a first name and a surname (reg.17(2)(b)).');
  if (!params.employerReference.trim()) throw new PayrollError('Give the employer reference: the staff identifier reported with every payment (reg.10(1)(j)).');
  if (!PAY_FREQUENCIES.includes(params.payFrequency)) throw new PayrollError('The pay frequency is weekly, fortnightly or monthly (reg.11(3)).');
  const startDate = requireDate(params.startDate, 'The commencement date');
  const ppsn = params.ppsn?.trim() ? requireValidPpsn(params.ppsn) : null;
  if (!ppsn && (!params.address?.trim() || !params.dateOfBirth?.trim())) {
    throw new PayrollError('Without a PPSN, the employee\'s address and date of birth are required (reg.17(2)(a)).');
  }
  if (params.dateOfBirth) requireDate(params.dateOfBirth, 'The date of birth');
  if (params.isProprietaryDirector && !params.isDirector) {
    throw new PayrollError('A proprietary director is a director: mark the employee as a director too.');
  }
  if (params.officerId) {
    const officer = db.select().from(companyOfficers)
      .where(and(eq(companyOfficers.id, params.officerId), eq(companyOfficers.companyId, params.companyId))).get();
    if (!officer) throw new PayrollError(`Officer ${params.officerId} not found in this company.`);
    if (officer.role !== 'director') throw new PayrollError(`${officer.name} is recorded as ${officer.role}, not a director.`);
  }
  const reference = params.employerReference.trim();
  const clash = db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.companyId, params.companyId), eq(employees.employerReference, reference))).get();
  if (clash) throw new PayrollError(`Employer reference ${reference} is already used: each employee has their own (reg.10(1)(j)).`);

  const id = ids.employee();
  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    tx.insert(employees).values({
      id, companyId: params.companyId,
      firstName: params.firstName.trim(), lastName: params.lastName.trim(), ppsn,
      dateOfBirth: params.dateOfBirth?.trim() || null, address: params.address?.trim() || null,
      email: params.email?.trim() || null, employerReference: reference,
      employmentId: params.employmentId?.trim() || '1', startDate, leftOn: null,
      payFrequency: params.payFrequency, isDirector: params.isDirector ?? false,
      isProprietaryDirector: params.isProprietaryDirector ?? false, officerId: params.officerId ?? null,
      prsiClass: params.prsiClass ?? 'A', recordedBy: params.recordedBy, notes: params.notes ?? null,
    }).run();
    audit(txDb, params.companyId, id, 'created', params.recordedBy, { employerReference: reference, startDate, payFrequency: params.payFrequency });
    return tx.select().from(employees).where(eq(employees.id, id)).get()!;
  });
}

/**
 * Record a PPSN given after the employee started. Only a missing PPSN is
 * recorded here: a PPSN is the employee's identity with Revenue, so a wrong
 * one is corrected deliberately, not overwritten in passing.
 */
export function recordPpsn(db: AppDatabase, params: { companyId: string; employeeId: string; ppsn: string; recordedBy: string }): Employee {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  if (employee.ppsn) throw new PayrollError(`${employee.firstName} ${employee.lastName} already has PPSN ${employee.ppsn} recorded.`);
  const ppsn = requireValidPpsn(params.ppsn);
  db.transaction((tx) => {
    tx.update(employees).set({ ppsn, updatedAt: nowIso() }).where(eq(employees.id, employee.id)).run();
    audit(tx as unknown as AppDatabase, params.companyId, employee.id, 'updated', params.recordedBy, { ppsn }, 'employee', 'ppsn');
  });
  return getEmployee(db, params.companyId, employee.id);
}

/** Record the date an employment ceased (reg.17(3)). Pay after it is still possible: arrears (reg.16). */
export function recordCessation(db: AppDatabase, params: { companyId: string; employeeId: string; leftOn: string; recordedBy: string }): Employee {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  const leftOn = requireDate(params.leftOn, 'The cessation date');
  if (leftOn < employee.startDate) throw new PayrollError('An employment cannot cease before it commenced.');
  if (employee.leftOn) throw new PayrollError(`This employment already ceased on ${employee.leftOn}.`);
  db.transaction((tx) => {
    tx.update(employees).set({ leftOn, updatedAt: nowIso() }).where(eq(employees.id, employee.id)).run();
    audit(tx as unknown as AppDatabase, params.companyId, employee.id, 'updated', params.recordedBy, { leftOn }, 'employee', 'left_on');
  });
  return getEmployee(db, params.companyId, employee.id);
}

export interface TermsInput {
  payBasis: 'salary' | 'hourly';
  annualSalaryMinor?: number | null;
  hourlyRateMinor?: number | null;
  normalHoursHundredths?: number | null;
  pensionScheme?: 'none' | 'occupational' | 'prsa' | 'rac';
  pensionEmployeeBasisPoints?: number | null;
  pensionEmployeeFixedMinor?: number | null;
  pensionEmployerBasisPoints?: number | null;
  pensionEmployerFixedMinor?: number | null;
  notes?: string | null;
}

const optionalMinor = (v: number | null | undefined, what: string) => {
  if (v === null || v === undefined) return null;
  const m = asMinor(v);
  if (m < 0) throw new PayrollError(`${what} cannot be negative.`);
  return m;
};

/**
 * Set the terms of an employment from a date. The terms in force the day
 * before are closed at that date; nothing is edited. A date on or before a
 * posted payslip's pay date is refused: that payslip resolved the old terms.
 */
export function setEmploymentTerms(db: AppDatabase, params: TermsInput & {
  companyId: string; employeeId: string; effectiveFrom: string; recordedBy: string;
}): EmploymentTerms {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  const from = requireDate(params.effectiveFrom, 'The date the terms apply from');
  if (from < employee.startDate) throw new PayrollError(`The terms cannot start before the employment did (${employee.startDate}).`);
  const salary = optionalMinor(params.annualSalaryMinor, 'A salary');
  const hourly = optionalMinor(params.hourlyRateMinor, 'An hourly rate');
  if (params.payBasis === 'salary' && !salary) throw new PayrollError('A salaried employment needs its annual salary.');
  if (params.payBasis === 'hourly' && !hourly) throw new PayrollError('An hourly employment needs its hourly rate.');
  const scheme = params.pensionScheme ?? 'none';
  const eeBp = params.pensionEmployeeBasisPoints ?? null;
  const erBp = params.pensionEmployerBasisPoints ?? null;
  const eeFixed = optionalMinor(params.pensionEmployeeFixedMinor, 'A pension contribution');
  const erFixed = optionalMinor(params.pensionEmployerFixedMinor, 'A pension contribution');
  for (const v of [eeBp, erBp]) {
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 10_000)) throw new PayrollError('A pension percentage is 0% to 100%, in basis points.');
  }
  if (eeBp !== null && eeFixed !== null) throw new PayrollError('The employee\'s contribution is a percentage or a fixed amount, not both.');
  if (erBp !== null && erFixed !== null) throw new PayrollError('The employer\'s contribution is a percentage or a fixed amount, not both.');
  if (scheme === 'none' && [eeBp, erBp, eeFixed, erFixed].some((v) => v)) {
    throw new PayrollError('Pension contributions need a scheme: occupational, PRSA or RAC (S.I. 345/2018 reg.31(1)).');
  }
  const lastPaid = db.select({ d: payRuns.payDate }).from(payslips)
    .innerJoin(payRuns, eq(payslips.payRunId, payRuns.id))
    .where(and(eq(payslips.employeeId, employee.id), eq(payRuns.status, 'posted')))
    .orderBy(desc(payRuns.payDate)).get()?.d ?? null;
  if (lastPaid && from <= lastPaid) {
    throw new PayrollError(`A posted payslip dated ${lastPaid} used the earlier terms. New terms apply from a later date; `
      + 'a past pay run is corrected by reversing it.');
  }

  const id = ids.employmentTerms();
  return db.transaction((tx) => {
    const current = tx.select().from(employmentTerms)
      .where(and(eq(employmentTerms.employeeId, employee.id), isNull(employmentTerms.effectiveTo))).all();
    for (const row of current) {
      if (row.effectiveFrom >= from) {
        throw new PayrollError(`Terms already apply from ${row.effectiveFrom}. Record new terms from a later date.`);
      }
      tx.update(employmentTerms).set({ effectiveTo: from, updatedAt: nowIso() }).where(eq(employmentTerms.id, row.id)).run();
    }
    tx.insert(employmentTerms).values({
      id, companyId: params.companyId, employeeId: employee.id, payBasis: params.payBasis,
      annualSalaryMinor: salary, hourlyRateMinor: hourly, normalHoursHundredths: params.normalHoursHundredths ?? null,
      pensionScheme: scheme, pensionEmployeeBasisPoints: eeBp, pensionEmployeeFixedMinor: eeFixed,
      pensionEmployerBasisPoints: erBp, pensionEmployerFixedMinor: erFixed,
      effectiveFrom: from, effectiveTo: null, recordedBy: params.recordedBy, notes: params.notes ?? null,
    }).run();
    audit(tx as unknown as AppDatabase, params.companyId, id, 'created', params.recordedBy,
      { employeeId: employee.id, effectiveFrom: from, payBasis: params.payBasis, pensionScheme: scheme }, 'employment_terms');
    return tx.select().from(employmentTerms).where(eq(employmentTerms.id, id)).get()!;
  });
}

/** The terms in force on a date, or null. */
export function termsOn(db: AppDatabase, employeeId: string, date: string): EmploymentTerms | null {
  return db.select().from(employmentTerms)
    .where(and(
      eq(employmentTerms.employeeId, employeeId),
      lte(employmentTerms.effectiveFrom, date),
      or(isNull(employmentTerms.effectiveTo), gt(employmentTerms.effectiveTo, date)),
    )).orderBy(desc(employmentTerms.effectiveFrom)).get() ?? null;
}

export function listTerms(db: AppDatabase, employeeId: string): EmploymentTerms[] {
  return db.select().from(employmentTerms).where(eq(employmentTerms.employeeId, employeeId))
    .orderBy(employmentTerms.effectiveFrom).all();
}

/** Employees on a pay frequency employed during a period. */
export function employeesForRun(db: AppDatabase, companyId: string, frequency: PayFrequency, periodStart: string, payDate: string): Employee[] {
  return listEmployees(db, companyId).filter((e) => e.payFrequency === frequency
    && e.startDate <= payDate && (e.leftOn === null || e.leftOn >= periodStart));
}

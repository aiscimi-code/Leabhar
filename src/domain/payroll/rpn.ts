import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { auditEvents, revenuePayrollNotifications, type RpnUscBand } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso, parts } from '../dates';
import { asMinor, parseAmount, parsePercentBasisPoints } from '../money';
import { getEmployee } from './employees';
import { PayrollError } from './figures';

/**
 * Revenue payroll notifications (issue #526).
 *
 * The RPN is Revenue's determination of an employee's credits, standard rate
 * cut-off point and USC cut-off points for the year, and the employer "shall
 * ensure that ... the information on that notification is used" (S.I.
 * 345/2018 reg.6(3); S.I. 510/2018 reg.10(3)). The employee-specific figures
 * therefore come from the RPN, never from the rules: only the emergency basis
 * (no RPN) computes from the statutory bands.
 *
 * Until RPN retrieval exists (#528), an RPN is copied by hand from ROS and
 * recorded as the person's entry. Each RPN is immutable; a later one
 * supersedes the earlier from its own date (reg.8), and each payslip keeps
 * the RPN it used.
 */

export type Rpn = typeof revenuePayrollNotifications.$inferSelect;

export interface RpnInput {
  rpnNumber: string;
  taxYear: number;
  effectiveFrom: string;
  taxBasis: 'cumulative' | 'week1' | 'emergency';
  yearlyTaxCreditsMinor: number;
  yearlySrcopMinor: number;
  uscStatus: 'ordinary' | 'exempt';
  uscBasis: 'cumulative' | 'week1' | 'emergency';
  uscBands: RpnUscBand[];
  prsiExempt?: boolean;
  previousPayMinor?: number;
  previousTaxMinor?: number;
  previousUscPayMinor?: number;
  previousUscMinor?: number;
}

const nonNegative = (v: number | undefined, what: string) => {
  const m = asMinor(v ?? 0);
  if (m < 0) throw new PayrollError(`${what} cannot be negative.`);
  return m;
};

export function recordRpn(db: AppDatabase, params: RpnInput & {
  companyId: string; employeeId: string; recordedBy: string; source?: 'user' | 'import';
}): Rpn {
  const employee = getEmployee(db, params.companyId, params.employeeId);
  if (!params.recordedBy.trim()) throw new PayrollError('Say who is recording this RPN.');
  if (!params.rpnNumber.trim()) throw new PayrollError('Give the RPN number: it is reported with every payment calculated from it (reg.10(1)(d)).');
  if (!isIsoDate(params.effectiveFrom)) throw new PayrollError('The date the RPN applies from is a YYYY-MM-DD date.');
  const from = asIsoDate(params.effectiveFrom);
  if (!Number.isInteger(params.taxYear) || parts(from).year !== params.taxYear) {
    throw new PayrollError(`An RPN is for one tax year: ${from} is not in ${params.taxYear}.`);
  }
  const credits = nonNegative(params.yearlyTaxCreditsMinor, 'Tax credits');
  const srcop = nonNegative(params.yearlySrcopMinor, 'The standard rate cut-off point');
  if (params.uscStatus === 'ordinary') {
    if (!params.uscBands.length) throw new PayrollError('An RPN that is not USC-exempt lists its USC rates and bands.');
    params.uscBands.forEach((b, i) => {
      if (!Number.isInteger(b.rateBasisPoints) || b.rateBasisPoints < 0 || b.rateBasisPoints > 10_000) {
        throw new PayrollError('A USC rate is in basis points (0.5% = 50).');
      }
      const last = i === params.uscBands.length - 1;
      if (last !== (b.yearlyBandMinor === null)) {
        throw new PayrollError('Every USC band but the last has a yearly amount; the last has none (it takes the rest of the pay).');
      }
      if (b.yearlyBandMinor !== null) nonNegative(b.yearlyBandMinor, 'A USC band');
    });
  } else if (params.uscBands.length) {
    throw new PayrollError('A USC-exempt RPN has no USC bands (S.I. 510/2018 reg.8(2)).');
  }

  const previous = db.select().from(revenuePayrollNotifications)
    .where(and(
      eq(revenuePayrollNotifications.employeeId, employee.id),
      eq(revenuePayrollNotifications.taxYear, params.taxYear),
    )).orderBy(desc(revenuePayrollNotifications.effectiveFrom), sql`rowid desc`).get();
  if (previous && previous.effectiveFrom > from) {
    throw new PayrollError(`RPN ${previous.rpnNumber} already applies from ${previous.effectiveFrom}. A new RPN applies from `
      + 'that date or later; it never reaches back behind a later one.');
  }

  const id = ids.rpn();
  const source = params.source ?? 'user';
  return db.transaction((tx) => {
    tx.insert(revenuePayrollNotifications).values({
      id, companyId: params.companyId, employeeId: employee.id, rpnNumber: params.rpnNumber.trim(), taxYear: params.taxYear,
      effectiveFrom: from, taxBasis: params.taxBasis, yearlyTaxCreditsMinor: credits, yearlySrcopMinor: srcop,
      uscStatus: params.uscStatus, uscBasis: params.uscBasis, uscBands: params.uscBands,
      prsiExempt: params.prsiExempt ?? false,
      previousPayMinor: nonNegative(params.previousPayMinor, 'Previous pay'),
      previousTaxMinor: asMinor(params.previousTaxMinor ?? 0),
      previousUscPayMinor: nonNegative(params.previousUscPayMinor, 'Previous USC pay'),
      previousUscMinor: nonNegative(params.previousUscMinor, 'Previous USC'),
      supersedesRpnId: previous?.id ?? null, recordedBy: params.recordedBy,
      source, provenanceStatus: source === 'user' ? 'manually_entered' : 'imported',
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'revenue_payroll_notification', entityId: id,
      action: 'created', newValue: JSON.stringify({ employeeId: employee.id, rpnNumber: params.rpnNumber, taxYear: params.taxYear, effectiveFrom: from }),
      source, actor: params.recordedBy, requestId: null,
    }).run();
    return tx.select().from(revenuePayrollNotifications).where(eq(revenuePayrollNotifications.id, id)).get()!;
  });
}

/** The RPN in force for an employee on a pay date: the latest for the year from on or before it. */
export function rpnOn(db: AppDatabase, employeeId: string, payDate: string): Rpn | null {
  return db.select().from(revenuePayrollNotifications)
    .where(and(
      eq(revenuePayrollNotifications.employeeId, employeeId),
      eq(revenuePayrollNotifications.taxYear, parts(asIsoDate(payDate)).year),
      lte(revenuePayrollNotifications.effectiveFrom, payDate),
    )).orderBy(desc(revenuePayrollNotifications.effectiveFrom), sql`rowid desc`).get() ?? null;
}

export function listRpns(db: AppDatabase, employeeId: string): Rpn[] {
  return db.select().from(revenuePayrollNotifications).where(eq(revenuePayrollNotifications.employeeId, employeeId))
    .orderBy(desc(revenuePayrollNotifications.taxYear), desc(revenuePayrollNotifications.effectiveFrom)).all();
}

/**
 * An RPN's USC bands written as "rate:band" pairs, as ROS lists them:
 * "0.5:12012,2:16688,3:41344,8". The last rate has no band: it takes the rest.
 */
export function parseUscBands(spec: string): RpnUscBand[] {
  return spec.split(',').map((part) => {
    const [rate, band] = part.split(':').map((s) => s.trim());
    const bp = parsePercentBasisPoints(rate ?? '');
    if (bp === null) throw new PayrollError(`"${rate}" is not a USC rate.`);
    return { rateBasisPoints: bp, yearlyBandMinor: band ? parseAmount(band, 'EUR') : null };
  });
}

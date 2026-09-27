'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount, parsePercentBasisPoints } from '@/domain/money';
import {
  createEmployee, recordPpsn, recordCessation, setEmploymentTerms, recordRpn,
  createPayRun, setPayslipInputs, recomputePayRun, removeFromPayRun, postPayRun, reversePayRun, payNetWages,
  payPayrollLiabilities, reconcilePayroll, parseUscBands, type PayInputs,
} from '@/domain/payroll';

/**
 * Payroll mutations (EPIC 20). Each delegates to the domain layer, which owns
 * every figure: nothing here computes pay, tax or a total.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const opt = (f: FormData, k: string) => text(f, k) || null;
const euro = (f: FormData, k: string) => (text(f, k) ? parseAmount(text(f, k), 'EUR') : null);
const pct = (f: FormData, k: string) => {
  if (!text(f, k)) return null;
  const bp = parsePercentBasisPoints(text(f, k));
  if (bp === null) throw new Error(`"${text(f, k)}" is not a percentage.`);
  return bp;
};
const hundredths = (f: FormData, k: string) => (text(f, k) ? Math.round(Number(text(f, k)) * 100) : null);

function done(message: string, path = '/payroll'): ActionResult {
  revalidatePath('/payroll');
  if (path !== '/payroll') revalidatePath(path);
  return { ok: true, message };
}

export async function createEmployeeAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const e = createEmployee(getDb(), {
      companyId: requireCompany().id, recordedBy: await actorName(),
      firstName: text(f, 'firstName'), lastName: text(f, 'lastName'), ppsn: opt(f, 'ppsn'),
      dateOfBirth: opt(f, 'dateOfBirth'), address: opt(f, 'address'), email: opt(f, 'email'),
      employerReference: text(f, 'employerReference'), startDate: text(f, 'startDate'),
      payFrequency: text(f, 'payFrequency') as 'monthly',
      isDirector: f.get('isDirector') === 'on' || f.get('isProprietaryDirector') === 'on',
      isProprietaryDirector: f.get('isProprietaryDirector') === 'on',
    });
    return done(`${e.firstName} ${e.lastName} recorded. Set their pay terms, then record their RPN.`);
  } catch (e) { return fail(e); }
}

export async function recordPpsnAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    recordPpsn(getDb(), { companyId: requireCompany().id, employeeId: text(f, 'employeeId'), ppsn: text(f, 'ppsn'), recordedBy: await actorName() });
    return done('PPSN recorded.');
  } catch (e) { return fail(e); }
}

export async function recordCessationAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    recordCessation(getDb(), { companyId: requireCompany().id, employeeId: text(f, 'employeeId'), leftOn: text(f, 'leftOn'), recordedBy: await actorName() });
    return done('Cessation recorded.');
  } catch (e) { return fail(e); }
}

export async function setEmploymentTermsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const basis = text(f, 'payBasis') as 'salary' | 'hourly';
    setEmploymentTerms(getDb(), {
      companyId: requireCompany().id, employeeId: text(f, 'employeeId'), effectiveFrom: text(f, 'effectiveFrom'),
      recordedBy: await actorName(), payBasis: basis,
      annualSalaryMinor: basis === 'salary' ? euro(f, 'amount') : null,
      hourlyRateMinor: basis === 'hourly' ? euro(f, 'amount') : euro(f, 'hourlyRate'),
      normalHoursHundredths: hundredths(f, 'normalHours'),
      pensionScheme: (text(f, 'pensionScheme') || 'none') as 'none',
      pensionEmployeeBasisPoints: pct(f, 'pensionEmployeePct'), pensionEmployerBasisPoints: pct(f, 'pensionEmployerPct'),
    });
    return done('Employment terms recorded from that date.');
  } catch (e) { return fail(e); }
}

export async function recordRpnAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const exempt = f.get('uscExempt') === 'on';
    const basis = text(f, 'taxBasis') as 'cumulative';
    recordRpn(getDb(), {
      companyId: requireCompany().id, employeeId: text(f, 'employeeId'), recordedBy: await actorName(),
      rpnNumber: text(f, 'rpnNumber'), taxYear: Number(text(f, 'effectiveFrom').slice(0, 4)), effectiveFrom: text(f, 'effectiveFrom'),
      taxBasis: basis, yearlyTaxCreditsMinor: euro(f, 'credits') ?? 0, yearlySrcopMinor: euro(f, 'srcop') ?? 0,
      uscStatus: exempt ? 'exempt' : 'ordinary', uscBasis: basis,
      uscBands: exempt ? [] : parseUscBands(text(f, 'uscBands')),
      previousPayMinor: euro(f, 'previousPay') ?? 0, previousTaxMinor: euro(f, 'previousTax') ?? 0,
      previousUscPayMinor: euro(f, 'previousUscPay') ?? 0, previousUscMinor: euro(f, 'previousUsc') ?? 0,
    });
    return done('RPN recorded. Recompute any draft run it affects.');
  } catch (e) { return fail(e); }
}

export async function createPayRunAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const run = createPayRun(getDb(), {
      companyId: requireCompany().id, createdBy: await actorName(),
      payFrequency: text(f, 'payFrequency') as 'monthly', payDate: text(f, 'payDate'),
      insurableWeeks: text(f, 'insurableWeeks') ? Number(text(f, 'insurableWeeks')) : null,
    });
    return done(`Draft run created for ${run.payDate}. Enter hours, overtime, bonuses and benefits, then post it.`);
  } catch (e) { return fail(e); }
}

/** One employee's period inputs, from the run screen's form. */
export async function setPayInputsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const inputs: PayInputs = {};
    const hours = hundredths(f, 'hours');
    if (hours) inputs.hoursHundredths = hours;
    const salary = euro(f, 'salaryOverride');
    if (salary !== null) inputs.salaryOverrideMinor = salary;
    const otHours = hundredths(f, 'overtimeHours');
    if (otHours) inputs.overtime = [{ hoursHundredths: otHours, multiplierBasisPoints: Math.round(Number(text(f, 'overtimeMultiplier') || '0') * 10_000) }];
    const bonus = euro(f, 'bonus');
    if (bonus) inputs.bonuses = [{ kind: 'bonus', amountMinor: bonus }];
    const commission = euro(f, 'commission');
    if (commission) inputs.bonuses = [...(inputs.bonuses ?? []), { kind: 'commission', amountMinor: commission }];
    const bik = euro(f, 'benefit');
    if (bik) inputs.benefits = [{ category: (text(f, 'benefitCategory') || 'other') as 'other', amountMinor: bik, description: opt(f, 'benefitDescription') ?? undefined }];
    const runId = text(f, 'runId');
    setPayslipInputs(getDb(), { companyId: requireCompany().id, runId, employeeId: text(f, 'employeeId'), inputs });
    return done('Payslip recomputed.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function removeFromPayRunAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const runId = text(f, 'runId');
    removeFromPayRun(getDb(), { companyId: requireCompany().id, runId, employeeId: text(f, 'employeeId') });
    return done('Removed from the run.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function recomputePayRunAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const runId = text(f, 'runId');
    recomputePayRun(getDb(), { companyId: requireCompany().id, runId });
    return done('Every payslip recomputed from its inputs.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function postPayRunAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const runId = text(f, 'runId');
    postPayRun(getDb(), { companyId: requireCompany().id, runId, postedBy: await actorName() });
    return done('Pay run posted. It can no longer be changed, only reversed.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function reversePayRunAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const runId = text(f, 'runId');
    reversePayRun(getDb(), { companyId: requireCompany().id, runId, reason: text(f, 'reason'), reversedBy: await actorName(), reversalDate: opt(f, 'date') });
    return done('Pay run reversed.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function payNetWagesAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const runId = text(f, 'runId');
    payNetWages(getDb(), {
      companyId: requireCompany().id, runId, paidBy: await actorName(),
      bankTransactionId: opt(f, 'bankTransactionId'), date: opt(f, 'date'),
    });
    return done('Net pay recorded as paid.', `/payroll/runs/${runId}`);
  } catch (e) { return fail(e); }
}

export async function payPayrollTaxesAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    payPayrollLiabilities(getDb(), {
      companyId: requireCompany().id, month: text(f, 'month'), paidBy: await actorName(),
      bankTransactionId: opt(f, 'bankTransactionId'), date: opt(f, 'date'),
    });
    return done(`PAYE, USC and PRSI for ${text(f, 'month')} recorded as paid to Revenue.`);
  } catch (e) { return fail(e); }
}

export async function reconcilePayrollAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('payroll.run');
    const rec = reconcilePayroll(getDb(), { companyId: requireCompany().id, asOf: text(f, 'asOf') });
    const differences = rec.accounts.filter((a) => a.differenceMinor).length + rec.cumulativeMismatches.length;
    revalidatePath('/payroll');
    return differences
      ? { ok: true, message: `${differences} difference(s) found and added to the review queue. Nothing was adjusted.`, warnings: [] }
      : { ok: true, message: 'The payroll accounts agree with the posted runs.' };
  } catch (e) { return fail(e); }
}

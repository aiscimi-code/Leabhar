'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import {
  createProject, createSite, registerSubcontractor, recordRctContract, notifyRctPayment, recordDeductionAuthorisation, payRctPayment,
  fileRctReturn, payRctReturn, reconcileRct,
} from '@/domain/construction';

/**
 * Construction and RCT mutations (EPIC 26, issues #548, #549). Revenue's
 * figures are typed in as issued; the domain owns everything else.
 */

export type ActionResult = { ok: true; message: string; warnings?: string[] } | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string, warnings?: string[]): ActionResult => {
  revalidatePath('/construction');
  return { ok: true, message, warnings };
};
const money = (f: FormData, k: string) => parseAmount(text(f, k), requireCompany().baseCurrency);

export async function createProjectAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    createProject(getDb(), { companyId: requireCompany().id, code: text(f, 'code'), name: text(f, 'name'), startsOn: text(f, 'startsOn'), recordedBy: await actorName() });
    return done('Project added.');
  } catch (e) { return fail(e); }
}

export async function createSiteAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    createSite(getDb(), {
      companyId: requireCompany().id, name: text(f, 'name'), address: text(f, 'address'), eircode: text(f, 'eircode') || null,
      projectId: text(f, 'projectId') || null, recordedBy: await actorName(),
    });
    return done('Site added.');
  } catch (e) { return fail(e); }
}

export async function registerSubcontractorAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    registerSubcontractor(getDb(), {
      companyId: requireCompany().id, supplierId: text(f, 'supplierId'), taxReference: text(f, 'taxReference'),
      identityEvidence: text(f, 'identityEvidence'), identityCheckedBy: await actorName(), identityCheckedOn: text(f, 'identityCheckedOn'),
      notEmployeeDeclared: text(f, 'notEmployee') === 'on',
    });
    return done('Subcontractor registered.');
  } catch (e) { return fail(e); }
}

export async function recordRctContractAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    recordRctContract(getDb(), {
      companyId: requireCompany().id, subcontractorId: text(f, 'subcontractorId'), siteId: text(f, 'siteId'), projectId: text(f, 'projectId') || null,
      description: text(f, 'description'), estimatedValueMinor: money(f, 'value'), startsOn: text(f, 'startsOn'), labourOnly: text(f, 'labourOnly') === 'on',
      notifiedOn: text(f, 'notifiedOn') || null, revenueContractId: text(f, 'revenueContractId') || null, recordedBy: await actorName(),
    });
    return done('Contract recorded.');
  } catch (e) { return fail(e); }
}

export async function notifyRctPaymentAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    notifyRctPayment(getDb(), {
      companyId: requireCompany().id, contractId: text(f, 'contractId'), invoiceId: text(f, 'invoiceId'), grossMinor: money(f, 'gross'),
      notifiedOn: text(f, 'notifiedOn'), recordedBy: await actorName(),
    });
    return done('Payment notification recorded. Enter the deduction authorisation Revenue issues.');
  } catch (e) { return fail(e); }
}

export async function deductionAuthorisationAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    const { warnings } = recordDeductionAuthorisation(getDb(), {
      companyId: requireCompany().id, rctPaymentId: text(f, 'rctPaymentId'), number: text(f, 'number'),
      rateBasisPoints: Number(text(f, 'rate')) * 100, rctMinor: money(f, 'tax'),
    });
    return done('Deduction authorisation recorded.', warnings);
  } catch (e) { return fail(e); }
}

export async function payRctPaymentAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    payRctPayment(getDb(), {
      companyId: requireCompany().id, rctPaymentId: text(f, 'rctPaymentId'), bankTransactionId: text(f, 'bankTransactionId') || null,
      date: text(f, 'date') || null, paidBy: await actorName(),
    });
    return done('Paid: the invoice is settled, the tax held for the return.');
  } catch (e) { return fail(e); }
}

export async function fileRctReturnAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    fileRctReturn(getDb(), {
      companyId: requireCompany().id, period: text(f, 'period'), summaryLiabilityMinor: money(f, 'summary'), amended: text(f, 'amended') === 'on',
      filedOn: text(f, 'filedOn'), filedBy: await actorName(),
    });
    return done('Return recorded.');
  } catch (e) { return fail(e); }
}

export async function payRctReturnAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    payRctReturn(getDb(), {
      companyId: requireCompany().id, period: text(f, 'period'), bankTransactionId: text(f, 'bankTransactionId') || null,
      date: text(f, 'date') || null, paidBy: await actorName(),
    });
    return done('Return paid.');
  } catch (e) { return fail(e); }
}

export async function reconcileRctAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('construction.manage');
    const r = reconcileRct(getDb(), { companyId: requireCompany().id, asOf: text(f, 'asOf') });
    revalidatePath('/review');
    return done(r.differenceMinor === 0 && r.unauthorised.length === 0 ? 'RCT reconciles.' : 'Differences raised for review.');
  } catch (e) { return fail(e); }
}

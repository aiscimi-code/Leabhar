'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName } from '@/lib/session';
import { parseAmount, parseRate } from '@/domain/money';
import {
  registerCapitalGood, recordIntervalUse, recordCapitalGoodDisposal, postCapitalGoodAdjustment,
  postCapitalGoodDisposalAdjustment,
} from '@/domain/vat/capitalGoods';
import type { ActionResult } from './settings-actions';

/**
 * The capital goods scheme record (VATCA ss.63-64, issue #208). Every figure
 * is calculated by the domain; a person supplies only the facts: which
 * invoices, what was deducted, the use in each interval, a supply.
 */

const field = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const fail = (error: unknown): ActionResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
const done = (message: string): ActionResult => { revalidatePath('/capital-goods'); revalidatePath('/vat'); return { ok: true, message }; };

export async function registerCapitalGoodAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const kind = field(formData, 'kind');
    if (kind !== 'acquisition_or_development' && kind !== 'refurbishment') return { ok: false, error: 'Choose what kind of capital good it is.' };
    registerCapitalGood(getDb(), {
      companyId: company.id, description: field(formData, 'description'), kind,
      initialIntervalStart: field(formData, 'start'),
      sourceInvoiceIds: formData.getAll('invoices').map(String).filter(Boolean),
      deductedMinor: parseAmount(field(formData, 'deducted') || '0', company.baseCurrency),
      registeredBy: await actorName(),
    });
    return done('Capital good registered.');
  } catch (error) { return fail(error); }
}

export async function recordIntervalAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const notUsed = field(formData, 'notUsed') === 'on';
    const row = recordIntervalUse(getDb(), {
      companyId: company.id, capitalGoodId: field(formData, 'capitalGoodId'), intervalNumber: Number(field(formData, 'intervalNumber')),
      proportionBp: notUsed ? undefined : parseRate(field(formData, 'use')), notUsed, recordedBy: await actorName(),
    });
    return done(`Interval ${row.intervalNumber} recorded: ${row.working}`);
  } catch (error) { return fail(error); }
}

export async function recordDisposalAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const r = recordCapitalGoodDisposal(getDb(), {
      companyId: company.id, capitalGoodId: field(formData, 'capitalGoodId'), disposedOn: field(formData, 'date'),
      taxable: field(formData, 'taxable') === 'true', recordedBy: await actorName(),
    });
    return done(`Supply recorded. ${r.working}`);
  } catch (error) { return fail(error); }
}

export async function postCgsAdjustmentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const accountId = field(formData, 'accountId');
    const postedBy = await actorName();
    if (field(formData, 'disposal') === '1') {
      postCapitalGoodDisposalAdjustment(getDb(), { companyId: company.id, capitalGoodId: field(formData, 'capitalGoodId'), accountId, postedBy });
    } else {
      postCapitalGoodAdjustment(getDb(), { companyId: company.id, intervalId: field(formData, 'intervalId'), accountId, postedBy });
    }
    return done('Adjustment posted.');
  } catch (error) { return fail(error); }
}

'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName } from '@/lib/session';
import { confirmRctPrincipal, recordCashBasisAuthorisation } from '@/domain/config/companyStatus';
import type { ActionResult } from './settings-actions';

/**
 * The company's own VAT status (issue #208): whether it is an RCT principal
 * (the s.16(3) reverse charge) and its authorisation for the cash receipts
 * basis (s.80). Recorded by a person, by name.
 */

const field = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const fail = (error: unknown): ActionResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export async function confirmRctPrincipalAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const status = field(formData, 'status');
    if (status !== 'principal' && status !== 'not_principal') return { ok: false, error: 'Choose whether the company is a principal.' };
    confirmRctPrincipal(getDb(), {
      companyId: company.id, status, from: field(formData, 'from') || null,
      basis: field(formData, 'basis'), confirmedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'RCT principal status recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function recordCashBasisAuthorisationAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const eligibility = field(formData, 'eligibility');
    if (eligibility !== 'turnover_threshold' && eligibility !== 'supplies_to_unregistered') {
      return { ok: false, error: 'Choose which s.80(1) test the company meets.' };
    }
    recordCashBasisAuthorisation(getDb(), {
      companyId: company.id, eligibility, authorisedFrom: field(formData, 'authorisedFrom'),
      reference: field(formData, 'reference'), confirmedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    revalidatePath('/vat');
    return { ok: true, message: 'Cash basis authorisation recorded.' };
  } catch (error) {
    return fail(error);
  }
}

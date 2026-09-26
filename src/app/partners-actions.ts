'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName } from '@/lib/session';
import { addPartner, setPartnerShare } from '@/domain/config/partners';
import type { ActionResult } from './settings-actions';

/** Partners of a partnership and their profit shares (issue #212), recorded by name. */

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const percentToBp = (v: string) => Math.round(Number(v) * 100);
const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function addPartnerAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    addPartner(getDb(), {
      companyId: company.id, name: field(formData, 'name'), shareBasisPoints: percentToBp(field(formData, 'share')),
      joinedOn: field(formData, 'joinedOn'), recordedBy: await actorName(),
      isPrecedentPartner: field(formData, 'precedent') === 'on', taxReference: field(formData, 'ppsn') || null,
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Partner recorded.' };
  } catch (e) {
    return fail(e);
  }
}

export async function setPartnerShareAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    setPartnerShare(getDb(), {
      companyId: company.id, partnerId: field(formData, 'partnerId'), shareBasisPoints: percentToBp(field(formData, 'share')),
      effectiveFrom: field(formData, 'from'), recordedBy: await actorName(), basis: field(formData, 'basis') || undefined,
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Share recorded.' };
  } catch (e) {
    return fail(e);
  }
}

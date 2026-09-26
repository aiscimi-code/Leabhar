'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName } from '@/lib/session';
import { recordCtDecision, type CtSubjectType } from '@/domain/corporationTax/computation';
import type { ActionResult } from './settings-actions';

/** A person's choice on a corporation tax treatment the computation only suggested (issue #211). */
export async function recordCtDecisionAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const field = (key: string) => String(formData.get(key) ?? '').trim();
    const subjectType = field('subjectType');
    if (!['journal_line', 'income_account', 'loss_claim', 'company_status'].includes(subjectType)) return { ok: false, error: 'Unknown subject.' };
    recordCtDecision(getDb(), {
      companyId: company.id, subjectType: subjectType as CtSubjectType, subjectId: field('subjectId'), periodEnd: field('periodEnd'),
      choice: field('choice'), decidedBy: await actorName(), note: field('note') || undefined,
    });
    revalidatePath('/reports/year-end');
    return { ok: true, message: 'Treatment recorded.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { requireActor, actorName } from '@/lib/session';
import { recordCtDecision, type CtSubjectType } from '@/domain/corporationTax/computation';
import { isCtSubjectType } from '@/domain/corporationTax/subjects';
import { parseAmount } from '@/domain/money';
import type { ActionResult } from './settings-actions';

/** A person's choice on a tax treatment the computation only suggested (issues #211, #285). */
export async function recordCtDecisionAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('ct.decisions');
    const company = requireCompany();
    const field = (key: string) => String(formData.get(key) ?? '').trim();
    const subjectType = field('subjectType');
    if (!isCtSubjectType(subjectType)) return { ok: false, error: 'Unknown subject.' };
    // An s.381 claim sets the loss against other income the books do not hold:
    // the amount is the person's own figure.
    const amount = field('amount');
    recordCtDecision(getDb(), {
      companyId: company.id, subjectType: subjectType as CtSubjectType, subjectId: field('subjectId'), periodEnd: field('periodEnd'),
      choice: field('choice'), decidedBy: await actorName(), note: field('note') || undefined,
      amountMinor: amount ? parseAmount(amount, company.baseCurrency) : undefined,
    });
    revalidatePath('/reports/year-end');
    revalidatePath('/settings/company');
    return { ok: true, message: 'Treatment recorded.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

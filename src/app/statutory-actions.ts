'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { recordCompanySizeDecision } from '@/domain/reports/companySize';
import { mapAccountToFormatItem } from '@/domain/reports/schedule3A';
import type { COMPANY_SIZE_DECISION_KINDS } from '@/db/schema';

/** Company size decisions and Schedule 3A mappings (EPIC 28, issue #554). The domain owns every figure. */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };
const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string): ActionResult => {
  revalidatePath('/reports/statutory');
  return { ok: true, message };
};

export async function recordSizeDecisionAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const kind = text(f, 'kind') as (typeof COMPANY_SIZE_DECISION_KINDS)[number];
    const count = text(f, 'count');
    recordCompanySizeDecision(getDb(), {
      companyId: requireCompany().id, financialYearEnd: text(f, 'financialYearEnd'), kind,
      choice: text(f, 'choice') || null, count: count === '' ? null : Number(count), note: text(f, 'note') || null, decidedBy: await actorName(),
    });
    return done('Recorded.');
  } catch (e) { return fail(e); }
}

export async function mapFormatItemAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    mapAccountToFormatItem(getDb(), {
      companyId: requireCompany().id, accountId: text(f, 'accountId'), itemCode: text(f, 'itemCode'),
      effectiveFrom: text(f, 'effectiveFrom'), note: text(f, 'note') || null, recordedBy: await actorName(),
    });
    return done('Mapping recorded.');
  } catch (e) { return fail(e); }
}

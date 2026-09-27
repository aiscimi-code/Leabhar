'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { requireActor, actorName } from '@/lib/session';
import { addPartner, setPartnerShare, setPartnerActivityStatus } from '@/domain/config/partners';
import { recordPartnerLoan } from '@/domain/partnerships/loans';
import { recordPartnerLoanInterest } from '@/domain/partnerships/interest';
import type { ActionResult } from './settings-actions';

/**
 * Partners of a partnership and their profit shares (issue #212), recorded by
 * name, and loans between a partner and the firm (issue #314).
 */

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const percentToBp = (v: string) => Math.round(Number(v) * 100);
const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export async function addPartnerAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const company = requireCompany();
    addPartner(getDb(), {
      companyId: company.id, name: field(formData, 'name'), shareBasisPoints: percentToBp(field(formData, 'share')),
      joinedOn: field(formData, 'joinedOn'), recordedBy: await actorName(),
      isPrecedentPartner: field(formData, 'precedent') === 'on', taxReference: field(formData, 'ppsn') || null,
      activityStatus: field(formData, 'activityStatus') === 'sleeping' ? 'sleeping'
        : field(formData, 'activityStatus') === 'active' ? 'active' : null,
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Partner recorded.' };
  } catch (e) {
    return fail(e);
  }
}

/** Record whether a partner is active in the firm or sleeping (issue #493). */
export async function setPartnerActivityStatusAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const company = requireCompany();
    const status = field(formData, 'activityStatus');
    if (status !== 'active' && status !== 'sleeping') {
      return { ok: false, error: 'Say whether the partner is active or sleeping.' };
    }
    setPartnerActivityStatus(getDb(), {
      companyId: company.id, partnerId: field(formData, 'partnerId'),
      activityStatus: status, recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: status === 'sleeping'
        ? 'Recorded as sleeping: no earned income credit is given on their share (TCA s.1008(5)).'
        : 'Recorded as active.',
    };
  } catch (e) {
    return fail(e);
  }
}

export async function setPartnerShareAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
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

/** Money a partner lends the firm, or the firm repaying them (issue #314). */
export async function recordPartnerLoanAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const company = requireCompany();
    const direction = field(formData, 'direction') === 'repaid' ? 'repaid' : 'advanced';
    const amountMinor = Math.round(Number(field(formData, 'amount')) * 100);
    const result = recordPartnerLoan(getDb(), {
      companyId: company.id,
      partnerId: field(formData, 'partnerId'),
      direction,
      amountMinor,
      date: field(formData, 'date'),
      recordedBy: await actorName(),
      narrative: field(formData, 'narrative') || undefined,
    });
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: direction === 'advanced'
        ? `Loan recorded: entry ${result.entryNumber}. ${result.partner.name} is now owed ${(result.balanceMinor / 100).toFixed(2)} on their loan account.`
        : `Repayment recorded: entry ${result.entryNumber}. ${result.partner.name} is now owed ${(result.balanceMinor / 100).toFixed(2)} on their loan account.`,
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Interest accrued on a partner's loan over a period (issue #464). The amount
 * is computed from the loan account, never typed in; whether the firm may
 * deduct it in computing its profits is a decision, raised on the year-end
 * decisions list, not a policy of this book.
 */
export async function recordPartnerLoanInterestAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const company = requireCompany();
    const rateBasisPoints = percentToBp(field(formData, 'rate'));
    const result = recordPartnerLoanInterest(getDb(), {
      companyId: company.id,
      partnerId: field(formData, 'partnerId'),
      rateBasisPoints,
      from: field(formData, 'from'),
      to: field(formData, 'to'),
      recordedBy: await actorName(),
      narrative: field(formData, 'narrative') || undefined,
    });
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: `Interest recorded: entry ${result.entryNumber}. ${(result.amountMinor / 100).toFixed(2)} accrued to `
        + `${result.partner.name} at ${(rateBasisPoints / 100).toFixed(2)}%, who is now owed `
        + `${(result.balanceMinor / 100).toFixed(2)} on their loan account. Whether the firm may deduct it is `
        + 'decided on the year-end decisions list.',
    };
  } catch (e) {
    return fail(e);
  }
}

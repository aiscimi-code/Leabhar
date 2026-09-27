'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import { recordCtDecision } from '@/domain/corporationTax/subjects';
import { parsePercent } from '@/domain/farm';
import {
  recordGrant, linkGrantReceipt, reconcileGrants, recordFarmPartnershipRegistration, recordShareFarming,
  type GrantKind, type FarmPartnershipRegister,
} from '@/domain/farmTax';

/**
 * Farm tax and grants mutations (EPIC 25, issues #543–#546). The domain and
 * the tax computations own every figure; these only pass the form on.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string): ActionResult => {
  revalidatePath('/farm/tax');
  return { ok: true, message };
};

export async function recordGrantAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    const company = requireCompany();
    recordGrant(getDb(), {
      companyId: company.id, scheme: text(f, 'scheme'), payer: text(f, 'payer'), reference: text(f, 'reference') || null,
      kind: text(f, 'kind') as GrantKind, awardedMinor: parseAmount(text(f, 'awarded'), company.baseCurrency),
      awardedOn: text(f, 'awardedOn'), fixedAssetId: text(f, 'fixedAssetId') || null, recordedBy: await actorName(),
    });
    return done('Grant recorded.');
  } catch (e) { return fail(e); }
}

export async function linkGrantReceiptAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    linkGrantReceipt(getDb(), {
      companyId: requireCompany().id, grantId: text(f, 'grantId'), journalLineId: text(f, 'journalLineId'), recordedBy: await actorName(),
    });
    return done('Receipt linked.');
  } catch (e) { return fail(e); }
}

export async function reconcileGrantsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    const r = reconcileGrants(getDb(), { companyId: requireCompany().id, asOf: text(f, 'asOf') });
    revalidatePath('/review');
    return done(r.unlinked.length ? `${r.unlinked.length} grant receipt(s) not linked: see the review queue.` : 'Every grant receipt is linked.');
  } catch (e) { return fail(e); }
}

/** A farming profit for a year before these books, for income averaging (s.657): the person's figure and its source. */
export async function recordFarmProfitAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('ct.decisions');
    const company = requireCompany();
    const raw = text(f, 'profit');
    const amount = raw.startsWith('-') ? -parseAmount(raw.slice(1), company.baseCurrency) : parseAmount(raw, company.baseCurrency);
    recordCtDecision(getDb(), {
      companyId: company.id, subjectType: 'farm_prior_profit', subjectId: company.id, periodEnd: `${Number(text(f, 'year'))}-12-31`,
      choice: 'recorded', amountMinor: amount, note: text(f, 'source'), decidedBy: await actorName(),
    });
    revalidatePath('/reports/year-end');
    return done('Profit recorded.');
  } catch (e) { return fail(e); }
}

export async function farmPartnershipRegisterAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    recordFarmPartnershipRegistration(getDb(), {
      companyId: requireCompany().id, register: text(f, 'register') as FarmPartnershipRegister, identifier: text(f, 'identifier'),
      registeredOn: text(f, 'registeredOn'), recordedBy: await actorName(),
    });
    return done('Registration recorded.');
  } catch (e) { return fail(e); }
}

export async function shareFarmingAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    recordShareFarming(getDb(), {
      companyId: requireCompany().id, counterparty: text(f, 'counterparty'), landProvidedBy: text(f, 'landProvidedBy') as 'this_farm' | 'counterparty',
      parcelIds: f.getAll('parcelIds').map(String).filter(Boolean), outputShareBasisPoints: parsePercent(text(f, 'outputShare')),
      costShareBasisPoints: parsePercent(text(f, 'costShare')), startsOn: text(f, 'startsOn'), endsOn: text(f, 'endsOn') || null,
      recordedBy: await actorName(),
    });
    return done('Arrangement recorded.');
  } catch (e) { return fail(e); }
}

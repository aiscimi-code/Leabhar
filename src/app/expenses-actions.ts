'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { can } from '@/domain/auth/permissions';
import {
  createExpenseClaim, approveExpenseClaim, rejectExpenseClaim, reimburseExpenseClaim,
  reverseExpenseClaim,
} from '@/domain/expenses/claims';
import { parseAmount } from '@/domain/money';
import { asIsoDate, today } from '@/domain/dates';

/**
 * Expense claim mutations (issue #306). Each delegates to the domain layer,
 * which owns the accounting: nothing here computes a figure, so the screen and
 * the books cannot disagree about what a claim is worth.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function createExpenseClaimAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireActor('expenses.submit');
    const db = getDb();
    const company = requireCompany();
    const actor = await actorName();

    const claimantType = String(formData.get('claimantType') ?? 'officer');
    const claimantId = String(formData.get('claimantId') ?? '');
    const title = String(formData.get('title') ?? '');
    if (!claimantId) return { ok: false, error: 'Choose who this claim is for.' };
    // Someone who cannot approve claims submits only their own: otherwise a
    // claim could put money owed on someone else's account.
    if (!can(user.role, 'expenses.approve') && (claimantType !== 'user' || claimantId !== user.id)) {
      return { ok: false, error: 'You can submit a claim for yourself only.' };
    }
    if (!title.trim()) return { ok: false, error: 'Give the claim a title.' };

    const lineType = String(formData.get('lineType') ?? 'mileage');
    const date = String(formData.get('date') ?? '');
    const description = String(formData.get('description') ?? '');
    const accountId = String(formData.get('accountId') ?? '');
    if (!date || !description.trim() || !accountId) {
      return { ok: false, error: 'Each claim line needs a date, a description and an account.' };
    }

    const unitsRaw = formData.get('units');
    const amountRaw = formData.get('amount');
    const rateId = formData.get('rateId') ? String(formData.get('rateId')) : undefined;
    const units = unitsRaw && String(unitsRaw).trim() !== '' ? Number(unitsRaw) : undefined;
    const businessPctRaw = formData.get('businessUsePct');
    const businessUseBasisPoints = businessPctRaw && String(businessPctRaw).trim() !== ''
      ? Math.round(Number(businessPctRaw) * 100)
      : undefined;
    if (businessUseBasisPoints !== undefined
      && (!Number.isFinite(businessUseBasisPoints) || businessUseBasisPoints < 0 || businessUseBasisPoints > 10_000)) {
      return { ok: false, error: 'The business-use share must be between 0 and 100 percent.' };
    }

    if (lineType === 'mileage' || lineType === 'subsistence') {
      if (!rateId || !units) {
        return {
          ok: false,
          error: 'A mileage or subsistence line needs the rate that was in force and the '
            + 'distance or the nights claimed — the amount comes from the rate.',
        };
      }
    } else if (!amountRaw || String(amountRaw).trim() === '') {
      return { ok: false, error: 'Enter the amount spent.' };
    }

    const result = createExpenseClaim(db, {
      companyId: company.id,
      claimant: claimantType === 'user' ? { userId: claimantId } : { officerId: claimantId },
      title,
      lines: [{
        lineType: lineType as 'mileage' | 'travel' | 'subsistence' | 'receipt',
        date: asIsoDate(date),
        description,
        accountId,
        ...(lineType === 'mileage' || lineType === 'subsistence'
          ? { rateId, units: units! }
          : { amountMinor: parseAmount(String(amountRaw), company.baseCurrency) }),
        ...(businessUseBasisPoints !== undefined ? { businessUseBasisPoints } : {}),
      }],
      actor,
    });

    revalidatePath('/expenses');
    return {
      ok: true,
      message: `Claim submitted for approval: ${(result.totalMinor / 100).toFixed(2)} `
        + `${company.baseCurrency}, of which ${(result.businessMinor / 100).toFixed(2)} is business.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function approveExpenseClaimAction(formData: FormData): Promise<ActionResult> {
  try {
    const approver = await requireActor('expenses.approve');
    const claimId = String(formData.get('claimId') ?? '');
    const result = approveExpenseClaim(getDb(), {
      companyId: requireCompany().id, claimId, actor: await actorName(), approverUserId: approver.id,
    });
    revalidatePath('/expenses');
    return { ok: true, message: `Claim approved and posted as journal entry ${result.entryNumber}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectExpenseClaimAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('expenses.approve');
    const claimId = String(formData.get('claimId') ?? '');
    const reason = String(formData.get('reason') ?? '');
    if (!reason.trim()) return { ok: false, error: 'Give the reason the claimant will see.' };
    rejectExpenseClaim(getDb(), {
      companyId: requireCompany().id, claimId, reason, actor: await actorName(),
    });
    revalidatePath('/expenses');
    return { ok: true, message: 'Claim rejected. The reason is recorded on it.' };
  } catch (error) {
    return fail(error);
  }
}

export async function reimburseExpenseClaimAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('expenses.reimburse');
    const claimId = String(formData.get('claimId') ?? '');
    const bankTransactionId = formData.get('bankTransactionId')
      ? String(formData.get('bankTransactionId')) : null;
    const date = formData.get('date') ? asIsoDate(String(formData.get('date'))) : null;

    if (!bankTransactionId && !date) {
      return {
        ok: false,
        error: 'Reimburse from a bank line, or give the date the money was paid.',
      };
    }

    const result = reimburseExpenseClaim(getDb(), {
      companyId: requireCompany().id, claimId,
      bankTransactionId, date: bankTransactionId ? null : date,
      actor: await actorName(),
    });
    revalidatePath('/expenses');
    revalidatePath('/transactions');
    return {
      ok: true,
      message: `Reimbursed ${(result.amountMinor / 100).toFixed(2)} (journal entry ${result.entryNumber}).`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseExpenseClaimAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('expenses.approve');
    const claimId = String(formData.get('claimId') ?? '');
    const reason = String(formData.get('reason') ?? '');
    if (!reason.trim()) return { ok: false, error: 'Give the reason the claim was wrong.' };
    reverseExpenseClaim(getDb(), {
      companyId: requireCompany().id, claimId, reason, actor: await actorName(),
    });
    revalidatePath('/expenses');
    return { ok: true, message: 'Claim reversed. The approval journal has a reversing entry.' };
  } catch (error) {
    return fail(error);
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import type { ActionResult } from './settings-actions';
import {
  recordTradingName, endTradingName,
  recordTradingActivity, ceaseTradingActivity,
  recordRegistration, endRegistration,
  recordEuVatNumber, recordEoriNumber,
  ceaseTrade, archiveCompany, unarchiveCompany,
  type TradingSector, type RegistrationType,
  TRADING_SECTORS, REGISTRATION_TYPES,
} from '@/domain/config/businessProfile';

/**
 * The business profile (issue #297): trading names and activities,
 * registrations, cross-border identifiers, closure and archive. Each
 * delegates to the domain layer, so the effective-dating and audit rules hold
 * whichever screen the change came from. Registration numbers are validated
 * there, not here.
 */

const field = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const optional = (formData: FormData, key: string): string | null => {
  const value = field(formData, key);
  return value === '' ? null : value;
};
const fail = (error: unknown): ActionResult =>
  ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export async function recordTradingNameAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    recordTradingName(getDb(), {
      companyId: company.id,
      name: field(formData, 'name'),
      effectiveFrom: field(formData, 'effectiveFrom'),
      notes: optional(formData, 'notes'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    revalidatePath('/');
    return { ok: true, message: 'Trading name recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function endTradingNameAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    endTradingName(getDb(), {
      companyId: company.id,
      tradingNameId: field(formData, 'tradingNameId'),
      effectiveTo: field(formData, 'effectiveTo'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    revalidatePath('/');
    return { ok: true, message: 'Trading name ended on that date.' };
  } catch (error) {
    return fail(error);
  }
}

export async function recordTradingActivityAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    const sector = field(formData, 'sector') as TradingSector;
    if (!TRADING_SECTORS.includes(sector)) return { ok: false, error: 'Choose the sector this activity trades in.' };
    recordTradingActivity(getDb(), {
      companyId: company.id,
      name: field(formData, 'name'),
      sector,
      commencedOn: field(formData, 'commencedOn'),
      herdNumber: optional(formData, 'herdNumber'),
      notes: optional(formData, 'notes'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Trading activity recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function ceaseTradingActivityAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    ceaseTradingActivity(getDb(), {
      companyId: company.id,
      activityId: field(formData, 'activityId'),
      ceasedOn: field(formData, 'ceasedOn'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Activity recorded as ceased on that date.' };
  } catch (error) {
    return fail(error);
  }
}

export async function recordRegistrationAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    const registrationType = field(formData, 'registrationType') as RegistrationType;
    if (!REGISTRATION_TYPES.includes(registrationType)) {
      return { ok: false, error: 'Choose what kind of registration this is.' };
    }
    const { warnings } = recordRegistration(getDb(), {
      companyId: company.id,
      registrationType,
      label: optional(formData, 'label'),
      registrationNumber: optional(formData, 'registrationNumber'),
      registeredFrom: field(formData, 'registeredFrom'),
      notes: optional(formData, 'notes'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Registration recorded.', warnings };
  } catch (error) {
    return fail(error);
  }
}

export async function endRegistrationAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    endRegistration(getDb(), {
      companyId: company.id,
      registrationId: field(formData, 'registrationId'),
      deregisteredOn: field(formData, 'deregisteredOn'),
      recordedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'Registration recorded as ended on that date.' };
  } catch (error) {
    return fail(error);
  }
}

export async function recordEuVatNumberAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    recordEuVatNumber(getDb(), {
      companyId: company.id,
      vatNumber: field(formData, 'vatNumber'),
      registeredFrom: field(formData, 'registeredFrom'),
      basis: field(formData, 'basis'),
      confirmedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'EU VAT identification number recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function recordEoriNumberAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    recordEoriNumber(getDb(), {
      companyId: company.id,
      eoriNumber: field(formData, 'eoriNumber'),
      basis: field(formData, 'basis'),
      confirmedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    return { ok: true, message: 'EORI number recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function ceaseTradeAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    const { warnings } = ceaseTrade(getDb(), {
      companyId: company.id,
      ceasedOn: field(formData, 'ceasedOn'),
      basis: field(formData, 'basis'),
      vatDeregistrationOn: optional(formData, 'vatDeregistrationOn'),
      confirmedBy: await actorName(),
    });
    revalidatePath('/settings/company');
    revalidatePath('/');
    return { ok: true, message: 'Trade cessation recorded.', warnings };
  } catch (error) {
    return fail(error);
  }
}

export async function archiveCompanyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const company = requireCompany();
    const { warnings } = archiveCompany(getDb(), {
      companyId: company.id,
      basis: field(formData, 'basis'),
      confirmedBy: await actorName(),
    });
    revalidatePath('/');
    revalidatePath('/settings/company');
    return { ok: true, message: 'These books are archived. Nothing in them has changed.', warnings };
  } catch (error) {
    return fail(error);
  }
}

export async function unarchiveCompanyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage', field(formData, 'companyId'));
    unarchiveCompany(getDb(), {
      companyId: field(formData, 'companyId'),
      confirmedBy: await actorName(),
    });
    revalidatePath('/');
    revalidatePath('/settings/company');
    return { ok: true, message: 'Business brought back into the working set.' };
  } catch (error) {
    return fail(error);
  }
}

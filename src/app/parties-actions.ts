'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName } from '@/lib/session';
import {
  confirmEstablishment, confirmCustomerTaxableStatus, checkVatNumberWithVies, type PartyKind,
} from '@/domain/parties/status';
import type { ActionResult } from './settings-actions';

/**
 * Supplier and customer VAT status (issue #207): where the party is
 * established, whether a customer buys as a business, and a VIES check of its
 * VAT number. Confirmation is always a person's, recorded by name.
 */

const field = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();
const kindOf = (formData: FormData): PartyKind => (field(formData, 'party') === 'customer' ? 'customer' : 'supplier');
const pathFor = (kind: PartyKind, id: string) => (kind === 'supplier' ? `/suppliers/${id}` : `/customers/${id}`);
const fail = (error: unknown): ActionResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

export async function confirmEstablishmentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const party = kindOf(formData);
    const partyId = field(formData, 'partyId');
    const establishment = field(formData, 'establishment');
    if (establishment !== 'in_state' && establishment !== 'outside_state') {
      return { ok: false, error: 'Choose where the business is established.' };
    }
    confirmEstablishment(getDb(), {
      companyId: company.id, party, partyId, establishment,
      basis: field(formData, 'basis'), confirmedBy: await actorName(),
    });
    revalidatePath(pathFor(party, partyId));
    return { ok: true, message: 'Establishment recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function confirmTaxableStatusAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const customerId = field(formData, 'partyId');
    const taxableStatus = field(formData, 'taxableStatus');
    if (taxableStatus !== 'taxable_person' && taxableStatus !== 'non_taxable_person') {
      return { ok: false, error: 'Choose whether the customer buys as a business or as a consumer.' };
    }
    confirmCustomerTaxableStatus(getDb(), { companyId: company.id, customerId, taxableStatus, confirmedBy: await actorName() });
    revalidatePath(pathFor('customer', customerId));
    return { ok: true, message: 'Customer status recorded.' };
  } catch (error) {
    return fail(error);
  }
}

export async function checkViesAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const party = kindOf(formData);
    const partyId = field(formData, 'partyId');
    const result = await checkVatNumberWithVies(getDb(), {
      companyId: company.id, party, partyId, requesterVatNumber: company.vatNumber, actor: await actorName(),
    });
    revalidatePath(pathFor(party, partyId));
    if (result.status === 'unavailable') {
      return { ok: false, error: `VIES could not answer (${result.detail}). The number is not treated as checked; try again later.` };
    }
    return {
      ok: true,
      message: result.status === 'valid'
        ? `VIES: ${result.checkedVatNumber} is valid${result.name ? ` (${result.name})` : ''}.`
        : `VIES: ${result.checkedVatNumber} is NOT valid.`,
    };
  } catch (error) {
    return fail(error);
  }
}

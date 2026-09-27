'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import { parseQuantity } from '@/domain/inventory';
import {
  saveFarmProfile, addLandParcel, endLandParcel, parseHectares, createEnterprise, allocateJournalLine, createAnimalGroup,
  registerAnimal, recordLivestockEvent, parsePercent, transferLivestock, reverseLivestockEvent, postLivestockValuation, createPlanting, recordHarvest,
  type EnterpriseKind, type LandTenure, type Species, type SimpleEventKind, type CropInputKind,
} from '@/domain/farm';

/**
 * Farm mutations (EPIC 24, issues #539–#541). The domain owns every area,
 * count and figure; these only pass the form on.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string, warnings?: string[]): ActionResult => {
  revalidatePath('/farm');
  return { ok: true, message, warnings };
};

export async function saveFarmProfileAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    saveFarmProfile(getDb(), {
      companyId: requireCompany().id, farmName: text(f, 'farmName'), flockNumber: text(f, 'flockNumber') || null,
      tradingActivityId: text(f, 'tradingActivityId') || null, recordedBy: await actorName(),
    });
    return done('Farm profile saved.');
  } catch (e) { return fail(e); }
}

export async function addLandParcelAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    const company = requireCompany();
    addLandParcel(getDb(), {
      companyId: company.id, reference: text(f, 'reference'), name: text(f, 'name'), areaSqm: parseHectares(text(f, 'hectares')),
      tenure: text(f, 'tenure') as LandTenure, heldFrom: text(f, 'heldFrom'), heldTo: text(f, 'heldTo') || null,
      counterparty: text(f, 'counterparty') || null,
      annualRentMinor: text(f, 'rent') ? parseAmount(text(f, 'rent'), company.baseCurrency) : null, recordedBy: await actorName(),
    });
    return done('Parcel added.');
  } catch (e) { return fail(e); }
}

export async function endLandParcelAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    endLandParcel(getDb(), { companyId: requireCompany().id, parcelId: text(f, 'parcelId'), heldTo: text(f, 'heldTo') });
    return done('Parcel ended.');
  } catch (e) { return fail(e); }
}

export async function createEnterpriseAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    createEnterprise(getDb(), {
      companyId: requireCompany().id, name: text(f, 'name'), kind: text(f, 'kind') as EnterpriseKind, startedOn: text(f, 'startedOn'),
      recordedBy: await actorName(),
    });
    return done('Enterprise added.');
  } catch (e) { return fail(e); }
}

export async function allocateLineAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    allocateJournalLine(getDb(), {
      companyId: requireCompany().id, journalLineId: text(f, 'journalLineId'), enterpriseId: text(f, 'enterpriseId'),
      basisPoints: parsePercent(text(f, 'percent')), plantingId: text(f, 'plantingId') || null,
      inputKind: (text(f, 'inputKind') || null) as CropInputKind | null, recordedBy: await actorName(),
    });
    return done('Allocated.');
  } catch (e) { return fail(e); }
}

export async function createAnimalGroupAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    createAnimalGroup(getDb(), {
      companyId: requireCompany().id, enterpriseId: text(f, 'enterpriseId'), name: text(f, 'name'), species: text(f, 'species') as Species,
      recordedBy: await actorName(),
    });
    return done('Group added.');
  } catch (e) { return fail(e); }
}

export async function registerAnimalAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    registerAnimal(getDb(), {
      companyId: requireCompany().id, tagNumber: text(f, 'tagNumber'), species: text(f, 'species') as Species,
      sex: (text(f, 'sex') || null) as 'female' | 'male' | 'castrated_male' | null, breed: text(f, 'breed') || null,
      dateOfBirth: text(f, 'dateOfBirth') || null, damTag: text(f, 'damTag') || null, recordedBy: await actorName(),
    });
    return done('Animal registered.');
  } catch (e) { return fail(e); }
}

export async function livestockEventAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    const company = requireCompany();
    recordLivestockEvent(getDb(), {
      companyId: company.id, kind: text(f, 'kind') as SimpleEventKind, groupId: text(f, 'groupId'), date: text(f, 'date'),
      headCount: text(f, 'headCount') ? Number(text(f, 'headCount')) : undefined, animalId: text(f, 'animal') || null,
      amountMinor: text(f, 'amount') ? parseAmount(text(f, 'amount'), company.baseCurrency) : null, reason: text(f, 'reason') || null,
      recordedBy: await actorName(),
    });
    return done('Recorded.');
  } catch (e) { return fail(e); }
}

export async function moveLivestockAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    transferLivestock(getDb(), {
      companyId: requireCompany().id, fromGroupId: text(f, 'fromGroupId'), toGroupId: text(f, 'toGroupId'), date: text(f, 'date'),
      headCount: text(f, 'headCount') ? Number(text(f, 'headCount')) : undefined, animalId: text(f, 'animal') || null,
      recordedBy: await actorName(),
    });
    return done('Moved.');
  } catch (e) { return fail(e); }
}

export async function reverseLivestockEventAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    reverseLivestockEvent(getDb(), {
      companyId: requireCompany().id, eventId: text(f, 'eventId'), date: text(f, 'date'), reason: text(f, 'reason'), recordedBy: await actorName(),
    });
    return done('Reversed. The original stays on file.');
  } catch (e) { return fail(e); }
}

/** One value per head and basis per group, from the valuation form's rows. */
export async function postLivestockValuationAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    const company = requireCompany();
    const groupIds = f.getAll('groupId').map(String);
    const values: Record<string, { valuePerHeadMinor: number; basis: string }> = {};
    groupIds.forEach((id, i) => {
      const v = String(f.getAll('valuePerHead')[i] ?? '').trim();
      if (v) values[id] = { valuePerHeadMinor: parseAmount(v, company.baseCurrency), basis: String(f.getAll('basis')[i] ?? '').trim() };
    });
    const { journalEntryId } = postLivestockValuation(getDb(), {
      companyId: company.id, date: text(f, 'date'), opening: text(f, 'opening') === 'on', values, postedBy: await actorName(),
    });
    revalidatePath('/reports');
    return done(journalEntryId ? 'Livestock valuation posted.' : 'Valuation recorded with no journal.');
  } catch (e) { return fail(e); }
}

export async function createPlantingAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    const { warnings } = createPlanting(getDb(), {
      companyId: requireCompany().id, enterpriseId: text(f, 'enterpriseId'), parcelId: text(f, 'parcelId'), crop: text(f, 'crop'),
      variety: text(f, 'variety') || null, harvestYear: Number(text(f, 'harvestYear')), areaSqm: parseHectares(text(f, 'hectares')),
      sownOn: text(f, 'sownOn') || null, recordedBy: await actorName(),
    });
    return done('Planting added.', warnings);
  } catch (e) { return fail(e); }
}

export async function recordHarvestAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('farm.manage');
    recordHarvest(getDb(), {
      companyId: requireCompany().id, plantingId: text(f, 'plantingId'), harvestedOn: text(f, 'harvestedOn'),
      quantityMilli: parseQuantity(text(f, 'quantity')), unit: text(f, 'unit'), recordedBy: await actorName(),
    });
    return done('Harvest recorded.');
  } catch (e) { return fail(e); }
}

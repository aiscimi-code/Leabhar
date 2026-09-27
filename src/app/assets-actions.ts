'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import { registerFixedAsset, recordCarEmissions, transferFixedAsset, reconcileFixedAssets } from '@/domain/assets/register';

/**
 * Fixed asset register mutations (issue #534, #466). The domain owns every
 * figure; these only pass the form on.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function registerFixedAssetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    const company = requireCompany();
    const grams = text(f, 'co2');
    const { asset, warnings } = registerFixedAsset(getDb(), {
      companyId: company.id, name: text(f, 'name'), description: text(f, 'description') || null,
      assetCategory: text(f, 'assetCategory') as 'computer_equipment', purchaseDate: text(f, 'purchaseDate'),
      costMinor: parseAmount(text(f, 'cost'), company.baseCurrency), accountId: text(f, 'accountId'),
      usefulLifeMonths: text(f, 'usefulLifeMonths') ? Number(text(f, 'usefulLifeMonths')) : undefined,
      co2EmissionsGramsPerKm: grams ? Number(grams) : null, co2EmissionsEvidence: text(f, 'co2Evidence') || null,
      recordedBy: await actorName(),
    });
    revalidatePath('/assets');
    return { ok: true, message: `${asset.name} registered.`, warnings };
  } catch (e) { return fail(e); }
}

export async function recordCarEmissionsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    recordCarEmissions(getDb(), {
      companyId: requireCompany().id, assetId: text(f, 'assetId'), gramsPerKm: Number(text(f, 'co2')),
      evidence: text(f, 'evidence'), reason: text(f, 'reason') || undefined, recordedBy: await actorName(),
    });
    revalidatePath('/assets');
    return { ok: true, message: 'CO2 emissions recorded: the capital allowances follow Part 11C from now on.' };
  } catch (e) { return fail(e); }
}

export async function transferFixedAssetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    transferFixedAsset(getDb(), {
      companyId: requireCompany().id, assetId: text(f, 'assetId'), toAccountId: text(f, 'toAccountId'),
      date: text(f, 'date'), reason: text(f, 'reason'), recordedBy: await actorName(),
    });
    revalidatePath('/assets');
    return { ok: true, message: 'Transferred: the journal moves its cost to the new account.' };
  } catch (e) { return fail(e); }
}

export async function reconcileFixedAssetsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    const rec = reconcileFixedAssets(getDb(), { companyId: requireCompany().id, asOf: text(f, 'asOf') });
    const differences = rec.accounts.filter((a) => a.differenceMinor !== 0);
    revalidatePath('/assets');
    return differences.length
      ? { ok: true, message: `${differences.length} account(s) differ from the register; they are in the review queue. Nothing was adjusted.`,
        warnings: differences.map((d) => `${d.code} ${d.name}: ledger ${(d.ledgerMinor / 100).toFixed(2)}, register ${(d.registerMinor / 100).toFixed(2)}`) }
      : { ok: true, message: 'The fixed asset accounts agree with the register.' };
  } catch (e) { return fail(e); }
}

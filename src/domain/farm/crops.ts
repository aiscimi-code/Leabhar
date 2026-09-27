import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { cropHarvests, cropPlantings } from '@/db/schema';
import { ids } from '@/lib/ids';
import { multiplyRational } from '../money';
import { allocatedAmounts } from './allocations';
import { FarmError, areaFigures, requireEnterprise, requireFarmDate, requireParcel } from './setup';

/**
 * Crops (EPIC 24, issue #541): a crop on a field (a land parcel) for a
 * harvest year, its harvests, and its inputs and sales, which are allocations
 * of posted lines (`allocations.ts`), so every cost is a ledger figure.
 */

export type CropPlanting = typeof cropPlantings.$inferSelect;
export type CropHarvest = typeof cropHarvests.$inferSelect;

export function createPlanting(db: AppDatabase, p: {
  companyId: string; enterpriseId: string; parcelId: string; crop: string; variety?: string | null; harvestYear: number;
  areaSqm: number; sownOn?: string | null; notes?: string | null; recordedBy: string;
}): { planting: CropPlanting; warnings: string[] } {
  const enterprise = requireEnterprise(db, p.companyId, p.enterpriseId);
  const parcel = requireParcel(db, p.companyId, p.parcelId);
  if (!p.crop.trim()) throw new FarmError('Name the crop.');
  if (!Number.isInteger(p.harvestYear) || p.harvestYear < 1900 || p.harvestYear > 2999) throw new FarmError('The harvest year is a year.');
  if (!Number.isInteger(p.areaSqm) || p.areaSqm <= 0) throw new FarmError('The area sown is a positive number of square metres.');
  if (p.areaSqm > parcel.areaSqm) {
    throw new FarmError(`${parcel.reference} is ${(parcel.areaSqm / 10_000).toFixed(4)} ha: no more than that can be sown on it.`);
  }
  const sownOn = p.sownOn ? requireFarmDate(p.sownOn, 'The sowing date') : null;
  const yearStart = `${p.harvestYear - 1}-01-01`;
  const yearEnd = `${p.harvestYear}-12-31`;
  if (parcel.heldFrom > yearEnd || (parcel.heldTo && parcel.heldTo < yearStart)) {
    throw new FarmError(`${parcel.reference} is not held by the farm for the ${p.harvestYear} harvest.`);
  }
  if (sownOn && (sownOn < parcel.heldFrom || (parcel.heldTo && sownOn > parcel.heldTo))) {
    throw new FarmError(`${parcel.reference} is not held by the farm on ${sownOn}.`);
  }
  const warnings: string[] = [];
  const same = db.select().from(cropPlantings)
    .where(and(eq(cropPlantings.parcelId, parcel.id), eq(cropPlantings.harvestYear, p.harvestYear))).all();
  const sown = same.reduce((s, x) => s + x.areaSqm, 0) + p.areaSqm;
  if (sown > parcel.areaSqm) {
    warnings.push(`${parcel.reference} now carries ${(sown / 10_000).toFixed(4)} ha of crops for ${p.harvestYear} on `
      + `${(parcel.areaSqm / 10_000).toFixed(4)} ha: right for a catch crop or double cropping, otherwise check the areas.`);
  }
  const id = ids.cropPlanting();
  db.insert(cropPlantings).values({
    id, companyId: p.companyId, enterpriseId: enterprise.id, parcelId: parcel.id, crop: p.crop.trim(), variety: p.variety?.trim() || null,
    harvestYear: p.harvestYear, areaSqm: p.areaSqm, sownOn, notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return { planting: db.select().from(cropPlantings).where(eq(cropPlantings.id, id)).get()!, warnings };
}

export function requirePlanting(db: AppDatabase, companyId: string, plantingId: string): CropPlanting {
  const p = db.select().from(cropPlantings).where(and(eq(cropPlantings.id, plantingId), eq(cropPlantings.companyId, companyId))).get();
  if (!p) throw new FarmError(`Crop planting ${plantingId} not found.`);
  return p;
}

/** Record a harvest from a planting (issue #541). */
export function recordHarvest(db: AppDatabase, p: {
  companyId: string; plantingId: string; harvestedOn: string; quantityMilli: number; unit: string; notes?: string | null; recordedBy: string;
}): CropHarvest {
  const planting = requirePlanting(db, p.companyId, p.plantingId);
  const date = requireFarmDate(p.harvestedOn, 'The harvest date');
  if (planting.sownOn && date < planting.sownOn) throw new FarmError('A crop is harvested after it is sown.');
  if (!Number.isInteger(p.quantityMilli) || p.quantityMilli <= 0) throw new FarmError('The quantity is positive, in thousandths of the unit.');
  const unit = p.unit.trim();
  if (!unit) throw new FarmError('Give the unit harvested (tonnes, bales).');
  const id = ids.cropHarvest();
  db.insert(cropHarvests).values({
    id, companyId: p.companyId, plantingId: planting.id, harvestedOn: date, quantityMilli: p.quantityMilli, unit,
    notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(cropHarvests).where(eq(cropHarvests.id, id)).get()!;
}

export interface CropReportLine {
  planting: CropPlanting;
  area: ReturnType<typeof areaFigures>;
  inputs: Record<'seed' | 'fertiliser' | 'chemicals' | 'contractor' | 'other', number>;
  inputsMinor: number;
  salesMinor: number;
  marginMinor: number;
  /** Margin per hectare sown, in minor units. */
  marginPerHectareMinor: number;
  harvests: Array<{ unit: string; quantityMilli: number; yieldPerHectareMilli: number }>;
}

/**
 * Crop costs, sales, margin and yield by planting (issue #541), for a
 * harvest year or all of them. Yield is harvest per hectare sown.
 */
export function cropReport(db: AppDatabase, p: { companyId: string; harvestYear?: number }): CropReportLine[] {
  const where = [eq(cropPlantings.companyId, p.companyId)];
  if (p.harvestYear) where.push(eq(cropPlantings.harvestYear, p.harvestYear));
  const plantings = db.select().from(cropPlantings).where(and(...where)).orderBy(asc(cropPlantings.harvestYear), asc(cropPlantings.crop)).all();
  const { amounts } = allocatedAmounts(db, p.companyId);
  return plantings.map((planting) => {
    const mine = amounts.filter((a) => a.plantingId === planting.id);
    const inputs = { seed: 0, fertiliser: 0, chemicals: 0, contractor: 0, other: 0 };
    for (const a of mine) if (a.inputKind && a.inputKind !== 'sales') inputs[a.inputKind] += a.amountMinor;
    const inputsMinor = Object.values(inputs).reduce((s, v) => s + v, 0);
    const salesMinor = mine.filter((a) => a.inputKind === 'sales').reduce((s, a) => s + a.amountMinor, 0);
    const marginMinor = salesMinor - inputsMinor;
    const byUnit = new Map<string, number>();
    for (const h of db.select().from(cropHarvests).where(eq(cropHarvests.plantingId, planting.id)).all()) {
      byUnit.set(h.unit, (byUnit.get(h.unit) ?? 0) + h.quantityMilli);
    }
    return {
      planting, area: areaFigures(planting.areaSqm), inputs, inputsMinor, salesMinor, marginMinor,
      marginPerHectareMinor: multiplyRational(marginMinor, 10_000, planting.areaSqm),
      harvests: [...byUnit].map(([unit, quantityMilli]) => ({
        unit, quantityMilli, yieldPerHectareMilli: multiplyRational(quantityMilli, 10_000, planting.areaSqm),
      })),
    };
  });
}

export function listPlantings(db: AppDatabase, companyId: string): CropPlanting[] {
  return db.select().from(cropPlantings).where(eq(cropPlantings.companyId, companyId))
    .orderBy(asc(cropPlantings.harvestYear), asc(cropPlantings.crop)).all();
}

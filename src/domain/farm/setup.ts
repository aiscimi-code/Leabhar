import { and, asc, eq, isNull, or, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companyTradingActivities, farmEnterprises, farmProfiles, fixedAssets, landParcels, ENTERPRISE_KINDS, LAND_TENURES } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { multiplyRational } from '../money';

/**
 * Farm setup (EPIC 24, issue #539): the farm profile, its land parcels owned
 * and leased, the area farmed on a date, and its enterprises.
 */

export class FarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FarmError';
  }
}

export type FarmProfile = typeof farmProfiles.$inferSelect;
export type LandParcel = typeof landParcels.$inferSelect;
export type FarmEnterprise = typeof farmEnterprises.$inferSelect;
export type EnterpriseKind = (typeof ENTERPRISE_KINDS)[number];
export type LandTenure = (typeof LAND_TENURES)[number];

export function requireFarmDate(value: string, what: string): string {
  if (!isIsoDate(value)) throw new FarmError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

/** Square metres in an international acre, as a rational: 4046.8564224 = 40468564224 / 10^7. */
const ACRE_NUM = 40_468_564_224;
const ACRE_DEN = 10_000_000;

/** An area in hectares (to four decimal places, i.e. whole square metres) as square metres. */
export function parseHectares(text: string): number {
  if (!/^\d+(\.\d{1,4})?$/.test(text.trim())) throw new FarmError(`"${text}" is not an area in hectares (up to four decimal places).`);
  const [whole, frac = ''] = text.trim().split('.');
  return Number(whole) * 10_000 + Number(frac.padEnd(4, '0'));
}

/** Square metres as hundredths of a hectare and of an acre, rounded to the nearest hundredth. */
export function areaFigures(areaSqm: number): { areaSqm: number; hectaresHundredths: number; acresHundredths: number } {
  return {
    areaSqm,
    hectaresHundredths: multiplyRational(areaSqm, 1, 100),
    acresHundredths: multiplyRational(areaSqm, 100 * ACRE_DEN, ACRE_NUM),
  };
}

/** Record or change the farm profile. It describes; it posts nothing. */
export function saveFarmProfile(db: AppDatabase, p: {
  companyId: string; farmName: string; tradingActivityId?: string | null; flockNumber?: string | null;
  areaUnit?: 'hectares' | 'acres'; notes?: string | null; recordedBy: string;
}): FarmProfile {
  if (!p.farmName.trim()) throw new FarmError('Give the farm a name.');
  if (p.tradingActivityId) {
    const activity = db.select().from(companyTradingActivities)
      .where(and(eq(companyTradingActivities.id, p.tradingActivityId), eq(companyTradingActivities.companyId, p.companyId))).get();
    if (!activity) throw new FarmError(`Trading activity ${p.tradingActivityId} not found.`);
    if (activity.sector !== 'farming') throw new FarmError(`${activity.name} is a ${activity.sector} activity, not farming.`);
  }
  const values = {
    farmName: p.farmName.trim(), tradingActivityId: p.tradingActivityId ?? null, flockNumber: p.flockNumber?.trim() || null,
    areaUnit: p.areaUnit ?? 'hectares', notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  };
  const existing = db.select().from(farmProfiles).where(eq(farmProfiles.companyId, p.companyId)).get();
  if (existing) {
    db.update(farmProfiles).set({ ...values, updatedAt: nowIso() }).where(eq(farmProfiles.id, existing.id)).run();
  } else {
    db.insert(farmProfiles).values({ id: ids.farmProfile(), companyId: p.companyId, ...values }).run();
  }
  return db.select().from(farmProfiles).where(eq(farmProfiles.companyId, p.companyId)).get()!;
}

/** The profile, with the herd number of the farming activity it trades as. */
export function farmProfile(db: AppDatabase, companyId: string): (FarmProfile & { herdNumber: string | null }) | null {
  const profile = db.select().from(farmProfiles).where(eq(farmProfiles.companyId, companyId)).get();
  if (!profile) return null;
  const activity = profile.tradingActivityId
    ? db.select().from(companyTradingActivities).where(eq(companyTradingActivities.id, profile.tradingActivityId)).get()
    : undefined;
  return { ...profile, herdNumber: activity?.herdNumber ?? null };
}

export interface AddLandParcelInput {
  companyId: string; reference: string; name: string; areaSqm: number; tenure: LandTenure; heldFrom: string;
  heldTo?: string | null; counterparty?: string | null; annualRentMinor?: number | null; fixedAssetId?: string | null;
  notes?: string | null; recordedBy: string;
}

const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');

/** Record a parcel held from a date, owned or leased (issue #539). */
export function addLandParcel(db: AppDatabase, p: AddLandParcelInput): LandParcel {
  const reference = p.reference.trim();
  if (!reference || !p.name.trim()) throw new FarmError('Give the parcel a reference and a name.');
  if (!Number.isInteger(p.areaSqm) || p.areaSqm <= 0) throw new FarmError('The area is a positive number of square metres.');
  if (!LAND_TENURES.includes(p.tenure)) throw new FarmError('Land is owned or leased.');
  const from = requireFarmDate(p.heldFrom, 'The date it was held from');
  const to = p.heldTo ? requireFarmDate(p.heldTo, 'The date it was held to') : null;
  if (to && to < from) throw new FarmError('A parcel is held to a date on or after it was held from.');
  if (p.tenure === 'leased') {
    if (!p.counterparty?.trim()) throw new FarmError('Record who the land is leased from.');
    if (p.fixedAssetId) throw new FarmError('Leased land is not the farm\'s fixed asset.');
  }
  if (p.annualRentMinor !== undefined && p.annualRentMinor !== null) {
    if (p.tenure !== 'leased') throw new FarmError('Only leased land has a rent.');
    if (!Number.isInteger(p.annualRentMinor) || p.annualRentMinor < 0) throw new FarmError('The rent is a whole number of minor units.');
  }
  if (p.fixedAssetId) {
    const asset = db.select().from(fixedAssets).where(and(eq(fixedAssets.id, p.fixedAssetId), eq(fixedAssets.companyId, p.companyId))).get();
    if (!asset) throw new FarmError(`Fixed asset ${p.fixedAssetId} not found.`);
  }
  const same = db.select().from(landParcels).where(and(eq(landParcels.companyId, p.companyId), eq(landParcels.reference, reference))).all();
  const clash = same.find((x) => overlaps(x.heldFrom, x.heldTo, from, to));
  if (clash) {
    throw new FarmError(`Parcel ${reference} is already held from ${clash.heldFrom}${clash.heldTo ? ` to ${clash.heldTo}` : ''}: `
      + 'end that period first.');
  }
  const id = ids.landParcel();
  db.insert(landParcels).values({
    id, companyId: p.companyId, reference, name: p.name.trim(), areaSqm: p.areaSqm, tenure: p.tenure, heldFrom: from, heldTo: to,
    counterparty: p.counterparty?.trim() || null, annualRentMinor: p.annualRentMinor ?? null, fixedAssetId: p.fixedAssetId ?? null,
    notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(landParcels).where(eq(landParcels.id, id)).get()!;
}

/** The parcel stops being held after a date: the lease ends, or the land is sold. */
export function endLandParcel(db: AppDatabase, p: { companyId: string; parcelId: string; heldTo: string }): LandParcel {
  const parcel = requireParcel(db, p.companyId, p.parcelId);
  const to = requireFarmDate(p.heldTo, 'The date it was held to');
  if (to < parcel.heldFrom) throw new FarmError('A parcel is held to a date on or after it was held from.');
  if (parcel.heldTo) throw new FarmError(`Parcel ${parcel.reference} already ended on ${parcel.heldTo}.`);
  db.update(landParcels).set({ heldTo: to, updatedAt: nowIso() }).where(eq(landParcels.id, parcel.id)).run();
  return db.select().from(landParcels).where(eq(landParcels.id, parcel.id)).get()!;
}

export function requireParcel(db: AppDatabase, companyId: string, parcelId: string): LandParcel {
  const parcel = db.select().from(landParcels).where(and(eq(landParcels.id, parcelId), eq(landParcels.companyId, companyId))).get();
  if (!parcel) throw new FarmError(`Land parcel ${parcelId} not found.`);
  return parcel;
}

export function listLandParcels(db: AppDatabase, companyId: string): LandParcel[] {
  return db.select().from(landParcels).where(eq(landParcels.companyId, companyId))
    .orderBy(asc(landParcels.reference), asc(landParcels.heldFrom)).all();
}

export interface FarmedArea {
  asOf: string;
  owned: ReturnType<typeof areaFigures>;
  leased: ReturnType<typeof areaFigures>;
  total: ReturnType<typeof areaFigures>;
  annualRentMinor: number;
  parcels: LandParcel[];
}

/** The area farmed on a date, owned and leased, with the parcels behind it (issue #539). */
export function farmedArea(db: AppDatabase, p: { companyId: string; asOf: string }): FarmedArea {
  const asOf = requireFarmDate(p.asOf, 'The date');
  const parcels = db.select().from(landParcels).where(and(
    eq(landParcels.companyId, p.companyId), lte(landParcels.heldFrom, asOf),
    or(isNull(landParcels.heldTo), gte(landParcels.heldTo, asOf)),
  )).orderBy(asc(landParcels.reference)).all();
  const sum = (t: LandTenure) => parcels.filter((x) => x.tenure === t).reduce((s, x) => s + x.areaSqm, 0);
  return {
    asOf, owned: areaFigures(sum('owned')), leased: areaFigures(sum('leased')),
    total: areaFigures(sum('owned') + sum('leased')),
    annualRentMinor: parcels.reduce((s, x) => s + (x.annualRentMinor ?? 0), 0), parcels,
  };
}

/** Set up an enterprise (issue #539). */
export function createEnterprise(db: AppDatabase, p: {
  companyId: string; name: string; kind: EnterpriseKind; startedOn: string; recordedBy: string;
}): FarmEnterprise {
  const name = p.name.trim();
  if (!name) throw new FarmError('Give the enterprise a name.');
  if (!ENTERPRISE_KINDS.includes(p.kind)) throw new FarmError(`An enterprise is one of: ${ENTERPRISE_KINDS.join(', ')}.`);
  const clash = db.select({ id: farmEnterprises.id }).from(farmEnterprises)
    .where(and(eq(farmEnterprises.companyId, p.companyId), eq(farmEnterprises.name, name))).get();
  if (clash) throw new FarmError(`There is already an enterprise called ${name}.`);
  const id = ids.farmEnterprise();
  db.insert(farmEnterprises).values({
    id, companyId: p.companyId, name, kind: p.kind, startedOn: requireFarmDate(p.startedOn, 'The start date'), recordedBy: p.recordedBy,
  }).run();
  return db.select().from(farmEnterprises).where(eq(farmEnterprises.id, id)).get()!;
}

export function endEnterprise(db: AppDatabase, p: { companyId: string; enterpriseId: string; endedOn: string }): FarmEnterprise {
  const e = requireEnterprise(db, p.companyId, p.enterpriseId);
  const endedOn = requireFarmDate(p.endedOn, 'The end date');
  if (endedOn < e.startedOn) throw new FarmError('An enterprise ends on or after it started.');
  db.update(farmEnterprises).set({ endedOn, updatedAt: nowIso() }).where(eq(farmEnterprises.id, e.id)).run();
  return db.select().from(farmEnterprises).where(eq(farmEnterprises.id, e.id)).get()!;
}

export function requireEnterprise(db: AppDatabase, companyId: string, idOrName: string): FarmEnterprise {
  const e = db.select().from(farmEnterprises).where(and(eq(farmEnterprises.companyId, companyId), eq(farmEnterprises.id, idOrName))).get()
    ?? db.select().from(farmEnterprises).where(and(eq(farmEnterprises.companyId, companyId), eq(farmEnterprises.name, idOrName))).get();
  if (!e) throw new FarmError(`Enterprise ${idOrName} not found.`);
  return e;
}

export function listEnterprises(db: AppDatabase, companyId: string): FarmEnterprise[] {
  return db.select().from(farmEnterprises).where(eq(farmEnterprises.companyId, companyId)).orderBy(asc(farmEnterprises.name)).all();
}

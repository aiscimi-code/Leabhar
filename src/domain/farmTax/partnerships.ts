import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, farmPartnershipRegistrations, landParcels, shareFarmingArrangements, FARM_PARTNERSHIP_REGISTERS } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { farmFigure } from './reliefs';

/**
 * Farm partnerships and share farming (EPIC 25, issue #546). A registered
 * farm partnership (s.667C) gets the 50% stock relief rate; a succession farm
 * partnership (s.667D) gives its partners a €5,000 a year tax credit, against
 * income tax these books do not compute for them. A share farming
 * arrangement is a record: each party farms on its own account.
 */

export class FarmPartnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FarmPartnershipError';
  }
}

export type FarmPartnershipRegister = (typeof FARM_PARTNERSHIP_REGISTERS)[number];

function requireDate(value: string, what: string): string {
  if (!isIsoDate(value)) throw new FarmPartnershipError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

export function recordFarmPartnershipRegistration(db: AppDatabase, p: {
  companyId: string; register: FarmPartnershipRegister; identifier: string; registeredOn: string; recordedBy: string;
}) {
  const company = db.select().from(companies).where(eq(companies.id, p.companyId)).get();
  if (!company) throw new FarmPartnershipError(`Company ${p.companyId} not found.`);
  if (company.entityType !== 'partnership') {
    throw new FarmPartnershipError('Only a partnership is entered on the register of farm partnerships: these books are not a partnership\'s.');
  }
  if (!FARM_PARTNERSHIP_REGISTERS.includes(p.register)) throw new FarmPartnershipError('The register is registered_farm_partnership or succession_farm_partnership.');
  if (!p.identifier.trim()) throw new FarmPartnershipError('Give the unique identifier the register assigned.');
  const registeredOn = requireDate(p.registeredOn, 'The registration date');
  if (p.register === 'succession_farm_partnership') {
    const base = db.select().from(farmPartnershipRegistrations)
      .where(and(eq(farmPartnershipRegistrations.companyId, p.companyId), eq(farmPartnershipRegistrations.register, 'registered_farm_partnership'))).all()
      .find((r) => r.registeredOn <= registeredOn && (!r.endedOn || r.endedOn >= registeredOn));
    if (!base) throw new FarmPartnershipError('A succession farm partnership is a registered farm partnership first (s.667D(1)): record that registration.');
  }
  const open = db.select().from(farmPartnershipRegistrations)
    .where(and(eq(farmPartnershipRegistrations.companyId, p.companyId), eq(farmPartnershipRegistrations.register, p.register))).all()
    .find((r) => !r.endedOn);
  if (open) throw new FarmPartnershipError(`The partnership is already on that register from ${open.registeredOn}: end that entry first.`);
  const id = ids.farmPartnershipRegistration();
  db.insert(farmPartnershipRegistrations).values({
    id, companyId: p.companyId, register: p.register, identifier: p.identifier.trim(), registeredOn, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(farmPartnershipRegistrations).where(eq(farmPartnershipRegistrations.id, id)).get()!;
}

export function endFarmPartnershipRegistration(db: AppDatabase, p: { companyId: string; registrationId: string; endedOn: string }) {
  const r = db.select().from(farmPartnershipRegistrations)
    .where(and(eq(farmPartnershipRegistrations.id, p.registrationId), eq(farmPartnershipRegistrations.companyId, p.companyId))).get();
  if (!r) throw new FarmPartnershipError(`Registration ${p.registrationId} not found.`);
  if (r.endedOn) throw new FarmPartnershipError(`That registration ended on ${r.endedOn}.`);
  const endedOn = requireDate(p.endedOn, 'The end date');
  if (endedOn < r.registeredOn) throw new FarmPartnershipError('A registration ends on or after it began.');
  db.update(farmPartnershipRegistrations).set({ endedOn, updatedAt: nowIso() }).where(eq(farmPartnershipRegistrations.id, r.id)).run();
  return db.select().from(farmPartnershipRegistrations).where(eq(farmPartnershipRegistrations.id, r.id)).get()!;
}

export function listFarmPartnershipRegistrations(db: AppDatabase, companyId: string) {
  return db.select().from(farmPartnershipRegistrations).where(eq(farmPartnershipRegistrations.companyId, companyId))
    .orderBy(asc(farmPartnershipRegistrations.registeredOn)).all();
}

/** The succession tax credit for a year, where the partnership was on the succession register in it (s.667D). */
export function successionCreditFor(db: AppDatabase, companyId: string, year: number): { creditMinor: number; identifier: string } | null {
  const r = listFarmPartnershipRegistrations(db, companyId).find((x) => x.register === 'succession_farm_partnership'
    && x.registeredOn <= `${year}-12-31` && (!x.endedOn || x.endedOn >= `${year}-01-01`));
  if (!r) return null;
  return { creditMinor: farmFigure(db, companyId, 'farm.succession_credit', `${year}-12-31`), identifier: r.identifier };
}

export function recordShareFarming(db: AppDatabase, p: {
  companyId: string; counterparty: string; landProvidedBy: 'this_farm' | 'counterparty'; parcelIds?: string[];
  outputShareBasisPoints: number; costShareBasisPoints: number; startsOn: string; endsOn?: string | null; notes?: string | null;
  recordedBy: string;
}) {
  if (!p.counterparty.trim()) throw new FarmPartnershipError('Name the other party to the arrangement.');
  for (const bp of [p.outputShareBasisPoints, p.costShareBasisPoints]) {
    if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new FarmPartnershipError('A share is between 0% and 100%.');
  }
  const startsOn = requireDate(p.startsOn, 'The start date');
  const endsOn = p.endsOn ? requireDate(p.endsOn, 'The end date') : null;
  if (endsOn && endsOn < startsOn) throw new FarmPartnershipError('The arrangement ends on or after it starts.');
  const parcelIds = p.parcelIds ?? [];
  for (const id of parcelIds) {
    const parcel = db.select().from(landParcels).where(and(eq(landParcels.id, id), eq(landParcels.companyId, p.companyId))).get();
    if (!parcel) throw new FarmPartnershipError(`Land parcel ${id} not found.`);
  }
  if (p.landProvidedBy === 'this_farm' && parcelIds.length === 0) {
    throw new FarmPartnershipError('Name the farm\'s parcels the arrangement covers.');
  }
  const id = ids.shareFarming();
  db.insert(shareFarmingArrangements).values({
    id, companyId: p.companyId, counterparty: p.counterparty.trim(), landProvidedBy: p.landProvidedBy, parcelIds,
    outputShareBasisPoints: p.outputShareBasisPoints, costShareBasisPoints: p.costShareBasisPoints, startsOn, endsOn,
    notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(shareFarmingArrangements).where(eq(shareFarmingArrangements.id, id)).get()!;
}

export function listShareFarming(db: AppDatabase, companyId: string) {
  return db.select().from(shareFarmingArrangements).where(eq(shareFarmingArrangements.companyId, companyId))
    .orderBy(asc(shareFarmingArrangements.startsOn)).all();
}

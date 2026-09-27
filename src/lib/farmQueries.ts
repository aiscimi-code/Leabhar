import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, farmAllocations, journalEntries, journalLines } from '@/db/schema';
import {
  farmProfile, farmedArea, listLandParcels, listEnterprises, enterpriseGrossMargins, listAnimalGroups, listAnimals, headCounts,
  listLivestockEvents, listLivestockValuations, listPlantings, cropReport,
} from '@/domain/farm';
import { requireCompany } from './queries';

/**
 * Read models for the farm screen (EPIC 24). Every area, count and margin
 * comes from the farm domain; these only gather it for a page.
 */

/** Recent posted income and expense lines not yet fully allocated: what the allocation form offers. */
function allocatableLines(companyId: string) {
  const db = getDb();
  const lines = db.select({
    id: journalLines.id, entryDate: journalEntries.entryDate, narrative: journalEntries.narrative, accountCode: accounts.code,
    accountName: accounts.name, debit: journalLines.baseDebitMinor, credit: journalLines.baseCreditMinor, accountType: accounts.type,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.companyId, companyId), eq(journalEntries.isPosted, true), inArray(accounts.type, ['income', 'expense'])))
    .orderBy(desc(journalEntries.entryDate)).limit(300).all()
    .filter((l) => l.accountType === 'income' || l.accountType === 'expense');
  const taken = new Map<string, number>();
  if (lines.length) {
    for (const a of db.select().from(farmAllocations).where(inArray(farmAllocations.journalLineId, lines.map((l) => l.id))).all()) {
      taken.set(a.journalLineId, (taken.get(a.journalLineId) ?? 0) + a.basisPoints);
    }
  }
  return lines.map((l) => ({ ...l, allocatedBasisPoints: taken.get(l.id) ?? 0 })).filter((l) => l.allocatedBasisPoints < 10_000).slice(0, 100);
}

export function farmPage(params: { asOf: string; from: string; to: string; harvestYear: number }) {
  const db = getDb();
  const company = requireCompany();
  const counts = headCounts(db, { companyId: company.id, asOf: params.asOf });
  return {
    company,
    profile: farmProfile(db, company.id),
    area: farmedArea(db, { companyId: company.id, asOf: params.asOf }),
    parcels: listLandParcels(db, company.id),
    enterprises: listEnterprises(db, company.id),
    margins: enterpriseGrossMargins(db, { companyId: company.id, from: params.from, to: params.to }),
    groups: listAnimalGroups(db, company.id).map((g) => ({ ...g, headCount: counts.get(g.id) ?? 0 })),
    animals: listAnimals(db, company.id),
    events: listLivestockEvents(db, company.id).slice(0, 100),
    valuations: listLivestockValuations(db, company.id),
    plantings: listPlantings(db, company.id),
    crops: cropReport(db, { companyId: company.id, harvestYear: params.harvestYear }),
    lines: allocatableLines(company.id),
  };
}

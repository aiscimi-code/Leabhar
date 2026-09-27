import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, farmAllocations, fixedAssets, journalEntries, journalLines } from '@/db/schema';
import { farmTaxSummary, reconcileGrants, listFarmPartnershipRegistrations, listShareFarming } from '@/domain/farmTax';
import { accountingYearContaining } from '@/domain/vat/apportionment';
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

/** The farm tax screen (EPIC 25): the year's summary, the grants register and the records behind the reliefs. */
export function farmTaxPage(year: number) {
  const db = getDb();
  const company = requireCompany();
  let summary: ReturnType<typeof farmTaxSummary> | null = null;
  let summaryError: string | null = null;
  try {
    if (company.entityType === 'company') {
      const period = accountingYearContaining(db, company.id, `${year}-12-31`);
      summary = farmTaxSummary(db, { companyId: company.id, from: period.start, to: period.end });
    } else {
      summary = farmTaxSummary(db, { companyId: company.id, year });
    }
  } catch (e) {
    summaryError = e instanceof Error ? e.message : String(e);
  }
  const grantLines = db.select({
    id: journalLines.id, entryDate: journalEntries.entryDate, narrative: journalEntries.narrative, accountCode: accounts.code,
    credit: journalLines.baseCreditMinor, debit: journalLines.baseDebitMinor,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.companyId, company.id), eq(journalEntries.isPosted, true)))
    .orderBy(desc(journalEntries.entryDate)).limit(400).all()
    .filter((l) => l.credit > l.debit)
    .slice(0, 100);
  return {
    company, summary, summaryError,
    grants: reconcileGrants(db, { companyId: company.id, asOf: `${year}-12-31`, raiseReviewItems: false }),
    assets: db.select().from(fixedAssets).where(eq(fixedAssets.companyId, company.id)).all(),
    creditLines: grantLines,
    registrations: listFarmPartnershipRegistrations(db, company.id),
    shareFarming: listShareFarming(db, company.id),
    parcels: listLandParcels(db, company.id),
  };
}

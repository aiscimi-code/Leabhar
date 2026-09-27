import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { companyTradingActivities, journalLines, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany } from '../config/setup';
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import {
  saveFarmProfile, farmProfile, addLandParcel, endLandParcel, farmedArea, parseHectares, areaFigures, createEnterprise,
  allocateJournalLine, removeAllocation, enterpriseGrossMargins, createAnimalGroup, registerAnimal, recordLivestockEvent,
  transferLivestock, reverseLivestockEvent, headCounts, animalStatus, planLivestockValuation, postLivestockValuation,
  createPlanting, recordHarvest, cropReport,
} from '.';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let bank: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Feirm Ltd', chartKind: 'farm', seedYears: [2025, 2026] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  bank = created.accountsByKey['bank_control']!;
});

/** A posted bank payment or receipt against a P&L account; returns the P&L line id. */
function post(code: string, amountMinor: number, date = '2025-04-01', income = false): { entryId: string; lineId: string } {
  const entry = postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative: code, sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: income
      ? [{ accountId: bank, debitMinor: amountMinor }, { accountId: byCode[code]!, creditMinor: amountMinor }]
      : [{ accountId: byCode[code]!, debitMinor: amountMinor }, { accountId: bank, creditMinor: amountMinor }],
  });
  const line = db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id)).all()
    .find((l) => l.accountId === byCode[code])!;
  return { entryId: entry.id, lineId: line.id };
}

describe('farm setup (issue #539)', () => {
  it('keeps one profile with the herd number of its farming activity', () => {
    const activityId = ids.tradingActivity();
    db.insert(companyTradingActivities).values({
      id: activityId, companyId, name: 'Dairy farm', sector: 'farming', commencedOn: '2020-01-01', herdNumber: 'Y1234567', recordedBy: 'o',
    }).run();
    saveFarmProfile(db, { companyId, farmName: 'Gort na Móna', tradingActivityId: activityId, recordedBy: 'o' });
    saveFarmProfile(db, { companyId, farmName: 'Gort na Móna', tradingActivityId: activityId, flockNumber: 'F99', recordedBy: 'o' });
    expect(farmProfile(db, companyId)).toMatchObject({ herdNumber: 'Y1234567', flockNumber: 'F99' });
  });

  it('measures area exactly and totals owned and leased land on a date', () => {
    expect(parseHectares('12.3456')).toBe(123_456);
    expect(() => parseHectares('1.23456')).toThrow(/four decimal places/);
    // One acre is 4046.8564224 m².
    expect(areaFigures(4_047).acresHundredths).toBe(100);
    addLandParcel(db, { companyId, reference: 'P1', name: 'Home farm', areaSqm: 200_000, tenure: 'owned', heldFrom: '2010-01-01', recordedBy: 'o' });
    const lease = addLandParcel(db, {
      companyId, reference: 'P2', name: 'Murphy\'s', areaSqm: 50_000, tenure: 'leased', heldFrom: '2024-03-01', counterparty: 'J. Murphy',
      annualRentMinor: 150_000, recordedBy: 'o',
    });
    expect(() => addLandParcel(db, { companyId, reference: 'P2', name: 'x', areaSqm: 1, tenure: 'owned', heldFrom: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/already held/);
    expect(() => addLandParcel(db, { companyId, reference: 'P3', name: 'x', areaSqm: 1, tenure: 'leased', heldFrom: '2025-01-01', recordedBy: 'o' }))
      .toThrow(/leased from/);
    const area = farmedArea(db, { companyId, asOf: '2025-06-30' });
    expect([area.owned.areaSqm, area.leased.areaSqm, area.total.hectaresHundredths, area.annualRentMinor]).toEqual([200_000, 50_000, 2_500, 150_000]);
    endLandParcel(db, { companyId, parcelId: lease.id, heldTo: '2025-12-31' });
    expect(farmedArea(db, { companyId, asOf: '2026-01-01' }).leased.areaSqm).toBe(0);
    // Bought after the lease ended: a new period of the same reference.
    addLandParcel(db, { companyId, reference: 'P2', name: 'Murphy\'s', areaSqm: 50_000, tenure: 'owned', heldFrom: '2026-01-01', recordedBy: 'o' });
    expect(farmedArea(db, { companyId, asOf: '2026-06-30' }).owned.areaSqm).toBe(250_000);
  });
});

describe('allocations and gross margins (issue #539)', () => {
  it('allocates shares of posted lines, never over 100%, and reports what is unallocated', () => {
    const dairy = createEnterprise(db, { companyId, name: 'Dairy', kind: 'dairy', startedOn: '2020-01-01', recordedBy: 'o' });
    const beef = createEnterprise(db, { companyId, name: 'Beef', kind: 'beef', startedOn: '2020-01-01', recordedBy: 'o' });
    const milk = post('4000', 1_000_000, '2025-05-01', true);
    const feed = post('5050', 300_000);
    const vet = post('6210', 50_000);
    allocateJournalLine(db, { companyId, journalLineId: milk.lineId, enterpriseId: dairy.id, basisPoints: 10_000, recordedBy: 'o' });
    allocateJournalLine(db, { companyId, journalLineId: feed.lineId, enterpriseId: dairy.id, basisPoints: 7_000, recordedBy: 'o' });
    const b = allocateJournalLine(db, { companyId, journalLineId: feed.lineId, enterpriseId: beef.id, basisPoints: 2_000, recordedBy: 'o' });
    expect(() => allocateJournalLine(db, { companyId, journalLineId: feed.lineId, enterpriseId: beef.id, basisPoints: 1_001, recordedBy: 'o' }))
      .toThrow(/10\.00% is left/);
    const bankLine = db.select().from(journalLines).where(eq(journalLines.journalEntryId, feed.entryId)).all().find((l) => l.accountId === bank)!;
    expect(() => allocateJournalLine(db, { companyId, journalLineId: bankLine.id, enterpriseId: beef.id, basisPoints: 100, recordedBy: 'o' }))
      .toThrow(/not an income or expense/);

    const report = enterpriseGrossMargins(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    expect(report.enterprises.find((e) => e.name === 'Dairy')).toMatchObject({ outputMinor: 1_000_000, variableCostsMinor: 210_000, grossMarginMinor: 790_000 });
    expect(report.enterprises.find((e) => e.name === 'Beef')).toMatchObject({ variableCostsMinor: 60_000, grossMarginMinor: -60_000 });
    expect(report.unallocated).toEqual({ incomeMinor: 0, costOfSalesMinor: 30_000, overheadsMinor: 50_000 });
    // Allocated plus unallocated is the ledger's cost of sales.
    const cos = report.enterprises.reduce((s, e) => s + e.variableCostsMinor, 0) + report.unallocated.costOfSalesMinor;
    expect(cos).toBe(accountBalance(db, { companyId, accountId: byCode['5050']!, asOf: asIsoDate('2025-12-31') }));
    void vet;

    removeAllocation(db, { companyId, allocationId: b.id, reason: 'Wrong enterprise', actor: 'o' });
    expect(enterpriseGrossMargins(db, { companyId, from: '2025-01-01', to: '2025-12-31' }).unallocated.costOfSalesMinor).toBe(90_000);
  });

  it('a reversed line takes its allocation with it', () => {
    const dairy = createEnterprise(db, { companyId, name: 'Dairy', kind: 'dairy', startedOn: '2020-01-01', recordedBy: 'o' });
    const feed = post('5050', 100_000);
    allocateJournalLine(db, { companyId, journalLineId: feed.lineId, enterpriseId: dairy.id, basisPoints: 10_000, recordedBy: 'o' });
    reverseJournalEntry(db, { companyId, entryId: feed.entryId, reversalDate: asIsoDate('2025-06-01'), reason: 'Duplicate' });
    const report = enterpriseGrossMargins(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    expect(report.enterprises[0]!.variableCostsMinor).toBe(0);
    expect(report.unallocated.costOfSalesMinor).toBe(0);
  });
});

describe('livestock (issue #540)', () => {
  let herd: string;
  let calves: string;
  let dairy: string;
  beforeEach(() => {
    dairy = createEnterprise(db, { companyId, name: 'Dairy', kind: 'dairy', startedOn: '2020-01-01', recordedBy: 'o' }).id;
    herd = createAnimalGroup(db, { companyId, enterpriseId: dairy, name: 'Dairy cows', species: 'cattle', recordedBy: 'o' }).id;
    calves = createAnimalGroup(db, { companyId, enterpriseId: dairy, name: 'Calves', species: 'cattle', recordedBy: 'o' }).id;
  });

  it('keeps head counts from events and refuses a group below nil on any date', () => {
    recordLivestockEvent(db, { companyId, kind: 'opening', groupId: herd, date: '2025-01-01', headCount: 50, recordedBy: 'o' });
    recordLivestockEvent(db, { companyId, kind: 'birth', groupId: calves, date: '2025-02-10', headCount: 40, recordedBy: 'o' });
    recordLivestockEvent(db, { companyId, kind: 'sale', groupId: calves, date: '2025-04-01', headCount: 30, amountMinor: 900_000, recordedBy: 'o' });
    expect(() => recordLivestockEvent(db, { companyId, kind: 'death', groupId: calves, date: '2025-03-01', headCount: 11, reason: 'Scour', recordedBy: 'o' }))
      .toThrow(/below nil/);
    expect(() => recordLivestockEvent(db, { companyId, kind: 'death', groupId: calves, date: '2025-03-01', headCount: 1, recordedBy: 'o' }))
      .toThrow(/cause of death/);
    transferLivestock(db, { companyId, fromGroupId: calves, toGroupId: herd, date: '2025-05-01', headCount: 10, recordedBy: 'o' });
    const counts = headCounts(db, { companyId, asOf: '2025-12-31' });
    expect([counts.get(herd), counts.get(calves)]).toEqual([60, 0]);
  });

  it('follows a tagged animal, and reverses a transfer as a pair', () => {
    const cow = registerAnimal(db, { companyId, tagNumber: 'ie1234567 0001', species: 'cattle', sex: 'female', recordedBy: 'o' });
    recordLivestockEvent(db, { companyId, kind: 'purchase', groupId: calves, date: '2025-02-01', animalId: cow.id, amountMinor: 30_000, recordedBy: 'o' });
    expect(() => recordLivestockEvent(db, { companyId, kind: 'purchase', groupId: calves, date: '2025-02-02', animalId: cow.id, recordedBy: 'o' }))
      .toThrow(/already on the farm/);
    const moved = transferLivestock(db, { companyId, fromGroupId: calves, toGroupId: herd, date: '2025-06-01', animalId: 'IE1234567 0001', recordedBy: 'o' });
    expect(animalStatus(db, cow.id)).toEqual({ groupId: herd, onFarm: true });
    expect(() => recordLivestockEvent(db, { companyId, kind: 'sale', groupId: calves, date: '2025-07-01', animalId: cow.id, recordedBy: 'o' }))
      .toThrow(/not in that group/);
    reverseLivestockEvent(db, { companyId, eventId: moved.out.id, date: '2025-06-02', reason: 'Wrong group', recordedBy: 'o' });
    expect(animalStatus(db, cow.id)).toEqual({ groupId: calves, onFarm: true });
    recordLivestockEvent(db, { companyId, kind: 'sale', groupId: calves, date: '2025-07-01', animalId: cow.id, recordedBy: 'o' });
    expect(animalStatus(db, cow.id).onFarm).toBe(false);
  });

  it('values the herd: the opening agrees to the opening balance, later ones post only the change', () => {
    recordLivestockEvent(db, { companyId, kind: 'opening', groupId: herd, date: '2025-01-01', headCount: 10, recordedBy: 'o' });
    postJournalEntry(db, {
      companyId, entryDate: asIsoDate('2025-01-01'), narrative: 'Opening balances', sourceType: 'opening_balance', baseCurrency: 'EUR',
      lines: [{ accountId: byCode['1330']!, debitMinor: 1_000_000 }, { accountId: byCode['3100']!, creditMinor: 1_000_000 }],
    });
    expect(() => postLivestockValuation(db, {
      companyId, date: '2025-01-01', opening: true, values: { [herd]: { valuePerHeadMinor: 90_000, basis: 'Cost' } }, postedBy: 'o',
    })).toThrow(/does not agree/);
    expect(db.select().from(reviewItems).all()).toHaveLength(1);
    const opening = postLivestockValuation(db, {
      companyId, date: '2025-01-01', opening: true, values: { [herd]: { valuePerHeadMinor: 100_000, basis: 'Cost' } }, postedBy: 'o',
    });
    expect(opening.journalEntryId).toBeNull();

    recordLivestockEvent(db, { companyId, kind: 'birth', groupId: calves, date: '2025-03-01', headCount: 8, recordedBy: 'o' });
    recordLivestockEvent(db, { companyId, kind: 'death', groupId: herd, date: '2025-04-01', headCount: 1, reason: 'Milk fever', recordedBy: 'o' });
    expect(() => planLivestockValuation(db, { companyId, date: '2025-12-31', values: { [herd]: { valuePerHeadMinor: 100_000, basis: 'Cost' } } }))
      .toThrow(/value per head for: Calves/);
    const r = postLivestockValuation(db, {
      companyId, date: '2025-12-31', postedBy: 'o',
      values: { 'Dairy cows': { valuePerHeadMinor: 110_000, basis: 'Market value' }, Calves: { valuePerHeadMinor: 20_000, basis: 'Market value' } },
    });
    // 9 x 1,100 + 8 x 200 = 11,500; the herd moves 9,900 - 10,000 = -100, the calves +1,600.
    expect(r.plan.lines.map((l) => [l.name, l.valueMinor, l.changeMinor])).toEqual([['Calves', 160_000, 160_000], ['Dairy cows', 990_000, -10_000]]);
    expect(accountBalance(db, { companyId, accountId: byCode['1330']!, asOf: asIsoDate('2025-12-31') })).toBe(1_150_000);
    expect(() => recordLivestockEvent(db, { companyId, kind: 'birth', groupId: calves, date: '2025-12-31', headCount: 1, recordedBy: 'o' }))
      .toThrow(/valued at 2025-12-31/);
    // The change in value is the enterprise's output.
    const margin = enterpriseGrossMargins(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    expect(margin.enterprises[0]).toMatchObject({ livestockValueChangeMinor: 150_000, grossMarginMinor: 150_000 });
    expect(margin.unallocated.costOfSalesMinor).toBe(0);
  });
});

describe('crops (issue #541)', () => {
  it('a planting\'s inputs and sales come from posted lines, with yield per hectare', () => {
    const tillage = createEnterprise(db, { companyId, name: 'Tillage', kind: 'tillage', startedOn: '2020-01-01', recordedBy: 'o' });
    const field = addLandParcel(db, { companyId, reference: 'F1', name: 'Long field', areaSqm: 80_000, tenure: 'owned', heldFrom: '2010-01-01', recordedBy: 'o' });
    expect(() => createPlanting(db, { companyId, enterpriseId: tillage.id, parcelId: field.id, crop: 'Barley', harvestYear: 2025, areaSqm: 90_000, recordedBy: 'o' }))
      .toThrow(/no more than that/);
    const { planting } = createPlanting(db, {
      companyId, enterpriseId: tillage.id, parcelId: field.id, crop: 'Spring barley', variety: 'Planet', harvestYear: 2025,
      areaSqm: 80_000, sownOn: '2025-03-20', recordedBy: 'o',
    });
    const seed = post('5070', 120_000);
    const fert = post('5060', 200_000);
    const contractor = post('5010', 80_000);
    const sale = post('4000', 900_000, '2025-09-01', true);
    for (const [line, kind] of [[seed.lineId, 'seed'], [fert.lineId, 'fertiliser'], [contractor.lineId, 'contractor'], [sale.lineId, 'sales']] as const) {
      allocateJournalLine(db, { companyId, journalLineId: line, enterpriseId: tillage.id, plantingId: planting.id, inputKind: kind, basisPoints: 10_000, recordedBy: 'o' });
    }
    expect(() => allocateJournalLine(db, { companyId, journalLineId: post('5070', 1).lineId, enterpriseId: tillage.id, plantingId: planting.id, inputKind: 'sales', basisPoints: 1, recordedBy: 'o' }))
      .toThrow(/Crop sales are an income line/);
    recordHarvest(db, { companyId, plantingId: planting.id, harvestedOn: '2025-08-15', quantityMilli: 50_000, unit: 'tonnes', recordedBy: 'o' });
    const [line] = cropReport(db, { companyId, harvestYear: 2025 });
    expect(line!.inputs).toEqual({ seed: 120_000, fertiliser: 200_000, chemicals: 0, contractor: 80_000, other: 0 });
    expect([line!.inputsMinor, line!.salesMinor, line!.marginMinor, line!.marginPerHectareMinor]).toEqual([400_000, 900_000, 500_000, 62_500]);
    // 50 tonnes on 8 ha: 6.25 t/ha.
    expect(line!.harvests).toEqual([{ unit: 'tonnes', quantityMilli: 50_000, yieldPerHectareMilli: 6_250 }]);
  });
});

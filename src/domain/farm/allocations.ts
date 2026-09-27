import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, auditEvents, cropPlantings, farmAllocations, journalEntries, journalLines, livestockValuations, CROP_INPUT_KINDS,
} from '@/db/schema';
import { postedPnlLines, type PostedPnlLine } from '../accounting/postedPnl';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { multiplyRational } from '../money';
import { FarmError, listEnterprises, requireEnterprise, requireFarmDate } from './setup';

/**
 * Allocating posted lines to enterprises and crops (EPIC 24, issues #539,
 * #541), and the enterprise gross margin built on them.
 *
 * An allocation is analysis beside the ledger: a share, in basis points, of a
 * posted income or expense line. The line is never touched. A line's shares
 * never exceed 100%, and a reversal of the line takes the same shares, so a
 * reversed cost leaves the margin where it was before the cost. Whatever is
 * not allocated is reported as unallocated, never spread.
 */

export type FarmAllocation = typeof farmAllocations.$inferSelect;
export type CropInputKind = (typeof CROP_INPUT_KINDS)[number];

const FULL = 10_000;

/** A percentage to two decimals as basis points: "62.5" is 6250. */
export function parsePercent(text: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) throw new FarmError(`"${text}" is not a percentage (up to two decimal places).`);
  const [whole, frac = ''] = text.trim().split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function loadLine(db: AppDatabase, companyId: string, journalLineId: string) {
  const row = db.select({ line: journalLines, entry: journalEntries, account: accounts }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.id, journalLineId), eq(journalLines.companyId, companyId))).get();
  if (!row) throw new FarmError(`Journal line ${journalLineId} not found.`);
  return row;
}

/** Allocate a share of a posted income or expense line to an enterprise, and optionally to a crop planting. */
export function allocateJournalLine(db: AppDatabase, p: {
  companyId: string; journalLineId: string; enterpriseId: string; basisPoints: number; plantingId?: string | null;
  inputKind?: CropInputKind | null; recordedBy: string;
}): FarmAllocation {
  return db.transaction(() => {
    const { line, entry, account } = loadLine(db, p.companyId, p.journalLineId);
    if (!entry.isPosted) throw new FarmError('Only a posted line is allocated.');
    if (entry.reversalOfId) throw new FarmError('A reversing entry takes the allocation of the line it reverses: allocate the original.');
    if (entry.sourceType === 'livestock_valuation') throw new FarmError('A livestock valuation is attributed to its groups\' enterprises already.');
    if (account.type !== 'income' && account.type !== 'expense') {
      throw new FarmError(`${account.code} ${account.name} is not an income or expense account: only those are allocated.`);
    }
    if (!Number.isInteger(p.basisPoints) || p.basisPoints <= 0 || p.basisPoints > FULL) {
      throw new FarmError('The share is between 0.01% and 100% (1 to 10000 basis points).');
    }
    const enterprise = requireEnterprise(db, p.companyId, p.enterpriseId);
    if (p.plantingId) {
      const planting = db.select().from(cropPlantings)
        .where(and(eq(cropPlantings.id, p.plantingId), eq(cropPlantings.companyId, p.companyId))).get();
      if (!planting) throw new FarmError(`Crop planting ${p.plantingId} not found.`);
      if (planting.enterpriseId !== enterprise.id) throw new FarmError('That planting belongs to another enterprise.');
      if (!p.inputKind) throw new FarmError('Say what the line is to the crop: seed, fertiliser, chemicals, contractor, sales or other.');
    }
    if (p.inputKind) {
      if (!CROP_INPUT_KINDS.includes(p.inputKind)) throw new FarmError(`The kind is one of: ${CROP_INPUT_KINDS.join(', ')}.`);
      if (!p.plantingId) throw new FarmError('A crop input or sale is allocated to a planting.');
      if ((p.inputKind === 'sales') !== (account.type === 'income')) {
        throw new FarmError(p.inputKind === 'sales' ? 'Crop sales are an income line.' : 'A crop input is an expense line.');
      }
    }
    const taken = db.select({ bp: farmAllocations.basisPoints }).from(farmAllocations)
      .where(eq(farmAllocations.journalLineId, line.id)).all().reduce((s, a) => s + a.bp, 0);
    if (taken + p.basisPoints > FULL) {
      throw new FarmError(`${(taken / 100).toFixed(2)}% of the line is already allocated: ${((FULL - taken) / 100).toFixed(2)}% is left.`);
    }
    const id = ids.farmAllocation();
    db.insert(farmAllocations).values({
      id, companyId: p.companyId, journalLineId: line.id, enterpriseId: enterprise.id, plantingId: p.plantingId ?? null,
      inputKind: p.inputKind ?? null, basisPoints: p.basisPoints, recordedBy: p.recordedBy,
    }).run();
    return db.select().from(farmAllocations).where(eq(farmAllocations.id, id)).get()!;
  });
}

/** Take an allocation back. The analysis changes; the ledger never did. Audited. */
export function removeAllocation(db: AppDatabase, p: { companyId: string; allocationId: string; reason: string; actor: string }): void {
  const a = db.select().from(farmAllocations)
    .where(and(eq(farmAllocations.id, p.allocationId), eq(farmAllocations.companyId, p.companyId))).get();
  if (!a) throw new FarmError(`Allocation ${p.allocationId} not found.`);
  if (!p.reason.trim()) throw new FarmError('Give the reason the allocation is removed.');
  db.transaction(() => {
    db.delete(farmAllocations).where(eq(farmAllocations.id, a.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: p.companyId, occurredAt: nowIso(), entityType: 'farm_allocation', entityId: a.id,
      action: 'unmapped', previousValue: JSON.stringify(a), source: 'user', actor: p.actor, reason: p.reason.trim(), requestId: null,
    }).run();
  });
}

export interface AllocatedAmount {
  allocationId: string; journalLineId: string; entryDate: string; enterpriseId: string; plantingId: string | null;
  inputKind: CropInputKind | null; accountType: 'income' | 'expense'; accountSubtype: string | null; basisPoints: number;
  /** The allocated share in base currency: income positive when earned, expense positive when incurred. */
  amountMinor: number;
}

/**
 * Every allocated amount, in a date range or all time. A reversing entry's
 * line takes the allocations of the line it reverses (`postedPnlLines`), so
 * the pair nets to nothing in the analysis as in the ledger.
 */
export function allocatedAmounts(db: AppDatabase, companyId: string, range?: { from: string; to: string }): {
  amounts: AllocatedAmount[]; lines: PostedPnlLine[];
} {
  const lines = postedPnlLines(db, companyId, range);
  const all = db.select().from(farmAllocations).where(eq(farmAllocations.companyId, companyId)).all();
  const byLine = new Map<string, FarmAllocation[]>();
  for (const a of all) byLine.set(a.journalLineId, [...(byLine.get(a.journalLineId) ?? []), a]);
  const amounts: AllocatedAmount[] = [];
  for (const l of lines) {
    if (!l.allocationLineId) continue;
    for (const a of byLine.get(l.allocationLineId) ?? []) {
      amounts.push({
        allocationId: a.id, journalLineId: l.id, entryDate: l.entryDate, enterpriseId: a.enterpriseId, plantingId: a.plantingId,
        inputKind: a.inputKind, accountType: l.accountType, accountSubtype: l.accountSubtype, basisPoints: a.basisPoints,
        amountMinor: multiplyRational(l.amountMinor, a.basisPoints, FULL),
      });
    }
  }
  return { amounts, lines };
}

export interface EnterpriseMargin {
  enterpriseId: string; name: string; kind: string;
  outputMinor: number;
  livestockValueChangeMinor: number;
  variableCostsMinor: number;
  grossMarginMinor: number;
  allocatedOverheadsMinor: number;
}

export interface GrossMarginReport {
  from: string; to: string;
  enterprises: EnterpriseMargin[];
  unallocated: { incomeMinor: number; costOfSalesMinor: number; overheadsMinor: number };
}

/**
 * Enterprise gross margins for a period (issue #539): output (income
 * allocated) plus the change in livestock value posted for the enterprise's
 * groups, less allocated cost of sales. Allocated overheads are shown apart;
 * what is not allocated is reported, not spread.
 */
export function enterpriseGrossMargins(db: AppDatabase, p: { companyId: string; from: string; to: string }): GrossMarginReport {
  const from = requireFarmDate(p.from, 'The start date');
  const to = requireFarmDate(p.to, 'The end date');
  const { amounts, lines } = allocatedAmounts(db, p.companyId, { from, to });
  const change = new Map<string, number>();
  for (const v of db.select().from(livestockValuations).where(and(
    eq(livestockValuations.companyId, p.companyId), gte(livestockValuations.valuationDate, from), lte(livestockValuations.valuationDate, to),
  )).all()) {
    for (const l of v.lines) change.set(l.enterpriseId, (change.get(l.enterpriseId) ?? 0) + l.changeMinor);
  }
  const isCos = (a: { accountType: string; accountSubtype: string | null }) => a.accountType === 'expense' && a.accountSubtype === 'cost_of_sales';
  const enterprises = listEnterprises(db, p.companyId).map((e) => {
    const mine = amounts.filter((a) => a.enterpriseId === e.id);
    const outputMinor = mine.filter((a) => a.accountType === 'income').reduce((s, a) => s + a.amountMinor, 0);
    const variableCostsMinor = mine.filter(isCos).reduce((s, a) => s + a.amountMinor, 0);
    const allocatedOverheadsMinor = mine.filter((a) => a.accountType === 'expense' && !isCos(a)).reduce((s, a) => s + a.amountMinor, 0);
    const livestockValueChangeMinor = change.get(e.id) ?? 0;
    return {
      enterpriseId: e.id, name: e.name, kind: e.kind, outputMinor, livestockValueChangeMinor, variableCostsMinor,
      grossMarginMinor: outputMinor + livestockValueChangeMinor - variableCostsMinor, allocatedOverheadsMinor,
    };
  });
  const allocatedByLine = new Map<string, number>();
  for (const a of amounts) allocatedByLine.set(a.journalLineId, (allocatedByLine.get(a.journalLineId) ?? 0) + a.amountMinor);
  const unallocated = { incomeMinor: 0, costOfSalesMinor: 0, overheadsMinor: 0 };
  for (const l of lines) {
    if (l.sourceType === 'livestock_valuation') continue;
    const rest = l.amountMinor - (allocatedByLine.get(l.id) ?? 0);
    if (l.accountType === 'income') unallocated.incomeMinor += rest;
    else if (isCos(l)) unallocated.costOfSalesMinor += rest;
    else unallocated.overheadsMinor += rest;
  }
  return { from, to, enterprises, unallocated };
}

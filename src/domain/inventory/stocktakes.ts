import { and, asc, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { auditEvents, stocktakeLines, stocktakes } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { atomically } from '../accounting/journal';
import { replayItem } from './costing';
import { InventoryError, requireLocation, requireStockItem } from './items';
import { assertAfterLastValuation, costOfQuantity, insertMovement } from './movements';

/**
 * Stocktakes (EPIC 23, issue #537): a count of a location on a date, and who
 * counted it. While a draft its lines can be entered and changed; posting it
 * compares each count with the book quantity on the date and records a
 * `stocktake_in` or `stocktake_out` for each difference. A count over book is
 * valued at the unit cost the person gives on its line; a count under book
 * goes out at cost by the item's method.
 */

export type Stocktake = typeof stocktakes.$inferSelect;
export type StocktakeLine = typeof stocktakeLines.$inferSelect;

function requireDraft(db: AppDatabase, companyId: string, stocktakeId: string): Stocktake {
  const st = db.select().from(stocktakes).where(and(eq(stocktakes.id, stocktakeId), eq(stocktakes.companyId, companyId))).get();
  if (!st) throw new InventoryError(`Stocktake ${stocktakeId} not found.`);
  if (st.status !== 'draft') throw new InventoryError('That stocktake has been posted: count again to correct it.');
  return st;
}

export function createStocktake(db: AppDatabase, p: { companyId: string; locationId: string; countDate: string; countedBy: string }): Stocktake {
  const location = requireLocation(db, p.companyId, p.locationId);
  if (!isIsoDate(p.countDate)) throw new InventoryError('The count date is a YYYY-MM-DD date.');
  if (!p.countedBy.trim()) throw new InventoryError('Record who counted the stock.');
  const id = ids.stocktake();
  db.insert(stocktakes).values({
    id, companyId: p.companyId, locationId: location.id, countDate: asIsoDate(p.countDate), countedBy: p.countedBy.trim(),
  }).run();
  return db.select().from(stocktakes).where(eq(stocktakes.id, id)).get()!;
}

/** Enter or change the count of one item on a draft stocktake. */
export function setStocktakeCount(db: AppDatabase, p: {
  companyId: string; stocktakeId: string; itemId: string; countedQuantityMilli: number; unitCostMinor?: number | null;
}): StocktakeLine {
  const st = requireDraft(db, p.companyId, p.stocktakeId);
  const item = requireStockItem(db, p.companyId, p.itemId);
  if (!Number.isInteger(p.countedQuantityMilli) || p.countedQuantityMilli < 0) {
    throw new InventoryError('The count is nil or more, in thousandths of the unit.');
  }
  if (p.unitCostMinor !== undefined && p.unitCostMinor !== null && (!Number.isInteger(p.unitCostMinor) || p.unitCostMinor < 0)) {
    throw new InventoryError('The unit cost is a whole number of minor units, nil or more.');
  }
  const existing = db.select().from(stocktakeLines)
    .where(and(eq(stocktakeLines.stocktakeId, st.id), eq(stocktakeLines.itemId, item.id))).get();
  if (existing) {
    db.update(stocktakeLines).set({
      countedQuantityMilli: p.countedQuantityMilli, unitCostMinor: p.unitCostMinor ?? null, updatedAt: nowIso(),
    }).where(eq(stocktakeLines.id, existing.id)).run();
    return db.select().from(stocktakeLines).where(eq(stocktakeLines.id, existing.id)).get()!;
  }
  const id = ids.stocktakeLine();
  db.insert(stocktakeLines).values({
    id, stocktakeId: st.id, itemId: item.id, countedQuantityMilli: p.countedQuantityMilli, unitCostMinor: p.unitCostMinor ?? null,
  }).run();
  return db.select().from(stocktakeLines).where(eq(stocktakeLines.id, id)).get()!;
}

export interface PostedStocktakeLine { itemId: string; code: string; bookQuantityMilli: number; countedQuantityMilli: number; movementId: string | null }

/** Post a stocktake: one movement per difference, the book quantities snapshotted, all or nothing. */
export function postStocktake(db: AppDatabase, p: { companyId: string; stocktakeId: string; postedBy: string }): PostedStocktakeLine[] {
  return atomically(db, () => {
    const st = requireDraft(db, p.companyId, p.stocktakeId);
    assertAfterLastValuation(db, p.companyId, st.countDate);
    const lines = db.select().from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, st.id)).all();
    if (lines.length === 0) throw new InventoryError('Enter at least one count before posting the stocktake.');
    const result: PostedStocktakeLine[] = [];
    const counted = lines.map((line) => ({ line, item: requireStockItem(db, p.companyId, line.itemId) }))
      .sort((a, b) => a.item.code.localeCompare(b.item.code));
    for (const { line, item } of counted) {
      const book = replayItem(db, { companyId: p.companyId, itemId: item.id, asOf: st.countDate }).positions.get(st.locationId)?.quantityMilli ?? 0;
      const difference = line.countedQuantityMilli - book;
      let movementId: string | null = null;
      if (difference > 0) {
        if (line.unitCostMinor === null) {
          throw new InventoryError(`${item.code}: the count is ${difference / 1000} ${item.unit} over book. Give the unit cost the extra `
            + 'stock is valued at.');
        }
        movementId = insertMovement(db, {
          companyId: p.companyId, item, locationId: st.locationId, movementDate: st.countDate, kind: 'stocktake_in',
          quantityMilli: difference, unitCostMinor: line.unitCostMinor, costMinor: costOfQuantity(line.unitCostMinor, difference),
          stocktakeId: st.id, reason: `Stocktake counted by ${st.countedBy}`, recordedBy: p.postedBy,
        });
      } else if (difference < 0) {
        movementId = insertMovement(db, {
          companyId: p.companyId, item, locationId: st.locationId, movementDate: st.countDate, kind: 'stocktake_out',
          quantityMilli: difference, stocktakeId: st.id, reason: `Stocktake counted by ${st.countedBy}`, recordedBy: p.postedBy,
        });
      }
      if (movementId) replayItem(db, { companyId: p.companyId, itemId: item.id });
      db.update(stocktakeLines).set({ bookQuantityMilli: book, updatedAt: nowIso() }).where(eq(stocktakeLines.id, line.id)).run();
      result.push({ itemId: item.id, code: item.code, bookQuantityMilli: book, countedQuantityMilli: line.countedQuantityMilli, movementId });
    }
    const postedAt = nowIso();
    db.update(stocktakes).set({ status: 'posted', postedBy: p.postedBy, postedAt, updatedAt: postedAt }).where(eq(stocktakes.id, st.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: p.companyId, occurredAt: postedAt, entityType: 'stocktake', entityId: st.id,
      action: 'adjustment_posted', newValue: JSON.stringify(result), source: 'user', actor: p.postedBy,
      reason: `Stocktake of ${st.countDate} counted by ${st.countedBy}`, requestId: null,
    }).run();
    return result;
  });
}

export function listStocktakes(db: AppDatabase, companyId: string): Array<Stocktake & { lines: StocktakeLine[] }> {
  return db.select().from(stocktakes).where(eq(stocktakes.companyId, companyId)).orderBy(desc(stocktakes.countDate)).all()
    .map((st) => ({
      ...st,
      lines: db.select().from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, st.id)).orderBy(asc(stocktakeLines.createdAt)).all(),
    }));
}

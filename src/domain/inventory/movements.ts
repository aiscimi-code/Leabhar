import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { auditEvents, invoiceLines, invoices, stockMovements, stockValuations, type StockMovementKind } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { atomically } from '../accounting/journal';
import { replayItem, type StockMovement } from './costing';
import { InventoryError, requireLocation, requireStockItem, type Item } from './items';

/**
 * Recording stock movements (EPIC 23, issue #537). Every movement is a new,
 * immutable row; a mistake is corrected by `reverseStockMovement`. Each path
 * inserts its movement and then replays the item (`costing.ts`) inside the
 * same transaction: a movement that would take a location below nil on any
 * date, or return goods that were never there, is refused and nothing is
 * written.
 *
 * Quantities are thousandths of the item's unit, like invoice lines. Money is
 * integer minor units in the base currency.
 */

function requireDate(value: string, what: string): string {
  if (!isIsoDate(value)) throw new InventoryError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

function requirePositiveQuantity(quantityMilli: number): number {
  if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
    throw new InventoryError('The quantity is a positive number of thousandths of the unit (1 each = 1000).');
  }
  return quantityMilli;
}

/**
 * Stock at or before a posted closing stock valuation is in the ledger: a
 * movement dated then would make that valuation wrong without changing it.
 */
export function assertAfterLastValuation(db: AppDatabase, companyId: string, date: string) {
  const last = db.select({ d: stockValuations.valuationDate }).from(stockValuations)
    .where(eq(stockValuations.companyId, companyId)).orderBy(desc(stockValuations.valuationDate)).get();
  if (last && date <= last.d) {
    throw new InventoryError(`Closing stock has been posted at ${last.d}: record the movement after that date.`);
  }
}

interface NewMovement {
  companyId: string; item: Item; locationId: string; movementDate: string; kind: StockMovementKind;
  quantityMilli: number; unitCostMinor?: number | null; costMinor?: number | null; relatedMovementId?: string | null;
  transferPairId?: string | null; invoiceId?: string | null; invoiceLineId?: string | null; stocktakeId?: string | null;
  reason?: string | null; recordedBy: string; id?: string;
}

function nextSequence(db: AppDatabase, companyId: string): number {
  return db.select({ n: sql<number>`coalesce(max(${stockMovements.sequence}), 0)` }).from(stockMovements)
    .where(eq(stockMovements.companyId, companyId)).get()!.n + 1;
}

/** Insert one movement row. Callers run inside `atomically` and replay the item afterwards. */
export function insertMovement(db: AppDatabase, m: NewMovement): string {
  const id = m.id ?? ids.stockMovement();
  db.insert(stockMovements).values({
    id, companyId: m.companyId, itemId: m.item.id, locationId: m.locationId, movementDate: m.movementDate,
    sequence: nextSequence(db, m.companyId), kind: m.kind, quantityMilli: m.quantityMilli,
    unitCostMinor: m.unitCostMinor ?? null, costMinor: m.costMinor ?? null, relatedMovementId: m.relatedMovementId ?? null,
    transferPairId: m.transferPairId ?? null, invoiceId: m.invoiceId ?? null, invoiceLineId: m.invoiceLineId ?? null,
    stocktakeId: m.stocktakeId ?? null, reason: m.reason?.trim() || null, recordedBy: m.recordedBy,
  }).run();
  return id;
}

/** The cost of a quantity at a unit cost per whole unit: unit cost × thousandths / 1000. */
export function costOfQuantity(unitCostMinor: number, quantityMilli: number): number {
  return multiplyRational(asMinor(unitCostMinor), quantityMilli, 1000);
}

function requireUnitCost(unitCostMinor: number | undefined | null): number {
  if (unitCostMinor === undefined || unitCostMinor === null || !Number.isInteger(unitCostMinor) || unitCostMinor < 0) {
    throw new InventoryError('Give the unit cost in minor units (cent), a whole number, nil or more.');
  }
  return unitCostMinor;
}

function load(db: AppDatabase, id: string): StockMovement {
  return db.select().from(stockMovements).where(eq(stockMovements.id, id)).get()!;
}

/** Validate by replay: a refusal here rolls the whole transaction back. */
function settle(db: AppDatabase, companyId: string, itemId: string) {
  replayItem(db, { companyId, itemId });
}

interface Common { companyId: string; itemId: string; locationId: string; date: string; recordedBy: string }

function begin(db: AppDatabase, p: Common) {
  const item = requireStockItem(db, p.companyId, p.itemId);
  const location = requireLocation(db, p.companyId, p.locationId);
  const date = requireDate(p.date, 'The movement date');
  assertAfterLastValuation(db, p.companyId, date);
  return { item, location, date };
}

/**
 * Opening stock at the book's start (issue #537): the quantity and unit cost
 * held on the date. The ledger's opening balance on Stock on hand is what the
 * opening movements agree to; the first closing stock checks it.
 */
export function recordOpeningStock(db: AppDatabase, p: Common & { quantityMilli: number; unitCostMinor: number }): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    const q = requirePositiveQuantity(p.quantityMilli);
    const unit = requireUnitCost(p.unitCostMinor);
    const earlier = db.select({ id: stockMovements.id }).from(stockMovements)
      .where(and(eq(stockMovements.itemId, item.id), eq(stockMovements.locationId, location.id), sql`${stockMovements.movementDate} < ${date}`)).get();
    if (earlier) throw new InventoryError(`${item.code} already has movements at ${location.code} before ${date}: opening stock comes first.`);
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'opening', quantityMilli: q,
      unitCostMinor: unit, costMinor: costOfQuantity(unit, q), reason: 'Opening stock', recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

function invoiceLineFor(db: AppDatabase, companyId: string, invoiceLineId: string, direction: 'sales' | 'purchase') {
  const line = db.select().from(invoiceLines).where(and(eq(invoiceLines.id, invoiceLineId), eq(invoiceLines.companyId, companyId))).get();
  if (!line) throw new InventoryError(`Invoice line ${invoiceLineId} not found.`);
  const invoice = db.select().from(invoices).where(eq(invoices.id, line.invoiceId)).get()!;
  if (invoice.direction !== direction) {
    throw new InventoryError(`That line is on a ${invoice.direction} invoice: stock ${direction === 'purchase' ? 'received' : 'sold'} `
      + `comes from a ${direction} invoice.`);
  }
  if (invoice.status === 'draft' || invoice.status === 'void') {
    throw new InventoryError(`Invoice ${invoice.invoiceNumber ?? invoice.id} is ${invoice.status}: only a posted invoice moves stock.`);
  }
  if (invoice.isCreditNote) {
    throw new InventoryError(`${invoice.invoiceNumber ?? invoice.id} is a credit note: record a ${direction === 'purchase' ? 'supplier' : 'customer'} `
      + 'return against the movement it reverses.');
  }
  return { line, invoice };
}

/** What has already moved against an invoice line, in thousandths, less what was reversed. */
function movedAgainstLine(db: AppDatabase, invoiceLineId: string, kinds: StockMovementKind[]): number {
  const moved = db.select().from(stockMovements)
    .where(and(eq(stockMovements.invoiceLineId, invoiceLineId), inArray(stockMovements.kind, kinds))).all();
  if (moved.length === 0) return 0;
  const reversed = new Set(db.select({ r: stockMovements.relatedMovementId }).from(stockMovements)
    .where(and(inArray(stockMovements.relatedMovementId, moved.map((m) => m.id)), eq(stockMovements.kind, 'reversal'))).all()
    .map((x) => x.r));
  return moved.filter((m) => !reversed.has(m.id)).reduce((s, m) => s + Math.abs(m.quantityMilli), 0);
}

/**
 * Receive stock against a purchase invoice line (issue #537), at the line's
 * own net cost in the base currency. A part delivery takes its share of the
 * line; the deliveries against one line together take its whole net exactly.
 */
export function receivePurchase(db: AppDatabase, p: Common & { invoiceLineId: string; quantityMilli?: number }): {
  movement: StockMovement; warnings: string[];
} {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    const { line, invoice } = invoiceLineFor(db, p.companyId, p.invoiceLineId, 'purchase');
    if (date < invoice.invoiceDate) throw new InventoryError('Goods are received on or after the invoice date they are billed on.');
    const lineQuantity = line.quantityMilli;
    if (lineQuantity <= 0) throw new InventoryError('That invoice line has no quantity to receive.');
    const already = movedAgainstLine(db, line.id, ['purchase']);
    const q = requirePositiveQuantity(p.quantityMilli ?? lineQuantity - already);
    if (already + q > lineQuantity) {
      throw new InventoryError(`The line is for ${lineQuantity / 1000} and ${already / 1000} has been received: `
        + `${(lineQuantity - already) / 1000} is left to receive.`);
    }
    const baseNet = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? multiplyRational(asMinor(line.netMinor), invoice.fxRateNumerator, invoice.fxRateDenominator)
      : line.netMinor;
    // Cumulative, so the deliveries together cost the line's net exactly.
    const costBefore = already === 0 ? 0 : multiplyRational(asMinor(baseNet), already, lineQuantity);
    const cost = multiplyRational(asMinor(baseNet), already + q, lineQuantity) - costBefore;
    const warnings: string[] = [];
    if (line.accountId && line.accountId !== item.costOfSalesAccountId) {
      warnings.push(`The invoice line was posted to a different account from ${item.code}'s cost of sales: the closing stock `
        + 'journal credits the item\'s cost-of-sales account, so the purchase and the stock will sit in different accounts.');
    }
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'purchase', quantityMilli: q,
      unitCostMinor: multiplyRational(asMinor(cost), 1000, q), costMinor: cost, invoiceId: invoice.id, invoiceLineId: line.id,
      recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return { movement: load(db, id), warnings };
  });
}

/** Issue stock against a sales invoice line (issue #537). Its cost is the item's method at replay. */
export function issueSale(db: AppDatabase, p: Common & { invoiceLineId: string; quantityMilli?: number }): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    const { line, invoice } = invoiceLineFor(db, p.companyId, p.invoiceLineId, 'sales');
    if (line.quantityMilli <= 0) throw new InventoryError('That invoice line has no quantity to issue.');
    const already = movedAgainstLine(db, line.id, ['sale']);
    const q = requirePositiveQuantity(p.quantityMilli ?? line.quantityMilli - already);
    if (already + q > line.quantityMilli) {
      throw new InventoryError(`The line is for ${line.quantityMilli / 1000} and ${already / 1000} has been issued.`);
    }
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'sale', quantityMilli: -q,
      invoiceId: invoice.id, invoiceLineId: line.id, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

function requireRelated(db: AppDatabase, companyId: string, movementId: string, kind: StockMovementKind, item: Item) {
  const m = db.select().from(stockMovements).where(and(eq(stockMovements.id, movementId), eq(stockMovements.companyId, companyId))).get();
  if (!m) throw new InventoryError(`Stock movement ${movementId} not found.`);
  if (m.kind !== kind) throw new InventoryError(`Movement ${movementId} is a ${m.kind}, not a ${kind}.`);
  if (m.itemId !== item.id) throw new InventoryError(`Movement ${movementId} is of another item.`);
  return m;
}

/** Goods a customer brought back (issue #537): in at the cost their sale left at. */
export function recordCustomerReturn(db: AppDatabase, p: Common & {
  saleMovementId: string; quantityMilli: number; reason: string; invoiceLineId?: string | null;
}): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    const sale = requireRelated(db, p.companyId, p.saleMovementId, 'sale', item);
    if (date < sale.movementDate) throw new InventoryError('A return comes after the sale it returns.');
    if (!p.reason.trim()) throw new InventoryError('Give the reason for the return.');
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'customer_return',
      quantityMilli: requirePositiveQuantity(p.quantityMilli), relatedMovementId: sale.id, invoiceLineId: p.invoiceLineId ?? null,
      reason: p.reason, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

/** Goods sent back to the supplier (issue #537): out at the cost they came in at. */
export function recordSupplierReturn(db: AppDatabase, p: Common & {
  purchaseMovementId: string; quantityMilli: number; reason: string; invoiceLineId?: string | null;
}): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    const purchase = requireRelated(db, p.companyId, p.purchaseMovementId, 'purchase', item);
    if (date < purchase.movementDate) throw new InventoryError('A return comes after the receipt it returns.');
    if (!p.reason.trim()) throw new InventoryError('Give the reason for the return.');
    const returned = db.select({ n: sql<number>`coalesce(sum(-${stockMovements.quantityMilli}), 0)` }).from(stockMovements)
      .where(and(eq(stockMovements.relatedMovementId, purchase.id), eq(stockMovements.kind, 'supplier_return'))).get()!.n;
    const q = requirePositiveQuantity(p.quantityMilli);
    if (returned + q > purchase.quantityMilli) {
      throw new InventoryError(`${purchase.quantityMilli / 1000} came in on that receipt and ${returned / 1000} has gone back.`);
    }
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'supplier_return', quantityMilli: -q,
      relatedMovementId: purchase.id, invoiceLineId: p.invoiceLineId ?? null, reason: p.reason, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

/** Damaged, lost or stolen stock written off at cost, with its reason (issue #537). */
export function recordDamagedStock(db: AppDatabase, p: Common & { quantityMilli: number; reason: string }): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    if (!p.reason.trim()) throw new InventoryError('Give the reason the stock is written off.');
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'damaged',
      quantityMilli: -requirePositiveQuantity(p.quantityMilli), reason: p.reason, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

/**
 * A stock adjustment with its reason (issue #537): up, at a unit cost the
 * person gives; or down, at cost by the item's method.
 */
export function recordStockAdjustment(db: AppDatabase, p: Common & {
  direction: 'in' | 'out'; quantityMilli: number; unitCostMinor?: number | null; reason: string;
}): StockMovement {
  return atomically(db, () => {
    const { item, location, date } = begin(db, p);
    if (!p.reason.trim()) throw new InventoryError('Give the reason for the adjustment.');
    const q = requirePositiveQuantity(p.quantityMilli);
    let id: string;
    if (p.direction === 'in') {
      const unit = requireUnitCost(p.unitCostMinor);
      id = insertMovement(db, {
        companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'adjustment_in', quantityMilli: q,
        unitCostMinor: unit, costMinor: costOfQuantity(unit, q), reason: p.reason, recordedBy: p.recordedBy,
      });
    } else {
      id = insertMovement(db, {
        companyId: p.companyId, item, locationId: location.id, movementDate: date, kind: 'adjustment_out', quantityMilli: -q,
        reason: p.reason, recordedBy: p.recordedBy,
      });
    }
    settle(db, p.companyId, item.id);
    return load(db, id);
  });
}

/** Move stock between locations (issue #537). The cost moves with it; nothing is gained or lost. */
export function transferStock(db: AppDatabase, p: Omit<Common, 'locationId'> & {
  fromLocationId: string; toLocationId: string; quantityMilli: number; reason?: string | null;
}): { out: StockMovement; in: StockMovement } {
  return atomically(db, () => {
    const { item, location: from, date } = begin(db, { ...p, locationId: p.fromLocationId });
    const to = requireLocation(db, p.companyId, p.toLocationId);
    if (to.id === from.id) throw new InventoryError('A transfer moves stock to a different location.');
    const q = requirePositiveQuantity(p.quantityMilli);
    const outId = ids.stockMovement();
    const inId = ids.stockMovement();
    insertMovement(db, {
      id: outId, companyId: p.companyId, item, locationId: from.id, movementDate: date, kind: 'transfer_out', quantityMilli: -q,
      transferPairId: inId, reason: p.reason ?? `To ${to.code}`, recordedBy: p.recordedBy,
    });
    insertMovement(db, {
      id: inId, companyId: p.companyId, item, locationId: to.id, movementDate: date, kind: 'transfer_in', quantityMilli: q,
      transferPairId: outId, reason: p.reason ?? `From ${from.code}`, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    return { out: load(db, outId), in: load(db, inId) };
  });
}

/**
 * Correct a mistaken movement by reversing it (issue #537): the same quantity
 * the other way, at the movement's own cost. The original stays on file.
 * A transfer is corrected by a transfer back; a stocktake by the next count.
 */
export function reverseStockMovement(db: AppDatabase, p: {
  companyId: string; movementId: string; date: string; reason: string; recordedBy: string;
}): StockMovement {
  return atomically(db, () => {
    const original = db.select().from(stockMovements)
      .where(and(eq(stockMovements.id, p.movementId), eq(stockMovements.companyId, p.companyId))).get();
    if (!original) throw new InventoryError(`Stock movement ${p.movementId} not found.`);
    if (original.kind === 'reversal') throw new InventoryError('A reversal is not reversed: record the movement again.');
    if (original.kind === 'transfer_in' || original.kind === 'transfer_out') {
      throw new InventoryError('A transfer is corrected by a transfer back.');
    }
    const already = db.select({ id: stockMovements.id }).from(stockMovements)
      .where(and(eq(stockMovements.relatedMovementId, original.id), eq(stockMovements.kind, 'reversal'))).get();
    if (already) throw new InventoryError(`Movement ${original.id} has already been reversed.`);
    const dependants = db.select({ id: stockMovements.id }).from(stockMovements)
      .where(and(eq(stockMovements.relatedMovementId, original.id), sql`${stockMovements.kind} <> 'reversal'`)).get();
    if (dependants) throw new InventoryError(`Returns have been recorded against movement ${original.id}: reverse them first.`);
    if (!p.reason.trim()) throw new InventoryError('Give the reason for the reversal.');
    const { item, date } = begin(db, { ...p, itemId: original.itemId, locationId: original.locationId });
    if (date < original.movementDate) throw new InventoryError('A reversal is dated on or after the movement it reverses.');
    const id = insertMovement(db, {
      companyId: p.companyId, item, locationId: original.locationId, movementDate: date, kind: 'reversal',
      quantityMilli: -original.quantityMilli, relatedMovementId: original.id, reason: p.reason, recordedBy: p.recordedBy,
    });
    settle(db, p.companyId, item.id);
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: p.companyId, occurredAt: nowIso(), entityType: 'stock_movement', entityId: original.id,
      action: 'reversal_posted', previousValue: JSON.stringify({ kind: original.kind, quantityMilli: original.quantityMilli }),
      newValue: JSON.stringify({ reversalId: id, date }), source: 'user', actor: p.recordedBy, reason: p.reason.trim(), requestId: null,
    }).run();
    return load(db, id);
  });
}

export function listMovements(db: AppDatabase, companyId: string, filter: { itemId?: string; locationId?: string } = {}): StockMovement[] {
  const where = [eq(stockMovements.companyId, companyId)];
  if (filter.itemId) where.push(eq(stockMovements.itemId, filter.itemId));
  if (filter.locationId) where.push(eq(stockMovements.locationId, filter.locationId));
  return db.select().from(stockMovements).where(and(...where))
    .orderBy(desc(stockMovements.movementDate), desc(stockMovements.sequence)).all();
}

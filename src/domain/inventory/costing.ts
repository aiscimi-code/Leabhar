import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { stockLocations, stockMovements } from '@/db/schema';
import { multiplyRational } from '../money';
import { InventoryError, requireItem, type Item } from './items';

/**
 * Costing by replay (EPIC 23, issue #538). An item's movements are replayed
 * in date order, then recording order, through one cost pool per location:
 *
 * - FIFO: every receipt is a layer; an issue consumes the oldest layers.
 * - Weighted average: one pool; an issue takes the moving average, and the
 *   last unit out takes the pool's remaining value exactly.
 *
 * A receipt carries its own cost. An issue is costed by the method. A
 * customer return comes back at the cost its sale left at; a supplier return
 * goes out at the cost its receipt came in at; a reversal undoes its movement
 * at the movement's cost; a transfer carries its cost to the other location.
 * Nothing about an issue's cost is stored, so a back-dated movement re-costs
 * everything after it and cannot leave a stale figure.
 *
 * The replay is also the check: it refuses a location going below nil on any
 * date (an issue that would take stock negative there, or later).
 */

export type StockMovement = typeof stockMovements.$inferSelect;

interface Layer { movementId: string; quantityMilli: number; valueMinor: number }
interface Pool { quantityMilli: number; valueMinor: number; layers: Layer[] }

/** What a movement did to its location's value: positive in, negative out. */
export interface CostedMovement extends StockMovement { valueMinor: number }

export interface ItemReplay {
  item: Item;
  movements: CostedMovement[];
  /** Quantity and value by location at the end of the replay. */
  positions: Map<string, { quantityMilli: number; valueMinor: number }>;
}

const OWN_COST_IN = new Set(['opening', 'purchase', 'adjustment_in', 'stocktake_in']);

/** `a × n / d` in minor units, exact for the whole (n = d). */
function share(valueMinor: number, n: number, d: number): number {
  return n === d ? valueMinor : multiplyRational(valueMinor, n, d);
}

function takeFromPool(pool: Pool, method: Item['costingMethod'], quantityMilli: number): Layer[] {
  if (method === 'weighted_average') {
    const value = share(pool.valueMinor, quantityMilli, pool.quantityMilli);
    pool.quantityMilli -= quantityMilli;
    pool.valueMinor -= value;
    return [{ movementId: '', quantityMilli, valueMinor: value }];
  }
  const taken: Layer[] = [];
  let left = quantityMilli;
  while (left > 0) {
    const layer = pool.layers[0]!;
    const q = Math.min(left, layer.quantityMilli);
    const v = share(layer.valueMinor, q, layer.quantityMilli);
    taken.push({ movementId: layer.movementId, quantityMilli: q, valueMinor: v });
    layer.quantityMilli -= q;
    layer.valueMinor -= v;
    if (layer.quantityMilli === 0) pool.layers.shift();
    left -= q;
  }
  pool.quantityMilli -= quantityMilli;
  pool.valueMinor -= taken.reduce((s, l) => s + l.valueMinor, 0);
  return taken;
}

function addToPool(pool: Pool, layers: Layer[]) {
  for (const l of layers) {
    pool.quantityMilli += l.quantityMilli;
    pool.valueMinor += l.valueMinor;
    if (l.quantityMilli > 0) pool.layers.push({ ...l });
  }
}

/**
 * Take out the goods a receipt brought in, at the cost they came in at (a
 * supplier return, or a reversal of the receipt). FIFO takes them from that
 * receipt's own layer; under weighted average the pool loses their cost.
 */
function takeReceiptBack(
  pool: Pool, method: Item['costingMethod'], receipt: CostedMovement, quantityMilli: number, what: string,
): number {
  const cost = share(receipt.valueMinor, quantityMilli, receipt.quantityMilli);
  if (method === 'weighted_average') {
    const value = quantityMilli === pool.quantityMilli ? pool.valueMinor : cost;
    if (value > pool.valueMinor) {
      throw new InventoryError(`${what} would take out more value than the stock holds: record an adjustment out instead.`);
    }
    pool.quantityMilli -= quantityMilli;
    pool.valueMinor -= value;
    return value;
  }
  const layer = pool.layers.find((l) => l.movementId === receipt.id);
  if (!layer || layer.quantityMilli < quantityMilli) {
    throw new InventoryError(`${what}: the goods from that receipt have already been issued at this location, so they cannot `
      + 'go back at their own cost. Record an adjustment out instead.');
  }
  const value = share(layer.valueMinor, quantityMilli, layer.quantityMilli);
  layer.quantityMilli -= quantityMilli;
  layer.valueMinor -= value;
  if (layer.quantityMilli === 0) pool.layers.splice(pool.layers.indexOf(layer), 1);
  pool.quantityMilli -= quantityMilli;
  pool.valueMinor -= value;
  return value;
}

const qty = (m: number) => (m / 1000).toString();

/** Replay one item's movements up to a date (all of them when `asOf` is omitted). */
export function replayItem(db: AppDatabase, params: { companyId: string; itemId: string; asOf?: string }): ItemReplay {
  const item = requireItem(db, params.companyId, params.itemId);
  const where = [eq(stockMovements.companyId, params.companyId), eq(stockMovements.itemId, item.id)];
  if (params.asOf) where.push(lte(stockMovements.movementDate, params.asOf));
  const rows = db.select().from(stockMovements).where(and(...where))
    .orderBy(asc(stockMovements.movementDate), asc(stockMovements.sequence)).all();
  const codes = new Map(db.select({ id: stockLocations.id, code: stockLocations.code }).from(stockLocations)
    .where(eq(stockLocations.companyId, params.companyId)).all().map((l) => [l.id, l.code]));

  const pools = new Map<string, Pool>();
  const pool = (locationId: string) => {
    let p = pools.get(locationId);
    if (!p) pools.set(locationId, (p = { quantityMilli: 0, valueMinor: 0, layers: [] }));
    return p;
  };
  const costed = new Map<string, CostedMovement>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Returns against an issue so far, so the last return takes the issue's remaining cost exactly.
  const returned = new Map<string, { quantityMilli: number; valueMinor: number }>();
  const out: CostedMovement[] = [];
  const record = (m: StockMovement, valueMinor: number) => {
    const c = { ...m, valueMinor };
    costed.set(m.id, c);
    out.push(c);
  };

  for (const m of rows) {
    if (costed.has(m.id)) continue; // a transfer_in, applied with its transfer_out
    const p = pool(m.locationId);
    const where = `${item.code} at ${codes.get(m.locationId) ?? m.locationId} on ${m.movementDate}`;
    const related = m.relatedMovementId ? costed.get(m.relatedMovementId) : undefined;
    if (m.relatedMovementId && !related) {
      throw new InventoryError(`${where}: movement ${m.relatedMovementId} it refers to is not earlier in the item's history.`);
    }
    if (m.quantityMilli > 0) {
      if (OWN_COST_IN.has(m.kind)) {
        addToPool(p, [{ movementId: m.id, quantityMilli: m.quantityMilli, valueMinor: m.costMinor ?? 0 }]);
        record(m, m.costMinor ?? 0);
      } else if ((m.kind === 'customer_return' || m.kind === 'reversal') && related && related.quantityMilli < 0) {
        const issued = -related.quantityMilli;
        const issuedValue = -related.valueMinor;
        const before = returned.get(related.id) ?? { quantityMilli: 0, valueMinor: 0 };
        const total = before.quantityMilli + m.quantityMilli;
        if (total > issued) throw new InventoryError(`${where}: more has come back than movement ${related.id} took out.`);
        const value = share(issuedValue, total, issued) - before.valueMinor;
        returned.set(related.id, { quantityMilli: total, valueMinor: before.valueMinor + value });
        addToPool(p, [{ movementId: m.id, quantityMilli: m.quantityMilli, valueMinor: value }]);
        record(m, value);
      } else if (m.kind === 'transfer_in') {
        throw new InventoryError(`${where}: a transfer in without its transfer out.`);
      } else {
        throw new InventoryError(`${where}: a ${m.kind} movement cannot bring stock in.`);
      }
    } else {
      const quantity = -m.quantityMilli;
      if (quantity > p.quantityMilli) {
        throw new InventoryError(`${where}: taking out ${qty(quantity)} ${item.unit} would leave ${qty(p.quantityMilli - quantity)}. `
          + 'Stock cannot go below nil at a location on any date.');
      }
      if ((m.kind === 'supplier_return' || m.kind === 'reversal') && related && related.quantityMilli > 0) {
        const value = takeReceiptBack(p, item.costingMethod, related, quantity, where);
        record(m, -value);
      } else if (m.kind === 'reversal') {
        throw new InventoryError(`${where}: a reversal names the movement it reverses.`);
      } else {
        const taken = takeFromPool(p, item.costingMethod, quantity);
        const value = taken.reduce((s, l) => s + l.valueMinor, 0);
        record(m, -value);
        if (m.kind === 'transfer_out') {
          const pair = m.transferPairId ? byId.get(m.transferPairId) : undefined;
          if (!pair || pair.quantityMilli !== quantity || pair.movementDate !== m.movementDate) {
            throw new InventoryError(`${where}: a transfer out without its matching transfer in.`);
          }
          // FIFO layers keep the receipt they came from, so a later supplier return can still find them.
          addToPool(pool(pair.locationId), item.costingMethod === 'fifo'
            ? taken
            : [{ movementId: pair.id, quantityMilli: quantity, valueMinor: value }]);
          record(pair, value);
        }
      }
    }
  }
  const positions = new Map<string, { quantityMilli: number; valueMinor: number }>();
  for (const [locationId, p] of pools) positions.set(locationId, { quantityMilli: p.quantityMilli, valueMinor: p.valueMinor });
  return { item, movements: out, positions };
}

/** Quantity of an item at a location on a date. */
export function quantityOnHand(db: AppDatabase, params: { companyId: string; itemId: string; locationId: string; asOf: string }): number {
  return replayItem(db, params).positions.get(params.locationId)?.quantityMilli ?? 0;
}

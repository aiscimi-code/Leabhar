import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, items, stockLocations, stockMovements, COSTING_METHODS, ITEM_KINDS } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';

/**
 * The item catalogue and stock locations (EPIC 23, issue #536). A `stock`
 * item is counted and valued; a `non_stock` product or a `service` is on the
 * catalogue so invoices can name it, and has no movements.
 */

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

export type Item = typeof items.$inferSelect;
export type StockLocation = typeof stockLocations.$inferSelect;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type CostingMethod = (typeof COSTING_METHODS)[number];

/** A quantity typed in the item's unit ("1.5"), as thousandths. */
export function parseQuantity(text: string): number {
  if (!/^\d+(\.\d{1,3})?$/.test(text.trim())) throw new InventoryError(`"${text}" is not a quantity (up to three decimal places).`);
  const [whole, frac = ''] = text.trim().split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

function accountOfCompany(db: AppDatabase, companyId: string, accountId: string) {
  const account = db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId))).get();
  if (!account) throw new InventoryError(`Account ${accountId} not found in this company.`);
  return account;
}

/** Goods for resale (5020): where purchases of stock sit until the closing stock journal moves them. */
export function defaultCostOfSalesAccountId(db: AppDatabase, companyId: string): string {
  const row = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, '5020'))).get();
  if (!row) throw new InventoryError('This book has no 5020 Goods for resale account: name the cost-of-sales account for the item.');
  return row.id;
}

/** Stock on hand (1300). */
export function defaultStockAccountId(db: AppDatabase, companyId: string): string {
  const row = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.systemKey, 'stock_on_hand'))).get();
  if (!row) throw new InventoryError('This book has no Stock on hand account (1300): name the stock account for the item.');
  return row.id;
}

function checkAccounts(db: AppDatabase, companyId: string, costOfSalesAccountId: string, stockAccountId: string) {
  const cos = accountOfCompany(db, companyId, costOfSalesAccountId);
  if (cos.type !== 'expense') throw new InventoryError(`${cos.code} ${cos.name} is not an expense account: a cost of sales is.`);
  const stock = accountOfCompany(db, companyId, stockAccountId);
  if (stock.type !== 'asset' || stock.subtype !== 'current_asset') {
    throw new InventoryError(`${stock.code} ${stock.name} is not a current asset account: stock on hand is.`);
  }
}

export interface CreateItemInput {
  companyId: string;
  code: string;
  name: string;
  kind: ItemKind;
  unit: string;
  costingMethod?: CostingMethod;
  costOfSalesAccountId?: string | null;
  stockAccountId?: string | null;
  notes?: string | null;
  recordedBy: string;
}

export function createItem(db: AppDatabase, input: CreateItemInput): Item {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new InventoryError('Give the item a code.');
  if (!name) throw new InventoryError('Give the item a name.');
  if (!ITEM_KINDS.includes(input.kind)) throw new InventoryError(`An item is one of: ${ITEM_KINDS.join(', ')}.`);
  if (!input.unit.trim()) throw new InventoryError('Give the unit the item is counted in (each, kg, litre).');
  const method = input.costingMethod ?? 'fifo';
  if (!COSTING_METHODS.includes(method)) throw new InventoryError(`The costing method is one of: ${COSTING_METHODS.join(', ')}.`);
  const clash = db.select({ id: items.id }).from(items).where(and(eq(items.companyId, input.companyId), eq(items.code, code))).get();
  if (clash) throw new InventoryError(`Item code ${code} is already in use.`);
  let costOfSalesAccountId: string | null = null;
  let stockAccountId: string | null = null;
  if (input.kind === 'stock') {
    costOfSalesAccountId = input.costOfSalesAccountId ?? defaultCostOfSalesAccountId(db, input.companyId);
    stockAccountId = input.stockAccountId ?? defaultStockAccountId(db, input.companyId);
    checkAccounts(db, input.companyId, costOfSalesAccountId, stockAccountId);
  }
  const id = ids.item();
  db.insert(items).values({
    id, companyId: input.companyId, code, name, kind: input.kind, unit: input.unit.trim(), costingMethod: method,
    costOfSalesAccountId, stockAccountId, recordedBy: input.recordedBy, notes: input.notes?.trim() || null,
  }).run();
  return db.select().from(items).where(eq(items.id, id)).get()!;
}

/**
 * Change an item's name, unit, accounts, method or active flag. The costing
 * method and the unit are fixed once the item has a movement: a change would
 * re-cost every issue already made, or re-read every quantity recorded.
 */
export function updateItem(db: AppDatabase, params: {
  companyId: string; itemId: string; name?: string; unit?: string; costingMethod?: CostingMethod;
  costOfSalesAccountId?: string; stockAccountId?: string; active?: boolean; notes?: string | null;
}): Item {
  const item = requireItem(db, params.companyId, params.itemId);
  const moved = db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.itemId, item.id)).get();
  if (params.costingMethod && params.costingMethod !== item.costingMethod) {
    if (!COSTING_METHODS.includes(params.costingMethod)) throw new InventoryError(`The costing method is one of: ${COSTING_METHODS.join(', ')}.`);
    if (moved) throw new InventoryError(`${item.code} has stock movements: its costing method is fixed. Set up a new item to change it.`);
  }
  if (params.unit !== undefined && params.unit.trim() !== item.unit && moved) {
    throw new InventoryError(`${item.code} has stock movements recorded in ${item.unit}: its unit is fixed.`);
  }
  const costOfSalesAccountId = params.costOfSalesAccountId ?? item.costOfSalesAccountId;
  const stockAccountId = params.stockAccountId ?? item.stockAccountId;
  if (item.kind === 'stock' && (params.costOfSalesAccountId || params.stockAccountId)) {
    checkAccounts(db, params.companyId, costOfSalesAccountId!, stockAccountId!);
  }
  const name = params.name?.trim();
  if (params.name !== undefined && !name) throw new InventoryError('Give the item a name.');
  db.update(items).set({
    name: name ?? item.name, unit: params.unit?.trim() || item.unit, costingMethod: params.costingMethod ?? item.costingMethod,
    costOfSalesAccountId, stockAccountId, active: params.active ?? item.active,
    notes: params.notes === undefined ? item.notes : (params.notes?.trim() || null), updatedAt: nowIso(),
  }).where(eq(items.id, item.id)).run();
  return db.select().from(items).where(eq(items.id, item.id)).get()!;
}

export function requireItem(db: AppDatabase, companyId: string, itemId: string): Item {
  const item = db.select().from(items).where(and(eq(items.id, itemId), eq(items.companyId, companyId))).get();
  if (!item) throw new InventoryError(`Item ${itemId} not found.`);
  return item;
}

/** A stock item by id or code, or a refusal. */
export function requireStockItem(db: AppDatabase, companyId: string, itemIdOrCode: string): Item {
  const item = db.select().from(items).where(and(eq(items.companyId, companyId), eq(items.id, itemIdOrCode))).get()
    ?? db.select().from(items).where(and(eq(items.companyId, companyId), eq(items.code, itemIdOrCode))).get();
  if (!item) throw new InventoryError(`Item ${itemIdOrCode} not found.`);
  if (item.kind !== 'stock') throw new InventoryError(`${item.code} is a ${item.kind.replace('_', '-')} item: only a stock item is counted.`);
  return item;
}

export function listItems(db: AppDatabase, companyId: string): Item[] {
  return db.select().from(items).where(eq(items.companyId, companyId)).orderBy(asc(items.code)).all();
}

export function createLocation(db: AppDatabase, params: { companyId: string; code: string; name: string }): StockLocation {
  const code = params.code.trim();
  const name = params.name.trim();
  if (!code || !name) throw new InventoryError('Give the location a code and a name.');
  const clash = db.select({ id: stockLocations.id }).from(stockLocations)
    .where(and(eq(stockLocations.companyId, params.companyId), eq(stockLocations.code, code))).get();
  if (clash) throw new InventoryError(`Location code ${code} is already in use.`);
  const id = ids.stockLocation();
  db.insert(stockLocations).values({ id, companyId: params.companyId, code, name }).run();
  return db.select().from(stockLocations).where(eq(stockLocations.id, id)).get()!;
}

export function setLocationActive(db: AppDatabase, params: { companyId: string; locationId: string; active: boolean }): StockLocation {
  const location = requireLocation(db, params.companyId, params.locationId, { allowInactive: true });
  db.update(stockLocations).set({ active: params.active, updatedAt: nowIso() }).where(eq(stockLocations.id, location.id)).run();
  return db.select().from(stockLocations).where(eq(stockLocations.id, location.id)).get()!;
}

/** A location by id or code, or a refusal. */
export function requireLocation(
  db: AppDatabase, companyId: string, locationIdOrCode: string, options: { allowInactive?: boolean } = {},
): StockLocation {
  const location = db.select().from(stockLocations)
    .where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.id, locationIdOrCode))).get()
    ?? db.select().from(stockLocations)
      .where(and(eq(stockLocations.companyId, companyId), eq(stockLocations.code, locationIdOrCode))).get();
  if (!location) throw new InventoryError(`Location ${locationIdOrCode} not found.`);
  if (!location.active && !options.allowInactive) throw new InventoryError(`Location ${location.code} is inactive.`);
  return location;
}

export function listLocations(db: AppDatabase, companyId: string): StockLocation[] {
  return db.select().from(stockLocations).where(eq(stockLocations.companyId, companyId)).orderBy(asc(stockLocations.code)).all();
}

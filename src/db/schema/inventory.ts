import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { accounts } from './config';
import { invoiceLines, invoices } from './invoices';
import { journalEntries } from './accounting';

/**
 * Inventory (EPIC 23, issues #536–#538).
 *
 * The ledger keeps stock periodically: purchases are costs (5020) all year,
 * and a closing stock journal moves the value on hand to Stock on hand (1300)
 * at a date. Behind it, a perpetual subledger records every movement of every
 * stock item, and its FIFO or weighted average valuation is what that journal
 * posts.
 */

export const ITEM_KINDS = ['stock', 'non_stock', 'service'] as const;
export const COSTING_METHODS = ['fifo', 'weighted_average'] as const;

/** A product or service the business buys or sells (issue #536). Only a `stock` item is counted and valued. */
export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ITEM_KINDS }).notNull(),
  /** The unit it is counted in: each, kg, litre, box of 12. */
  unit: text('unit').notNull(),
  costingMethod: text('costing_method', { enum: COSTING_METHODS }).notNull().default('fifo'),
  /** Where the closing stock journal takes the cost of this item from (default 5020, Goods for resale). */
  costOfSalesAccountId: text('cost_of_sales_account_id').references(() => accounts.id),
  /** Where this item's stock is held on the balance sheet (default 1300, Stock on hand). */
  stockAccountId: text('stock_account_id').references(() => accounts.id),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  recordedBy: text('recorded_by').notNull(),
  notes: text('notes'),
  ...timestamps,
}, (t) => [uniqueIndex('items_company_code_unique').on(t.companyId, t.code)]);

/** Where stock is held (issue #536): a warehouse, a shop, a van. */
export const stockLocations = sqliteTable('stock_locations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
}, (t) => [uniqueIndex('stock_locations_company_code_unique').on(t.companyId, t.code)]);

export const STOCK_MOVEMENT_KINDS = [
  'opening', 'purchase', 'sale', 'customer_return', 'supplier_return', 'damaged', 'adjustment_in', 'adjustment_out',
  'transfer_in', 'transfer_out', 'stocktake_in', 'stocktake_out', 'reversal',
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * One movement of a stock item into or out of a location (issue #537).
 * Immutable: a mistake is corrected by a reversing movement. A movement in
 * carries its unit cost; a movement out is costed by the item's method when
 * the valuation is computed, never stored, so a back-dated movement cannot
 * leave a stale cost behind.
 */
export const stockMovements = sqliteTable('stock_movements', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  itemId: text('item_id').notNull().references(() => items.id),
  locationId: text('location_id').notNull().references(() => stockLocations.id),
  movementDate: text('movement_date').notNull(),
  /** Recording order within the company: movements on one date are replayed in this order. */
  sequence: integer('sequence').notNull(),
  kind: text('kind', { enum: STOCK_MOVEMENT_KINDS }).notNull(),
  /** Signed quantity in thousandths: positive in, negative out. */
  quantityMilli: integer('quantity_milli').notNull(),
  /** The cost per whole unit of a movement in, in minor units, as the person or the invoice line gave it. */
  unitCostMinor: integer('unit_cost_minor'),
  /** The total cost of a movement in, in minor units (what the valuation adds). */
  costMinor: integer('cost_minor'),
  /** For a return or a reversal: the movement whose cost it takes. */
  relatedMovementId: text('related_movement_id'),
  /** For a transfer: the other half. */
  transferPairId: text('transfer_pair_id'),
  invoiceId: text('invoice_id').references(() => invoices.id),
  invoiceLineId: text('invoice_line_id').references(() => invoiceLines.id),
  stocktakeId: text('stocktake_id'),
  reason: text('reason'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('stock_movements_item_idx').on(t.itemId, t.movementDate),
  index('stock_movements_company_idx').on(t.companyId, t.movementDate),
]);

/** A count of a location on a date (issue #537). Posting it records an adjustment for each difference. */
export const stocktakes = sqliteTable('stocktakes', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  locationId: text('location_id').notNull().references(() => stockLocations.id),
  countDate: text('count_date').notNull(),
  countedBy: text('counted_by').notNull(),
  status: text('status', { enum: ['draft', 'posted'] }).notNull().default('draft'),
  postedBy: text('posted_by'),
  postedAt: text('posted_at'),
  ...timestamps,
});

export const stocktakeLines = sqliteTable('stocktake_lines', {
  id: text('id').primaryKey(),
  stocktakeId: text('stocktake_id').notNull().references(() => stocktakes.id),
  itemId: text('item_id').notNull().references(() => items.id),
  countedQuantityMilli: integer('counted_quantity_milli').notNull(),
  /** The quantity the subledger held when the count was posted (snapshot). */
  bookQuantityMilli: integer('book_quantity_milli'),
  /** For a count over book: the unit cost the extra stock is valued at (the person's figure). */
  unitCostMinor: integer('unit_cost_minor'),
  ...timestamps,
}, (t) => [uniqueIndex('stocktake_lines_unique').on(t.stocktakeId, t.itemId)]);

export interface StockValuationLine {
  itemId: string; locationId: string; quantityMilli: number; valueMinor: number; method: string;
  stockAccountId: string; costOfSalesAccountId: string;
}

/**
 * A closing stock valuation posted to the ledger (issue #538): the value the
 * subledger computed at the date, and the journal that brought the stock
 * account to it.
 */
export const stockValuations = sqliteTable('stock_valuations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  valuationDate: text('valuation_date').notNull(),
  valueMinor: integer('value_minor').notNull(),
  /** What the stock accounts held before the journal. */
  ledgerBeforeMinor: integer('ledger_before_minor').notNull(),
  journalEntryId: text('journal_entry_id').references(() => journalEntries.id),
  /** Per item: quantity, value and method, snapshotted. */
  lines: text('lines', { mode: 'json' }).$type<StockValuationLine[]>().notNull(),
  postedBy: text('posted_by').notNull(),
  ...timestamps,
}, (t) => [index('stock_valuations_company_idx').on(t.companyId, t.valuationDate)]);

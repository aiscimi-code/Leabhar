import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { accountingPeriods, customers, invoiceLines, reviewItems, stockMovements, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import {
  createItem, updateItem, createLocation, recordOpeningStock, receivePurchase, issueSale, recordCustomerReturn,
  recordSupplierReturn, recordDamagedStock, recordStockAdjustment, transferStock, reverseStockMovement, replayItem,
  quantityOnHand, createStocktake, setStocktakeCount, postStocktake, valueInventory, planClosingStock, postClosingStock,
  NRV_NOTE, listStockValuations, type Item,
} from '.';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;
let shop: string;
let van: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Siopa Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Wholesale', matchKey: 'wholesale', countryCode: 'IE' }).run();
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
  shop = createLocation(db, { companyId, code: 'SHOP', name: 'Shop' }).id;
  van = createLocation(db, { companyId, code: 'VAN', name: 'Van' }).id;
});

const widget = (method: Item['costingMethod'] = 'fifo') => createItem(db, {
  companyId, code: 'W1', name: 'Widget', kind: 'stock', unit: 'each', costingMethod: method, recordedBy: 'owner',
});

/** A posted purchase invoice for `units` at `unitCost` cent each, to 5020; returns the line id. */
function bill(date: string, units: number, unitCost: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}): string {
  const { invoiceId } = createInvoice(db, {
    companyId, direction: 'purchase', invoiceDate: asIsoDate(date), supplierId, documentId: insertConfirmedDocument(db, companyId),
    lines: [{ description: 'Widgets', quantityMilli: units * 1000, unitPriceMinor: unitCost, accountId: byCode['5020']!, vatTreatmentId: tr['IE_STD']! }],
    ...over,
  });
  return db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).get()!.id;
}

function sale(date: string, units: number): string {
  const { invoiceId } = createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
    lines: [{ description: 'Widgets', quantityMilli: units * 1000, unitPriceMinor: 2_000, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
  });
  return db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).get()!.id;
}

const costs = (itemId: string) => replayItem(db, { companyId, itemId }).movements.map((m) => [m.kind, m.quantityMilli / 1000, m.valueMinor]);
const bal = (code: string, asOf: string) => accountBalance(db, { companyId, accountId: byCode[code]!, asOf: asIsoDate(asOf) });

describe('items and locations (issue #536)', () => {
  it('defaults a stock item to 5020 and 1300, and a service to neither', () => {
    const item = widget();
    expect([item.costOfSalesAccountId, item.stockAccountId]).toEqual([byCode['5020'], byCode['1300']]);
    const service = createItem(db, { companyId, code: 'FIT', name: 'Fitting', kind: 'service', unit: 'hour', recordedBy: 'owner' });
    expect([service.costOfSalesAccountId, service.stockAccountId]).toEqual([null, null]);
    expect(() => widget()).toThrow(/already in use/);
    expect(() => recordOpeningStock(db, { companyId, itemId: service.id, locationId: shop, date: '2025-01-01', quantityMilli: 1000, unitCostMinor: 1, recordedBy: 'o' }))
      .toThrow(/only a stock item is counted/);
  });

  it('fixes the costing method and the unit once the item has moved', () => {
    const item = widget();
    expect(updateItem(db, { companyId, itemId: item.id, costingMethod: 'weighted_average' }).costingMethod).toBe('weighted_average');
    recordOpeningStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-01-01', quantityMilli: 1000, unitCostMinor: 100, recordedBy: 'o' });
    expect(() => updateItem(db, { companyId, itemId: item.id, costingMethod: 'fifo' })).toThrow(/costing method is fixed/);
    expect(() => updateItem(db, { companyId, itemId: item.id, unit: 'box' })).toThrow(/unit is fixed/);
    expect(updateItem(db, { companyId, itemId: item.id, name: 'Blue widget' }).name).toBe('Blue widget');
  });
});

describe('FIFO and weighted average (issue #538)', () => {
  function history(method: Item['costingMethod']) {
    const item = widget(method);
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: bill('2025-02-01', 10, 1_000), recordedBy: 'o' });
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: bill('2025-03-01', 10, 1_300), recordedBy: 'o' });
    issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-04-01', invoiceLineId: sale('2025-04-01', 15), recordedBy: 'o' });
    return item;
  }

  it('FIFO issues the oldest layers first', () => {
    const item = history('fifo');
    // 10 at €10 and 5 at €13 out: €165.00; 5 at €13 left: €65.00.
    expect(costs(item.id)).toEqual([['purchase', 10, 10_000], ['purchase', 10, 13_000], ['sale', -15, -16_500]]);
    expect(valueInventory(db, { companyId, asOf: '2025-12-31' }).totalMinor).toBe(6_500);
  });

  it('weighted average takes the moving average, and the last unit out takes what is left exactly', () => {
    const item = history('weighted_average');
    // Average €11.50: 15 out at €172.50, 5 left at €57.50.
    expect(costs(item.id).at(-1)).toEqual(['sale', -15, -17_250]);
    // Three at a pool of €57.50 / 5 = 34.50; the last two take the remaining 23.00 exactly.
    recordDamagedStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-05-01', quantityMilli: 3000, reason: 'Crushed', recordedBy: 'o' });
    recordDamagedStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-05-02', quantityMilli: 2000, reason: 'Crushed', recordedBy: 'o' });
    expect(costs(item.id).slice(-2)).toEqual([['damaged', -3, -3_450], ['damaged', -2, -2_300]]);
    expect(valueInventory(db, { companyId, asOf: '2025-12-31' }).lines).toEqual([]);
  });

  it('a thirds split keeps every cent: 3 at €10.00 out one by one', () => {
    const item = widget('weighted_average');
    recordOpeningStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-01-01', quantityMilli: 3000, unitCostMinor: 333, recordedBy: 'o' });
    recordStockAdjustment(db, { companyId, itemId: item.id, locationId: shop, date: '2025-01-01', direction: 'in', quantityMilli: 1, unitCostMinor: 1000, reason: 'Found', recordedBy: 'o' });
    for (const d of ['2025-02-01', '2025-02-02']) {
      recordStockAdjustment(db, { companyId, itemId: item.id, locationId: shop, date: d, direction: 'out', quantityMilli: 1000, reason: 'Used', recordedBy: 'o' });
    }
    recordStockAdjustment(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-03', direction: 'out', quantityMilli: 1001, reason: 'Used', recordedBy: 'o' });
    const moved = costs(item.id);
    expect(moved.reduce((s, m) => s + (m[2] as number), 0)).toBe(0);
  });

  it('a back-dated receipt re-costs the issues after it', () => {
    const item = widget('fifo');
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: bill('2025-03-01', 5, 2_000), recordedBy: 'o' });
    issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-04-01', invoiceLineId: sale('2025-04-01', 5), recordedBy: 'o' });
    expect(costs(item.id).at(-1)).toEqual(['sale', -5, -10_000]);
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: bill('2025-02-01', 5, 1_000), recordedBy: 'o' });
    expect(costs(item.id).at(-1)).toEqual(['sale', -5, -5_000]);
    expect(valueInventory(db, { companyId, asOf: '2025-12-31' }).totalMinor).toBe(10_000);
  });
});

describe('movements (issue #537)', () => {
  it('refuses stock going below nil on its date, or on any later date', () => {
    const item = widget();
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: bill('2025-03-01', 5, 1_000), recordedBy: 'o' });
    // Nothing is held on 1 February.
    expect(() => recordDamagedStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', quantityMilli: 1000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/below nil/);
    issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-05-01', invoiceLineId: sale('2025-05-01', 4), recordedBy: 'o' });
    // Two out on 1 April leaves 3, but the sale of 4 on 1 May would then go below nil.
    expect(() => recordDamagedStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-04-01', quantityMilli: 2000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/below nil/);
    expect(db.select().from(stockMovements).all()).toHaveLength(2);
    // The van holds none of it.
    expect(() => recordDamagedStock(db, { companyId, itemId: item.id, locationId: van, date: '2025-06-01', quantityMilli: 1000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/below nil/);
  });

  it('receives a purchase line in parts at its own net, and a foreign line in the base currency', () => {
    const item = widget();
    const line = bill('2025-03-01', 3, 1_000);
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: line, quantityMilli: 1000, recordedBy: 'o' });
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-05', invoiceLineId: line, recordedBy: 'o' });
    expect(costs(item.id)).toEqual([['purchase', 1, 1_000], ['purchase', 2, 2_000]]);
    expect(() => receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-06', invoiceLineId: line, recordedBy: 'o' }))
      .toThrow(/quantity is a positive/);
    const gbp = bill('2025-03-01', 1, 1_000, { currency: 'GBP', fxRate: { numerator: 6, denominator: 5, source: 'ECB' } });
    const m = receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: gbp, recordedBy: 'o' });
    expect(m.movement.costMinor).toBe(1_200);
    expect(() => receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: sale('2025-03-01', 1), recordedBy: 'o' }))
      .toThrow(/sales invoice/);
  });

  it('warns when the purchase was posted to an account other than the item\'s cost of sales', () => {
    const item = widget();
    const { invoiceId } = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-03-01'), supplierId, documentId: insertConfirmedDocument(db, companyId),
      lines: [{ description: 'Widgets', quantityMilli: 1000, unitPriceMinor: 500, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const line = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).get()!.id;
    expect(receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: line, recordedBy: 'o' }).warnings)
      .toHaveLength(1);
  });

  it('returns: a customer\'s back at the sale\'s cost, a supplier\'s out at the receipt\'s cost', () => {
    const item = widget('weighted_average');
    const first = receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: bill('2025-02-01', 4, 1_000), recordedBy: 'o' }).movement;
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-02', invoiceLineId: bill('2025-02-02', 4, 2_000), recordedBy: 'o' });
    const sold = issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: sale('2025-03-01', 2), recordedBy: 'o' });
    // Sold at the €15 average; a later receipt at €30 moves the average but not the return.
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-02', invoiceLineId: bill('2025-03-02', 2, 3_000), recordedBy: 'o' });
    recordCustomerReturn(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-10', saleMovementId: sold.id, quantityMilli: 1000, reason: 'Faulty', recordedBy: 'o' });
    recordSupplierReturn(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-11', purchaseMovementId: first.id, quantityMilli: 1000, reason: 'Wrong colour', recordedBy: 'o' });
    expect(costs(item.id).slice(-2)).toEqual([['customer_return', 1, 1_500], ['supplier_return', -1, -1_000]]);
    expect(() => recordCustomerReturn(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-12', saleMovementId: sold.id, quantityMilli: 2000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/more has come back/);
  });

  it('under FIFO a supplier return needs the receipt\'s own goods still at the location', () => {
    const item = widget('fifo');
    const first = receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: bill('2025-02-01', 2, 1_000), recordedBy: 'o' }).movement;
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-02', invoiceLineId: bill('2025-02-02', 2, 2_000), recordedBy: 'o' });
    issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: sale('2025-03-01', 2), recordedBy: 'o' });
    expect(() => recordSupplierReturn(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-02', purchaseMovementId: first.id, quantityMilli: 1000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/already been issued/);
  });

  it('a transfer carries its cost; the value at each location follows the layers', () => {
    const item = widget('fifo');
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: bill('2025-02-01', 2, 1_000), recordedBy: 'o' });
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-02', invoiceLineId: bill('2025-02-02', 2, 2_000), recordedBy: 'o' });
    transferStock(db, { companyId, itemId: item.id, fromLocationId: shop, toLocationId: van, date: '2025-02-10', quantityMilli: 3000, recordedBy: 'o' });
    const lines = valueInventory(db, { companyId, asOf: '2025-02-10' }).lines.map((l) => [l.locationCode, l.quantityMilli, l.valueMinor]);
    expect(lines).toEqual([['SHOP', 1000, 2_000], ['VAN', 3000, 4_000]]);
    expect(quantityOnHand(db, { companyId, itemId: item.id, locationId: van, asOf: '2025-02-09' })).toBe(0);
    expect(() => transferStock(db, { companyId, itemId: item.id, fromLocationId: shop, toLocationId: van, date: '2025-02-11', quantityMilli: 2000, recordedBy: 'o' }))
      .toThrow(/below nil/);
  });

  it('a reversal undoes a movement at its own cost, once, and the original stays', () => {
    const item = widget('fifo');
    const line = bill('2025-02-01', 2, 1_000);
    const m = receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-01', invoiceLineId: line, recordedBy: 'o' }).movement;
    reverseStockMovement(db, { companyId, movementId: m.id, date: '2025-02-03', reason: 'Wrong item', recordedBy: 'o' });
    expect(costs(item.id)).toEqual([['purchase', 2, 2_000], ['reversal', -2, -2_000]]);
    expect(() => reverseStockMovement(db, { companyId, movementId: m.id, date: '2025-02-03', reason: 'again', recordedBy: 'o' })).toThrow(/already been reversed/);
    // The line can be received again once its receipt is reversed.
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-02-04', invoiceLineId: line, recordedBy: 'o' });
    expect(quantityOnHand(db, { companyId, itemId: item.id, locationId: shop, asOf: '2025-12-31' })).toBe(2000);
  });
});

describe('stocktakes (issue #537)', () => {
  it('posts a movement per difference and snapshots the book quantity', () => {
    const item = widget('fifo');
    const other = createItem(db, { companyId, code: 'W2', name: 'Gadget', kind: 'stock', unit: 'each', recordedBy: 'o' });
    recordOpeningStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-01-01', quantityMilli: 10_000, unitCostMinor: 500, recordedBy: 'o' });
    const st = createStocktake(db, { companyId, locationId: shop, countDate: '2025-06-30', countedBy: 'Aoife' });
    setStocktakeCount(db, { companyId, stocktakeId: st.id, itemId: item.id, countedQuantityMilli: 8_000 });
    setStocktakeCount(db, { companyId, stocktakeId: st.id, itemId: other.id, countedQuantityMilli: 2_000 });
    expect(() => postStocktake(db, { companyId, stocktakeId: st.id, postedBy: 'o' })).toThrow(/Give the unit cost/);
    setStocktakeCount(db, { companyId, stocktakeId: st.id, itemId: other.id, countedQuantityMilli: 2_000, unitCostMinor: 250 });
    const posted = postStocktake(db, { companyId, stocktakeId: st.id, postedBy: 'o' });
    expect(posted.map((l) => [l.code, l.bookQuantityMilli, l.countedQuantityMilli])).toEqual([['W1', 10_000, 8_000], ['W2', 0, 2_000]]);
    expect(costs(item.id).at(-1)).toEqual(['stocktake_out', -2, -1_000]);
    expect(costs(other.id)).toEqual([['stocktake_in', 2, 500]]);
    expect(() => postStocktake(db, { companyId, stocktakeId: st.id, postedBy: 'o' })).toThrow(/has been posted/);
  });
});

describe('closing stock (issue #538)', () => {
  function opening() {
    const item = widget('fifo');
    recordOpeningStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-01-01', quantityMilli: 10_000, unitCostMinor: 1_000, recordedBy: 'o' });
    postJournalEntry(db, {
      companyId, entryDate: asIsoDate('2025-01-01'), narrative: 'Opening balances', sourceType: 'opening_balance', baseCurrency: 'EUR',
      lines: [{ accountId: byCode['1300']!, debitMinor: 10_000 }, { accountId: byCode['3100']!, creditMinor: 10_000 }],
    });
    return item;
  }

  it('moves the change since the opening stock between 1300 and 5020, and later only the further change', () => {
    const item = opening();
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2025-03-01', invoiceLineId: bill('2025-03-01', 10, 1_200), recordedBy: 'o' });
    issueSale(db, { companyId, itemId: item.id, locationId: shop, date: '2025-06-01', invoiceLineId: sale('2025-06-01', 14), recordedBy: 'o' });
    // Left: 6 at €12 = €72. Opening €100: a fall of €28 into cost of sales.
    const first = postClosingStock(db, { companyId, date: '2025-12-31', postedBy: 'o' });
    expect(first.plan.valuation.totalMinor).toBe(7_200);
    expect(first.plan.valuation.note).toBe(NRV_NOTE);
    expect(bal('1300', '2025-12-31')).toBe(7_200);
    // 5020: the €120 purchase plus the €28 fall.
    expect(bal('5020', '2025-12-31')).toBe(12_000 + 2_800);
    // Nothing moves on or before a posted valuation.
    expect(() => recordDamagedStock(db, { companyId, itemId: item.id, locationId: shop, date: '2025-12-31', quantityMilli: 1000, reason: 'x', recordedBy: 'o' }))
      .toThrow(/Closing stock has been posted/);
    expect(() => postClosingStock(db, { companyId, date: '2025-12-31', postedBy: 'o' })).toThrow(/already been posted/);
    receivePurchase(db, { companyId, itemId: item.id, locationId: shop, date: '2026-02-01', invoiceLineId: bill('2026-02-01', 1, 1_500), recordedBy: 'o' });
    const second = postClosingStock(db, { companyId, date: '2026-06-30', postedBy: 'o' });
    expect(second.plan.pairs).toEqual([expect.objectContaining({ previousMinor: 7_200, valueMinor: 8_700, changeMinor: 1_500 })]);
    expect(bal('1300', '2026-06-30')).toBe(8_700);
  });

  it('refuses, with a review item, when 1300 holds something closing stock did not book', () => {
    opening();
    postJournalEntry(db, {
      companyId, entryDate: asIsoDate('2025-05-01'), narrative: 'Stray', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: byCode['1300']!, debitMinor: 500 }, { accountId: byCode['3100']!, creditMinor: 500 }],
    });
    expect(planClosingStock(db, { companyId, date: '2025-12-31' }).stockAccounts[0]).toMatchObject({ ledgerMinor: 10_500, bookedMinor: 10_000 });
    expect(() => postClosingStock(db, { companyId, date: '2025-12-31', postedBy: 'o' })).toThrow(/do not agree|does not agree/);
    expect(db.select().from(reviewItems).all().map((r) => r.kind)).toContain('reconciliation_difference');
    expect(bal('1300', '2025-12-31')).toBe(10_500);
  });

  it('posts nothing but a valuation when nothing changed, and refuses a locked period', () => {
    opening();
    db.update(accountingPeriods).set({ status: 'locked' }).where(eq(accountingPeriods.companyId, companyId)).run();
    expect(() => postClosingStock(db, { companyId, date: '2025-06-30', postedBy: 'o' })).toThrow(/locked/);
    expect(listStockValuations(db, companyId)).toHaveLength(0);
    db.update(accountingPeriods).set({ status: 'open' }).where(eq(accountingPeriods.companyId, companyId)).run();
    const r = postClosingStock(db, { companyId, date: '2025-06-30', postedBy: 'o' });
    expect(r.journalEntryId).toBeNull();
  });
});

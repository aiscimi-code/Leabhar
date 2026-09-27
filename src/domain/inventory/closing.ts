import { and, desc, eq, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, companies, items, stockMovements, stockValuations, stockLocations, type StockValuationLine } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, type IsoDate } from '../dates';
import { atomically, assertAccountingPeriodOpen, postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { upsertReviewItem } from '../extraction/service';
import { replayItem } from './costing';
import { InventoryError } from './items';

/**
 * Inventory valuation and closing stock (EPIC 23, issue #538).
 *
 * The valuation is the replay's quantity and value by item and location at a
 * date: cost, by each item's method. FRS 102 s.13 carries inventories at the
 * lower of cost and estimated selling price less costs to complete and sell;
 * this book computes cost only, and every valuation carries the note that the
 * net realisable value test is the person's.
 *
 * Posting closing stock brings each stock account to the valuation with one
 * journal: Dr stock on hand / Cr the item's cost-of-sales account for an
 * increase, the other way for a fall. Each (stock account, cost-of-sales
 * account) pair moves by the change in its value since the last posted
 * valuation, or since the opening stock for the first one. Before posting,
 * the stock account's ledger balance must equal what was last booked there;
 * an entry posted to it outside closing stock is a review item and nothing is
 * posted (invariant 7).
 */

export const NRV_NOTE = 'Valued at cost (FIFO or weighted average, per item). FRS 102 s.13 requires the lower of cost and '
  + 'estimated selling price less costs to complete and sell: write down any item whose selling price no longer covers its cost.';

export interface ValuationLine extends StockValuationLine {
  code: string; name: string; unit: string; locationCode: string;
}

export interface InventoryValuation {
  asOf: string;
  lines: ValuationLine[];
  totalMinor: number;
  note: string;
}

const eur = (m: number) => (m / 100).toFixed(2);

/** Quantity and value by item and location at a date, with the method named (issue #538). */
export function valueInventory(db: AppDatabase, params: { companyId: string; asOf: string }): InventoryValuation {
  if (!isIsoDate(params.asOf)) throw new InventoryError('The valuation date is a YYYY-MM-DD date.');
  const locations = new Map(db.select().from(stockLocations).where(eq(stockLocations.companyId, params.companyId)).all()
    .map((l) => [l.id, l.code]));
  const stock = db.select().from(items).where(and(eq(items.companyId, params.companyId), eq(items.kind, 'stock')))
    .orderBy(items.code).all();
  const lines: ValuationLine[] = [];
  for (const item of stock) {
    const { positions } = replayItem(db, { companyId: params.companyId, itemId: item.id, asOf: params.asOf });
    for (const [locationId, pos] of [...positions].sort((a, b) => (locations.get(a[0]) ?? '').localeCompare(locations.get(b[0]) ?? ''))) {
      if (pos.quantityMilli === 0 && pos.valueMinor === 0) continue;
      lines.push({
        itemId: item.id, code: item.code, name: item.name, unit: item.unit, locationId, locationCode: locations.get(locationId) ?? locationId,
        quantityMilli: pos.quantityMilli, valueMinor: pos.valueMinor, method: item.costingMethod,
        stockAccountId: item.stockAccountId!, costOfSalesAccountId: item.costOfSalesAccountId!,
      });
    }
  }
  return { asOf: params.asOf, lines, totalMinor: lines.reduce((s, l) => s + l.valueMinor, 0), note: NRV_NOTE };
}

const pairKey = (l: { stockAccountId: string; costOfSalesAccountId: string }) => `${l.stockAccountId}|${l.costOfSalesAccountId}`;

function sumByPair(lines: Array<{ stockAccountId: string; costOfSalesAccountId: string; valueMinor: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(pairKey(l), (out.get(pairKey(l)) ?? 0) + l.valueMinor);
  return out;
}

export interface ClosingStockPlan {
  date: IsoDate;
  valuation: InventoryValuation;
  /** What was last booked per pair: the previous valuation, or the opening stock. */
  previousBasis: 'valuation' | 'opening_stock';
  previousDate: string | null;
  pairs: Array<{ stockAccountId: string; costOfSalesAccountId: string; previousMinor: number; valueMinor: number; changeMinor: number }>;
  stockAccounts: Array<{ accountId: string; code: string; name: string; ledgerMinor: number; bookedMinor: number; differenceMinor: number }>;
}

/** Work out the closing stock journal without posting it. */
export function planClosingStock(db: AppDatabase, params: { companyId: string; date: string }): ClosingStockPlan {
  if (!isIsoDate(params.date)) throw new InventoryError('The closing stock date is a YYYY-MM-DD date.');
  const date = asIsoDate(params.date);
  const last = db.select().from(stockValuations).where(eq(stockValuations.companyId, params.companyId))
    .orderBy(desc(stockValuations.valuationDate)).get();
  if (last && last.valuationDate >= date) {
    throw new InventoryError(`Closing stock has already been posted at ${last.valuationDate}: a valuation is posted after the last one.`);
  }
  const valuation = valueInventory(db, { companyId: params.companyId, asOf: date });
  let previous: Map<string, number>;
  if (last) {
    previous = sumByPair(last.lines);
  } else {
    const opening = db.select({
      valueMinor: stockMovements.costMinor, stockAccountId: items.stockAccountId, costOfSalesAccountId: items.costOfSalesAccountId,
    }).from(stockMovements).innerJoin(items, eq(stockMovements.itemId, items.id))
      .where(and(eq(stockMovements.companyId, params.companyId), eq(stockMovements.kind, 'opening'), lte(stockMovements.movementDate, date)))
      .all();
    previous = sumByPair(opening.map((o) => ({
      valueMinor: o.valueMinor ?? 0, stockAccountId: o.stockAccountId!, costOfSalesAccountId: o.costOfSalesAccountId!,
    })));
  }
  const now = sumByPair(valuation.lines);
  const keys = [...new Set([...previous.keys(), ...now.keys()])].sort();
  const pairs = keys.map((k) => {
    const [stockAccountId, costOfSalesAccountId] = k.split('|') as [string, string];
    const previousMinor = previous.get(k) ?? 0;
    const valueMinor = now.get(k) ?? 0;
    return { stockAccountId, costOfSalesAccountId, previousMinor, valueMinor, changeMinor: valueMinor - previousMinor };
  });
  const stockAccountIds = [...new Set(pairs.map((p) => p.stockAccountId))];
  const stockAccounts = stockAccountIds.map((accountId) => {
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
    const ledgerMinor = accountBalance(db, { companyId: params.companyId, accountId, asOf: date });
    const bookedMinor = pairs.filter((p) => p.stockAccountId === accountId).reduce((s, p) => s + p.previousMinor, 0);
    return { accountId, code: account.code, name: account.name, ledgerMinor, bookedMinor, differenceMinor: ledgerMinor - bookedMinor };
  });
  return { date, valuation, previousBasis: last ? 'valuation' : 'opening_stock', previousDate: last?.valuationDate ?? null, pairs, stockAccounts };
}

/**
 * Post closing stock at a date (issue #538): one journal moving each pair's
 * change in value between the stock account and the cost-of-sales account,
 * and a valuation row recording what it posted. Refused, with a review item,
 * when a stock account's ledger balance is not what was last booked there.
 */
export function postClosingStock(db: AppDatabase, params: { companyId: string; date: string; postedBy: string }): {
  valuationId: string; journalEntryId: string | null; plan: ClosingStockPlan;
} {
  const plan = planClosingStock(db, params);
  const off = plan.stockAccounts.filter((a) => a.differenceMinor !== 0);
  for (const a of off) {
    upsertReviewItem(db, {
      companyId: params.companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `Closing stock: ${a.code} ${a.name} holds ${eur(a.ledgerMinor)}, not the ${eur(a.bookedMinor)} last booked`,
      detail: `On ${plan.date} the ledger holds ${eur(a.ledgerMinor)} on ${a.code}, and the `
        + (plan.previousBasis === 'valuation' ? `closing stock posted at ${plan.previousDate}` : 'opening stock recorded in the stock ledger')
        + ` comes to ${eur(a.bookedMinor)}. Find the entry posted to the stock account outside closing stock, or record the `
        + 'opening stock the opening balance stands for, before posting closing stock.',
      entityType: 'account', entityId: a.accountId, dedupeKey: `closing_stock:${a.accountId}:${plan.date}`,
      context: { ...a, date: plan.date },
    });
  }
  if (off.length > 0) {
    throw new InventoryError(`The stock ${off.length === 1 ? 'account does' : 'accounts do'} not agree with what was last booked: `
      + off.map((a) => `${a.code} holds ${eur(a.ledgerMinor)}, booked ${eur(a.bookedMinor)}`).join('; ') + '. See the review queue.');
  }
  return atomically(db, () => {
    const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
    if (!company) throw new InventoryError(`Company ${params.companyId} not found.`);
    assertAccountingPeriodOpen(db, params.companyId, plan.date);
    const valuationId = ids.stockValuation();
    const lines = plan.pairs.filter((p) => p.changeMinor !== 0).flatMap((p) => p.changeMinor > 0
      ? [{ accountId: p.stockAccountId, debitMinor: p.changeMinor, memo: 'Closing stock: increase in stock on hand' },
        { accountId: p.costOfSalesAccountId, creditMinor: p.changeMinor, memo: 'Closing stock: taken out of cost of sales' }]
      : [{ accountId: p.costOfSalesAccountId, debitMinor: -p.changeMinor, memo: 'Closing stock: fall in stock on hand' },
        { accountId: p.stockAccountId, creditMinor: -p.changeMinor, memo: 'Closing stock: brought into cost of sales' }]);
    let journalEntryId: string | null = null;
    if (lines.length > 0) {
      journalEntryId = postJournalEntry(db, {
        companyId: params.companyId, entryDate: plan.date, narrative: `Closing stock at ${plan.date}: valued at ${eur(plan.valuation.totalMinor)}`,
        sourceType: 'closing_stock', sourceId: valuationId, baseCurrency: company.baseCurrency,
        createdBy: params.postedBy, createdVia: 'user', lines,
      }).id;
    }
    db.insert(stockValuations).values({
      id: valuationId, companyId: params.companyId, valuationDate: plan.date, valueMinor: plan.valuation.totalMinor,
      ledgerBeforeMinor: plan.stockAccounts.reduce((s, a) => s + a.ledgerMinor, 0), journalEntryId,
      lines: plan.valuation.lines.map((l) => ({
        itemId: l.itemId, locationId: l.locationId, quantityMilli: l.quantityMilli, valueMinor: l.valueMinor, method: l.method,
        stockAccountId: l.stockAccountId, costOfSalesAccountId: l.costOfSalesAccountId,
      })),
      postedBy: params.postedBy,
    }).run();
    return { valuationId, journalEntryId, plan };
  });
}

export function listStockValuations(db: AppDatabase, companyId: string) {
  return db.select().from(stockValuations).where(eq(stockValuations.companyId, companyId)).orderBy(desc(stockValuations.valuationDate)).all();
}

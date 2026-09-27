import { and, desc, eq, notInArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { invoiceLines, invoices } from '@/db/schema';
import {
  listItems, listLocations, listMovements, listStocktakes, listStockValuations, valueInventory, planClosingStock, replayItem,
} from '@/domain/inventory';
import { requireCompany } from './queries';

/**
 * Read models for the inventory screen (EPIC 23). Every quantity and value
 * comes from the inventory domain's replay; these only gather it for a page.
 */

function recentInvoiceLines(companyId: string, direction: 'sales' | 'purchase') {
  return getDb().select({
    id: invoiceLines.id, description: invoiceLines.description, quantityMilli: invoiceLines.quantityMilli,
    invoiceNumber: invoices.invoiceNumber, invoiceDate: invoices.invoiceDate,
  }).from(invoiceLines).innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .where(and(eq(invoices.companyId, companyId), eq(invoices.direction, direction), eq(invoices.isCreditNote, false),
      notInArray(invoices.status, ['draft', 'void'])))
    .orderBy(desc(invoices.invoiceDate)).limit(100).all();
}

export function inventoryPage(asOf: string) {
  const db = getDb();
  const company = requireCompany();
  const items = listItems(db, company.id);
  const costOf = new Map<string, number>();
  for (const item of items.filter((i) => i.kind === 'stock')) {
    for (const m of replayItem(db, { companyId: company.id, itemId: item.id }).movements) costOf.set(m.id, m.valueMinor);
  }
  let closing: ReturnType<typeof planClosingStock> | null = null;
  let closingError: string | null = null;
  try {
    closing = planClosingStock(db, { companyId: company.id, date: asOf });
  } catch (e) {
    closingError = e instanceof Error ? e.message : String(e);
  }
  return {
    company,
    items,
    locations: listLocations(db, company.id),
    movements: listMovements(db, company.id).slice(0, 200).map((m) => ({ ...m, valueMinor: costOf.get(m.id) ?? null })),
    stocktakes: listStocktakes(db, company.id),
    valuation: valueInventory(db, { companyId: company.id, asOf }),
    valuations: listStockValuations(db, company.id),
    closing,
    closingError,
    purchaseLines: recentInvoiceLines(company.id, 'purchase'),
    salesLines: recentInvoiceLines(company.id, 'sales'),
  };
}

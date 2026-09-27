'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import {
  createItem, createLocation, recordOpeningStock, receivePurchase, issueSale, recordCustomerReturn, recordSupplierReturn,
  recordDamagedStock, recordStockAdjustment, transferStock, reverseStockMovement, createStocktake, setStocktakeCount,
  postStocktake, postClosingStock, parseQuantity, type CostingMethod, type ItemKind,
} from '@/domain/inventory';

/**
 * Inventory mutations (EPIC 23, issues #536–#538). The domain owns every
 * quantity and cost; these only pass the form on.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string, warnings?: string[]): ActionResult => {
  revalidatePath('/inventory');
  return { ok: true, message, warnings };
};

async function movementContext(f: FormData) {
  const company = requireCompany();
  return {
    company,
    common: {
      companyId: company.id, itemId: text(f, 'itemId'), locationId: text(f, 'locationId'), date: text(f, 'date'),
      recordedBy: await actorName(),
    },
  };
}

export async function createItemAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    const item = createItem(getDb(), {
      companyId: requireCompany().id, code: text(f, 'code'), name: text(f, 'name'), kind: text(f, 'kind') as ItemKind,
      unit: text(f, 'unit'), costingMethod: (text(f, 'costingMethod') || 'fifo') as CostingMethod, recordedBy: await actorName(),
    });
    return done(`${item.code} added.`);
  } catch (e) { return fail(e); }
}

export async function createLocationAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    const location = createLocation(getDb(), { companyId: requireCompany().id, code: text(f, 'code'), name: text(f, 'name') });
    return done(`${location.code} added.`);
  } catch (e) { return fail(e); }
}

export async function recordMovementAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    const { company, common } = await movementContext(f);
    const db = getDb();
    const q = () => parseQuantity(text(f, 'quantity'));
    const optionalQ = () => (text(f, 'quantity') ? q() : undefined);
    const unitCost = () => (text(f, 'unitCost') ? parseAmount(text(f, 'unitCost'), company.baseCurrency) : null);
    const reason = text(f, 'reason');
    switch (text(f, 'kind')) {
      case 'opening':
        recordOpeningStock(db, { ...common, quantityMilli: q(), unitCostMinor: unitCost() ?? -1 });
        return done('Opening stock recorded.');
      case 'purchase': {
        const { warnings } = receivePurchase(db, { ...common, invoiceLineId: text(f, 'invoiceLineId'), quantityMilli: optionalQ() });
        return done('Received at the invoice line\'s cost.', warnings);
      }
      case 'sale':
        issueSale(db, { ...common, invoiceLineId: text(f, 'invoiceLineId'), quantityMilli: optionalQ() });
        return done('Issued: its cost follows the item\'s method.');
      case 'customer_return':
        recordCustomerReturn(db, { ...common, saleMovementId: text(f, 'relatedMovementId'), quantityMilli: q(), reason });
        return done('Customer return recorded at the cost the goods left at.');
      case 'supplier_return':
        recordSupplierReturn(db, { ...common, purchaseMovementId: text(f, 'relatedMovementId'), quantityMilli: q(), reason });
        return done('Supplier return recorded at the cost the goods came in at.');
      case 'damaged':
        recordDamagedStock(db, { ...common, quantityMilli: q(), reason });
        return done('Written off at cost.');
      case 'adjustment_in':
      case 'adjustment_out':
        recordStockAdjustment(db, {
          ...common, direction: text(f, 'kind') === 'adjustment_in' ? 'in' : 'out', quantityMilli: q(), unitCostMinor: unitCost(), reason,
        });
        return done('Adjustment recorded.');
      default:
        throw new Error('Choose what kind of movement this is.');
    }
  } catch (e) { return fail(e); }
}

export async function transferStockAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    transferStock(getDb(), {
      companyId: requireCompany().id, itemId: text(f, 'itemId'), fromLocationId: text(f, 'fromLocationId'),
      toLocationId: text(f, 'toLocationId'), date: text(f, 'date'), quantityMilli: parseQuantity(text(f, 'quantity')),
      recordedBy: await actorName(),
    });
    return done('Transferred: the cost moves with the stock.');
  } catch (e) { return fail(e); }
}

export async function reverseMovementAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    reverseStockMovement(getDb(), {
      companyId: requireCompany().id, movementId: text(f, 'movementId'), date: text(f, 'date'), reason: text(f, 'reason'),
      recordedBy: await actorName(),
    });
    return done('Reversed. The original stays on file.');
  } catch (e) { return fail(e); }
}

/** Record and post a count: one line per item with a counted quantity. */
export async function stocktakeAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('inventory.manage');
    const db = getDb();
    const company = requireCompany();
    const counts = f.getAll('countItemId').map((itemId, i) => ({
      itemId: String(itemId), quantity: String(f.getAll('countQuantity')[i] ?? '').trim(), unitCost: String(f.getAll('countUnitCost')[i] ?? '').trim(),
    })).filter((c) => c.quantity !== '');
    if (counts.length === 0) throw new Error('Enter at least one count.');
    const postedBy = await actorName();
    const result = db.transaction(() => {
      const st = createStocktake(db, { companyId: company.id, locationId: text(f, 'locationId'), countDate: text(f, 'date'), countedBy: text(f, 'countedBy') });
      for (const c of counts) {
        setStocktakeCount(db, {
          companyId: company.id, stocktakeId: st.id, itemId: c.itemId, countedQuantityMilli: parseQuantity(c.quantity),
          unitCostMinor: c.unitCost ? parseAmount(c.unitCost, company.baseCurrency) : null,
        });
      }
      return postStocktake(db, { companyId: company.id, stocktakeId: st.id, postedBy });
    });
    const differences = result.filter((l) => l.movementId).length;
    return done(`Stocktake posted: ${differences} difference${differences === 1 ? '' : 's'} recorded.`);
  } catch (e) { return fail(e); }
}

export async function postClosingStockAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    const { journalEntryId } = postClosingStock(getDb(), { companyId: requireCompany().id, date: text(f, 'date'), postedBy: await actorName() });
    revalidatePath('/reports');
    return done(journalEntryId ? 'Closing stock posted.' : 'Nothing changed since the last valuation: recorded with no journal.');
  } catch (e) { return fail(e); }
}

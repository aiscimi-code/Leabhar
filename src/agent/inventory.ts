import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount } from '@/domain/money';
import {
  createItem, createLocation, recordOpeningStock, receivePurchase, issueSale, recordCustomerReturn, recordSupplierReturn,
  recordDamagedStock, recordStockAdjustment, transferStock, reverseStockMovement, createStocktake, setStocktakeCount,
  postStocktake, valueInventory, planClosingStock, postClosingStock, listItems, listLocations, listMovements,
  requireStockItem, requireLocation, parseQuantity, type ItemKind, type CostingMethod,
} from '@/domain/inventory';

export { parseQuantity };

/** Inventory commands (EPIC 23, issues #536–#538): the same domain functions the inventory screen calls. */

export const INVENTORY_USAGE = `
Inventory (EPIC 23, issues #536-#538). Quantities are in the item's unit (1.5 = one and a half);
--item and --location take an id or a code:
  add-item --code <code> --name <text> --kind stock|non_stock|service --unit <unit> --by <name>
           [--method fifo|weighted_average] [--cos-account <id>] [--stock-account <id>]
  add-location --code <code> --name <text>
  list-items | list-locations | list-movements [--item <id>]
  opening-stock --item <id> --location <id> --date <date> --quantity <n> --unit-cost <euro> --by <name>
  receive-stock --item <id> --location <id> --date <date> --invoice-line <id> [--quantity <n>] --by <name>
  issue-stock --item <id> --location <id> --date <date> --invoice-line <id> [--quantity <n>] --by <name>
  customer-return --item <id> --location <id> --date <date> --sale-movement <id> --quantity <n> --reason <text> --by <name>
  supplier-return --item <id> --location <id> --date <date> --purchase-movement <id> --quantity <n> --reason <text> --by <name>
  damaged-stock --item <id> --location <id> --date <date> --quantity <n> --reason <text> --by <name>
  adjust-stock --item <id> --location <id> --date <date> --direction in|out --quantity <n> [--unit-cost <euro>]
           --reason <text> --by <name>
  transfer-stock --item <id> --from <location> --to <location> --date <date> --quantity <n> --by <name>
  reverse-movement --movement <id> --date <date> --reason <text> --by <name>
  stocktake --location <id> --date <date> --counted-by <name> --count <item>=<n>[@<unit cost euro>] ... --by <name>
                                         Record and post a count; one --count per item, comma-separated
  stock-valuation --as-of <date>         Quantity and value by item and location, at cost
  closing-stock --date <date> [--post --by <name>]
                                         The closing stock journal (FRS 102 s.13 NRV is flagged), posted with --post
`;

export const INVENTORY_COMMANDS = [
  'add-item', 'add-location', 'list-items', 'list-locations', 'list-movements', 'opening-stock', 'receive-stock', 'issue-stock',
  'customer-return', 'supplier-return', 'damaged-stock', 'adjust-stock', 'transfer-stock', 'reverse-movement', 'stocktake',
  'stock-valuation', 'closing-stock',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

export function runInventoryCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  const common = () => ({
    companyId, itemId: requireStockItem(db, companyId, need(flags, 'item')).id,
    locationId: requireLocation(db, companyId, need(flags, 'location')).id, date: need(flags, 'date'), recordedBy: need(flags, 'by'),
  });
  const quantity = () => parseQuantity(need(flags, 'quantity'));
  const optionalQuantity = () => (getFlag(flags, 'quantity') ? quantity() : undefined);
  switch (command) {
    case 'add-item':
      return createItem(db, {
        companyId, code: need(flags, 'code'), name: need(flags, 'name'), kind: need(flags, 'kind') as ItemKind, unit: need(flags, 'unit'),
        costingMethod: getFlag(flags, 'method') as CostingMethod | undefined, costOfSalesAccountId: getFlag(flags, 'cos-account'),
        stockAccountId: getFlag(flags, 'stock-account'), recordedBy: need(flags, 'by'),
      });
    case 'add-location':
      return createLocation(db, { companyId, code: need(flags, 'code'), name: need(flags, 'name') });
    case 'list-items':
      return listItems(db, companyId);
    case 'list-locations':
      return listLocations(db, companyId);
    case 'list-movements': {
      const item = getFlag(flags, 'item');
      return listMovements(db, companyId, { itemId: item ? requireStockItem(db, companyId, item).id : undefined });
    }
    case 'opening-stock':
      return recordOpeningStock(db, { ...common(), quantityMilli: quantity(), unitCostMinor: parseAmount(need(flags, 'unit-cost'), 'EUR') });
    case 'receive-stock':
      return receivePurchase(db, { ...common(), invoiceLineId: need(flags, 'invoice-line'), quantityMilli: optionalQuantity() });
    case 'issue-stock':
      return issueSale(db, { ...common(), invoiceLineId: need(flags, 'invoice-line'), quantityMilli: optionalQuantity() });
    case 'customer-return':
      return recordCustomerReturn(db, { ...common(), saleMovementId: need(flags, 'sale-movement'), quantityMilli: quantity(), reason: need(flags, 'reason') });
    case 'supplier-return':
      return recordSupplierReturn(db, {
        ...common(), purchaseMovementId: need(flags, 'purchase-movement'), quantityMilli: quantity(), reason: need(flags, 'reason'),
      });
    case 'damaged-stock':
      return recordDamagedStock(db, { ...common(), quantityMilli: quantity(), reason: need(flags, 'reason') });
    case 'adjust-stock': {
      const direction = need(flags, 'direction');
      if (direction !== 'in' && direction !== 'out') throw new Error('--direction is in or out.');
      const cost = getFlag(flags, 'unit-cost');
      return recordStockAdjustment(db, {
        ...common(), direction, quantityMilli: quantity(), unitCostMinor: cost ? parseAmount(cost, 'EUR') : null, reason: need(flags, 'reason'),
      });
    }
    case 'transfer-stock':
      return transferStock(db, {
        companyId, itemId: requireStockItem(db, companyId, need(flags, 'item')).id,
        fromLocationId: requireLocation(db, companyId, need(flags, 'from')).id, toLocationId: requireLocation(db, companyId, need(flags, 'to')).id,
        date: need(flags, 'date'), quantityMilli: quantity(), recordedBy: need(flags, 'by'),
      });
    case 'reverse-movement':
      return reverseStockMovement(db, {
        companyId, movementId: need(flags, 'movement'), date: need(flags, 'date'), reason: need(flags, 'reason'), recordedBy: need(flags, 'by'),
      });
    case 'stocktake': {
      const st = createStocktake(db, {
        companyId, locationId: requireLocation(db, companyId, need(flags, 'location')).id, countDate: need(flags, 'date'),
        countedBy: need(flags, 'counted-by'),
      });
      for (const entry of need(flags, 'count').split(',')) {
        const m = /^([^=]+)=([\d.]+)(?:@([\d.]+))?$/.exec(entry.trim());
        if (!m) throw new Error(`--count takes <item>=<quantity>[@<unit cost>], not "${entry}".`);
        setStocktakeCount(db, {
          companyId, stocktakeId: st.id, itemId: requireStockItem(db, companyId, m[1]!).id, countedQuantityMilli: parseQuantity(m[2]!),
          unitCostMinor: m[3] ? parseAmount(m[3], 'EUR') : null,
        });
      }
      return { stocktakeId: st.id, lines: postStocktake(db, { companyId, stocktakeId: st.id, postedBy: need(flags, 'by') }) };
    }
    case 'stock-valuation':
      return valueInventory(db, { companyId, asOf: need(flags, 'as-of') });
    case 'closing-stock':
      return flags.post
        ? postClosingStock(db, { companyId, date: need(flags, 'date'), postedBy: need(flags, 'by') })
        : planClosingStock(db, { companyId, date: need(flags, 'date') });
    default:
      throw new Error(`Unknown inventory command: ${command}`);
  }
}

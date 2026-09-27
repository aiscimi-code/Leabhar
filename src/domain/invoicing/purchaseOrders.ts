import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  purchaseOrders, purchaseOrderLines, invoices, suppliers, accounts, companies, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';

/**
 * Purchase orders (issue #411).
 *
 * An order is a commitment, not an accounting fact: it posts nothing and
 * claims no VAT. A bill posted from its confirmed document is linked to the
 * order it was raised against; the order's billed amount and status follow
 * from the bills linked to it, and a bill that takes the order over what was
 * ordered is flagged — never silently accepted, never refused.
 */

export interface PurchaseOrderLineInput {
  description: string;
  quantityMilli?: number;
  netMinor: number;
  accountId?: string | null;
}

export function createPurchaseOrder(
  db: AppDatabase,
  params: {
    companyId: string; supplierId: string; orderDate: IsoDate; expectedDate?: IsoDate | null;
    lines: PurchaseOrderLineInput[]; notes?: string | null; actor: string;
  },
): { purchaseOrderId: string; number: string } {
  if (!params.actor.trim()) throw new InvoicingError('Say who is raising this order.');
  const supplier = db.select().from(suppliers)
    .where(and(eq(suppliers.id, params.supplierId), eq(suppliers.companyId, params.companyId))).get();
  if (!supplier) throw new InvoicingError(`Supplier ${params.supplierId} not found.`);
  if (params.lines.length === 0) throw new InvoicingError('An order needs at least one line.');
  params.lines.forEach((line, i) => {
    if (!line.description.trim()) throw new InvoicingError(`Line ${i + 1} needs a description.`);
    if (!Number.isInteger(line.netMinor) || line.netMinor <= 0) {
      throw new InvoicingError(`Line ${i + 1}: the expected net is a positive amount in minor units.`);
    }
    if (line.quantityMilli !== undefined && (!Number.isInteger(line.quantityMilli) || line.quantityMilli <= 0)) {
      throw new InvoicingError(`Line ${i + 1}: the quantity is positive, in thousandths.`);
    }
    if (line.accountId) {
      const account = db.select().from(accounts)
        .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, params.companyId))).get();
      if (!account) throw new InvoicingError(`Line ${i + 1}: account ${line.accountId} not found.`);
    }
  });
  if (params.expectedDate && params.expectedDate < params.orderDate) {
    throw new InvoicingError('The expected date is before the order date.');
  }
  const currency = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, params.companyId)).get()!.c;
  const last = db.select({ n: sql<number>`coalesce(max(cast(substr(${purchaseOrders.number}, 4) as integer)), 0)` })
    .from(purchaseOrders).where(eq(purchaseOrders.companyId, params.companyId)).get()!.n;
  const number = `PO-${Number(last) + 1}`;
  const purchaseOrderId = ids.purchaseOrder();
  db.transaction(() => {
    db.insert(purchaseOrders).values({
      id: purchaseOrderId, companyId: params.companyId, supplierId: supplier.id, number,
      orderDate: params.orderDate, expectedDate: params.expectedDate ?? null, currency,
      notes: params.notes ?? null, createdBy: params.actor,
    }).run();
    params.lines.forEach((line, i) => {
      db.insert(purchaseOrderLines).values({
        id: ids.purchaseOrderLine(), purchaseOrderId, companyId: params.companyId, lineNumber: i + 1,
        description: line.description.trim(), quantityMilli: line.quantityMilli ?? 1000,
        netMinor: line.netMinor, accountId: line.accountId ?? null,
      }).run();
    });
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'purchase_order', entityId: purchaseOrderId, action: 'created',
      newValue: JSON.stringify({ number, supplierId: supplier.id, orderedMinor: params.lines.reduce((s, l) => s + l.netMinor, 0) }),
      source: 'user', actor: params.actor,
    }).run();
  });
  return { purchaseOrderId, number };
}

export interface PurchaseOrderSummary {
  id: string; number: string; supplierId: string; supplierName: string;
  orderDate: string; expectedDate: string | null; currency: string;
  status: 'open' | 'part_billed' | 'billed' | 'cancelled';
  orderedMinor: number; billedMinor: number; remainingMinor: number;
  lines: Array<{ lineNumber: number; description: string; quantityMilli: number; netMinor: number }>;
  bills: Array<{ invoiceId: string; number: string | null; invoiceDate: string; netMinor: number }>;
  notes: string | null; cancelReason: string | null;
}

function summarise(db: AppDatabase, order: typeof purchaseOrders.$inferSelect): PurchaseOrderSummary {
  const lines = db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id))
    .orderBy(purchaseOrderLines.lineNumber).all();
  const bills = db.select().from(invoices).where(and(
    eq(invoices.purchaseOrderId, order.id), eq(invoices.companyId, order.companyId),
  )).orderBy(invoices.invoiceDate).all().filter((b) => b.status !== 'void');
  const orderedMinor = lines.reduce((s, l) => s + l.netMinor, 0);
  // Bills count at their net: VAT is not part of what was ordered. A credit
  // note linked to the order reduces what has been billed.
  const billedMinor = bills.reduce((s, b) => s + b.netMinor, 0);
  const supplierName = db.select({ n: suppliers.name }).from(suppliers).where(eq(suppliers.id, order.supplierId)).get()?.n ?? '';
  // The status follows from the bills, so a bill voided after it was linked
  // reopens the order without anything having to remember to update it.
  const status = order.status === 'cancelled' ? 'cancelled'
    : billedMinor <= 0 ? 'open' : billedMinor >= orderedMinor ? 'billed' : 'part_billed';
  return {
    id: order.id, number: order.number, supplierId: order.supplierId, supplierName,
    orderDate: order.orderDate, expectedDate: order.expectedDate, currency: order.currency, status,
    orderedMinor, billedMinor, remainingMinor: Math.max(orderedMinor - billedMinor, 0),
    lines: lines.map((l) => ({ lineNumber: l.lineNumber, description: l.description, quantityMilli: l.quantityMilli, netMinor: l.netMinor })),
    bills: bills.map((b) => ({ invoiceId: b.id, number: b.invoiceNumber, invoiceDate: b.invoiceDate, netMinor: b.netMinor })),
    notes: order.notes, cancelReason: order.cancelReason,
  };
}

export function getPurchaseOrder(db: AppDatabase, params: { companyId: string; purchaseOrderId: string }): PurchaseOrderSummary {
  const order = db.select().from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, params.purchaseOrderId), eq(purchaseOrders.companyId, params.companyId))).get();
  if (!order) throw new InvoicingError(`Purchase order ${params.purchaseOrderId} not found.`);
  return summarise(db, order);
}

export function listPurchaseOrders(
  db: AppDatabase, params: { companyId: string; supplierId?: string | null; openOnly?: boolean },
): PurchaseOrderSummary[] {
  return db.select().from(purchaseOrders).where(and(
    eq(purchaseOrders.companyId, params.companyId),
    params.supplierId ? eq(purchaseOrders.supplierId, params.supplierId) : undefined,
  )).orderBy(desc(purchaseOrders.orderDate)).all()
    .map((o) => summarise(db, o))
    .filter((o) => !params.openOnly || o.status === 'open' || o.status === 'part_billed');
}

/** Recompute an order's status from its bills, and flag an overbilled order. */
function refresh(db: AppDatabase, order: typeof purchaseOrders.$inferSelect): PurchaseOrderSummary {
  const summary = summarise(db, order);
  if (summary.status !== order.status) {
    db.update(purchaseOrders).set({ status: summary.status, updatedAt: nowIso() }).where(eq(purchaseOrders.id, order.id)).run();
  }
  if (summary.billedMinor > summary.orderedMinor) {
    upsertReviewItem(db, {
      companyId: order.companyId, kind: 'invoice_total_mismatch', severity: 'warning',
      title: `${order.number} billed over what was ordered`,
      detail: `Ordered ${(summary.orderedMinor / 100).toFixed(2)}; bills linked to it total ${(summary.billedMinor / 100).toFixed(2)} `
        + `net, ${((summary.billedMinor - summary.orderedMinor) / 100).toFixed(2)} over. Check the bills against the order before paying.`,
      entityType: 'purchase_order', entityId: order.id, dedupeKey: `purchase_order:${order.id}:overbilled`,
    });
  }
  return summary;
}

/** Link a posted bill (or supplier credit note) to the order it was raised against. */
export function linkBillToPurchaseOrder(
  db: AppDatabase, params: { companyId: string; invoiceId: string; purchaseOrderId: string; actor: string },
): PurchaseOrderSummary {
  const order = db.select().from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, params.purchaseOrderId), eq(purchaseOrders.companyId, params.companyId))).get();
  if (!order) throw new InvoicingError(`Purchase order ${params.purchaseOrderId} not found.`);
  if (order.status === 'cancelled') throw new InvoicingError(`${order.number} was cancelled.`);
  const bill = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!bill) throw new InvoicingError(`Invoice ${params.invoiceId} not found.`);
  if (bill.direction !== 'purchase') throw new InvoicingError('Only a bill (a purchase invoice) is linked to a purchase order.');
  if (bill.supplierId !== order.supplierId) throw new InvoicingError(`The bill is from a different supplier from ${order.number}.`);
  if (bill.status === 'void') throw new InvoicingError('That bill has been voided.');
  if (bill.purchaseOrderId && bill.purchaseOrderId !== order.id) throw new InvoicingError('That bill is already linked to another order.');
  if (bill.currency !== order.currency) throw new InvoicingError(`The bill is in ${bill.currency}; ${order.number} is in ${order.currency}.`);
  return db.transaction(() => {
    db.update(invoices).set({ purchaseOrderId: order.id, updatedAt: nowIso() }).where(eq(invoices.id, bill.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'invoice', entityId: bill.id, action: 'updated', field: 'purchase_order_id',
      previousValue: JSON.stringify(bill.purchaseOrderId), newValue: JSON.stringify(order.id),
      source: 'user', actor: params.actor,
    }).run();
    return refresh(db, order);
  });
}

/** Cancel what remains of an order. Bills already linked stay linked. */
export function cancelPurchaseOrder(
  db: AppDatabase, params: { companyId: string; purchaseOrderId: string; reason: string; actor: string },
): void {
  const order = db.select().from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, params.purchaseOrderId), eq(purchaseOrders.companyId, params.companyId))).get();
  if (!order) throw new InvoicingError(`Purchase order ${params.purchaseOrderId} not found.`);
  if (order.status === 'cancelled') return;
  if (summarise(db, order).status === 'billed') throw new InvoicingError(`${order.number} is fully billed; there is nothing left to cancel.`);
  if (!params.reason.trim()) throw new InvoicingError('Say why the order is cancelled.');
  db.transaction(() => {
    db.update(purchaseOrders).set({ status: 'cancelled', cancelledAt: nowIso(), cancelReason: params.reason, updatedAt: nowIso() })
      .where(eq(purchaseOrders.id, order.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'purchase_order', entityId: order.id, action: 'voided',
      source: 'user', actor: params.actor, reason: params.reason,
    }).run();
  });
}

/** Undo a link made in error. The bill itself is untouched. */
export function unlinkBillFromPurchaseOrder(
  db: AppDatabase, params: { companyId: string; invoiceId: string; actor: string },
): PurchaseOrderSummary | null {
  const bill = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!bill) throw new InvoicingError(`Invoice ${params.invoiceId} not found.`);
  if (!bill.purchaseOrderId) return null;
  const order = db.select().from(purchaseOrders).where(eq(purchaseOrders.id, bill.purchaseOrderId)).get()!;
  return db.transaction(() => {
    db.update(invoices).set({ purchaseOrderId: null, updatedAt: nowIso() }).where(eq(invoices.id, bill.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'invoice', entityId: bill.id, action: 'updated', field: 'purchase_order_id',
      previousValue: JSON.stringify(order.id), newValue: JSON.stringify(null),
      source: 'user', actor: params.actor,
    }).run();
    return refresh(db, order);
  });
}

export interface PurchaseOrderDocument {
  order: PurchaseOrderSummary;
  buyer: { name: string; address: string | null; vatNumber: string | null };
  supplier: { name: string; address: string | null; vatNumber: string | null };
}

/** What a printed order shows: the order, who is buying, and from whom. */
export function purchaseOrderDocument(
  db: AppDatabase, params: { companyId: string; purchaseOrderId: string },
): PurchaseOrderDocument {
  const order = getPurchaseOrder(db, params);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const supplier = db.select().from(suppliers).where(eq(suppliers.id, order.supplierId)).get()!;
  return {
    order,
    buyer: { name: company.legalName, address: company.principalBusinessAddress ?? company.registeredOffice, vatNumber: company.vatNumber },
    supplier: { name: supplier.legalName ?? supplier.name, address: supplier.viesAddress, vatNumber: supplier.vatNumber },
  };
}

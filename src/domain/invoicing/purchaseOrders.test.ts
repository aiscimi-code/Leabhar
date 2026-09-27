import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, voidInvoice } from './invoices';
import {
  createPurchaseOrder, listPurchaseOrders, getPurchaseOrder, linkBillToPurchaseOrder,
  unlinkBillFromPurchaseOrder, cancelPurchaseOrder,
} from './purchaseOrders';
import { asIsoDate } from '../dates';
import { suppliers, customers, reviewItems, journalEntries, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { extractPdfText } from '../extraction/pdfText';
import { renderPurchaseOrderPdf } from '@/lib/purchaseOrderPdf';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let otherSupplierId: string;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  otherSupplierId = ids.supplier();
  db.insert(suppliers).values([
    { id: supplierId, companyId, name: 'Murphy', matchKey: 'murphy', countryCode: 'IE' },
    { id: otherSupplierId, companyId, name: 'Walsh', matchKey: 'walsh', countryCode: 'IE' },
  ]).run();
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const order = () => createPurchaseOrder(db, {
  companyId, supplierId, orderDate: asIsoDate('2025-03-01'), expectedDate: asIsoDate('2025-03-20'), actor: 'test',
  lines: [
    { description: 'Paper', quantityMilli: 10_000, netMinor: 6_000 },
    { description: 'Toner', netMinor: 4_000, accountId: byCode['6120']! },
  ],
});
const bill = (netMinor: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-03-10'), supplierId,
  documentId: insertConfirmedDocument(db, companyId),
  lines: [{ description: 'Stationery', netMinor, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});

describe('purchase orders (#411)', () => {
  it('numbers orders in sequence and posts nothing', () => {
    const journals = db.select().from(journalEntries).all().length;
    const first = order();
    const second = order();
    expect([first.number, second.number]).toEqual(['PO-1', 'PO-2']);
    expect(db.select().from(journalEntries).all().length).toBe(journals);
    expect(db.select().from(vatEntries).all()).toEqual([]);
    const summary = getPurchaseOrder(db, { companyId, purchaseOrderId: first.purchaseOrderId });
    expect(summary).toMatchObject({ status: 'open', orderedMinor: 10_000, billedMinor: 0, remainingMinor: 10_000, supplierName: 'Murphy' });
    expect(summary.lines.map((l) => l.quantityMilli)).toEqual([10_000, 1_000]);
  });

  it('refuses an order with no lines, a non-positive or fractional amount, or an unknown supplier', () => {
    const base = { companyId, supplierId, orderDate: asIsoDate('2025-03-01'), actor: 'test' };
    expect(() => createPurchaseOrder(db, { ...base, lines: [] })).toThrow(/at least one line/);
    expect(() => createPurchaseOrder(db, { ...base, lines: [{ description: 'x', netMinor: 0 }] })).toThrow(/positive/);
    expect(() => createPurchaseOrder(db, { ...base, lines: [{ description: 'x', netMinor: 1.5 }] })).toThrow(/positive/);
    expect(() => createPurchaseOrder(db, { ...base, supplierId: 'sup_nope', lines: [{ description: 'x', netMinor: 1 }] })).toThrow(/not found/);
    expect(() => createPurchaseOrder(db, { ...base, expectedDate: asIsoDate('2025-02-01'), lines: [{ description: 'x', netMinor: 1 }] }))
      .toThrow(/before the order date/);
  });

  it('follows the bills linked to it: part billed, then billed', () => {
    const po = order();
    const first = bill(4_000);
    let summary = linkBillToPurchaseOrder(db, { companyId, invoiceId: first.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    expect(summary).toMatchObject({ status: 'part_billed', billedMinor: 4_000, remainingMinor: 6_000 });
    const second = bill(6_000);
    summary = linkBillToPurchaseOrder(db, { companyId, invoiceId: second.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    expect(summary).toMatchObject({ status: 'billed', billedMinor: 10_000, remainingMinor: 0 });
    expect(summary.bills.map((b) => b.invoiceId)).toEqual([first.invoiceId, second.invoiceId]);
    expect(listPurchaseOrders(db, { companyId, openOnly: true })).toEqual([]);
    expect(() => cancelPurchaseOrder(db, { companyId, purchaseOrderId: po.purchaseOrderId, reason: 'no longer needed', actor: 'test' }))
      .toThrow(/fully billed/);
  });

  it('flags a bill that takes the order over what was ordered, and still links it', () => {
    const po = order();
    const summary = linkBillToPurchaseOrder(db, { companyId, invoiceId: bill(12_500).invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    expect(summary).toMatchObject({ status: 'billed', billedMinor: 12_500, remainingMinor: 0 });
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `purchase_order:${po.purchaseOrderId}:overbilled`)).get();
    expect(flag?.detail).toMatch(/Ordered 100\.00; .* 125\.00 net, 25\.00 over/);
  });

  it('reduces what is billed by a supplier credit note linked to it', () => {
    const po = order();
    const first = bill(10_000);
    linkBillToPurchaseOrder(db, { companyId, invoiceId: first.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    const credit = bill(2_500, { isCreditNote: true, creditNoteOfId: first.invoiceId });
    const summary = linkBillToPurchaseOrder(db, { companyId, invoiceId: credit.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    expect(summary).toMatchObject({ status: 'part_billed', billedMinor: 7_500, remainingMinor: 2_500 });
  });

  it('reopens when a linked bill is voided or unlinked', () => {
    const po = order();
    const first = bill(10_000);
    linkBillToPurchaseOrder(db, { companyId, invoiceId: first.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    voidInvoice(db, { companyId, invoiceId: first.invoiceId, reason: 'Posted twice', voidDate: asIsoDate('2025-03-12') });
    expect(getPurchaseOrder(db, { companyId, purchaseOrderId: po.purchaseOrderId })).toMatchObject({ status: 'open', billedMinor: 0 });
    const second = bill(10_000);
    linkBillToPurchaseOrder(db, { companyId, invoiceId: second.invoiceId, purchaseOrderId: po.purchaseOrderId, actor: 'test' });
    expect(unlinkBillFromPurchaseOrder(db, { companyId, invoiceId: second.invoiceId, actor: 'test' })).toMatchObject({ status: 'open', billedMinor: 0 });
  });

  it('refuses a sales invoice, another supplier\'s bill, a bill linked elsewhere, and a cancelled order', () => {
    const po = order();
    const other = order();
    const sale = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
      lines: [{ description: 'Work', netMinor: 5_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const link = (invoiceId: string, purchaseOrderId = po.purchaseOrderId) =>
      linkBillToPurchaseOrder(db, { companyId, invoiceId, purchaseOrderId, actor: 'test' });
    expect(() => link(sale.invoiceId)).toThrow(/Only a bill/);
    expect(() => link(bill(1_000, { supplierId: otherSupplierId }).invoiceId)).toThrow(/different supplier/);
    const linked = bill(1_000);
    link(linked.invoiceId, other.purchaseOrderId);
    expect(() => link(linked.invoiceId)).toThrow(/another order/);
    cancelPurchaseOrder(db, { companyId, purchaseOrderId: po.purchaseOrderId, reason: 'Supplier could not deliver', actor: 'test' });
    expect(() => link(bill(1_000).invoiceId)).toThrow(/cancelled/);
    expect(getPurchaseOrder(db, { companyId, purchaseOrderId: po.purchaseOrderId })).toMatchObject({ status: 'cancelled', cancelReason: 'Supplier could not deliver' });
    expect(listPurchaseOrders(db, { companyId, openOnly: true }).map((o) => o.number)).toEqual(['PO-2']);
  });

  it('keeps orders to their company', () => {
    const po = order();
    expect(() => getPurchaseOrder(db, { companyId: 'co_other', purchaseOrderId: po.purchaseOrderId })).toThrow(/not found/);
  });
});

describe('the printed order', () => {
  it('names the buyer and the supplier', async () => {
    const { purchaseOrderDocument } = await import('./purchaseOrders');
    const po = order();
    const docu = purchaseOrderDocument(db, { companyId, purchaseOrderId: po.purchaseOrderId });
    expect(docu.buyer.name).toBe('Acme Ltd');
    expect(docu.supplier.name).toBe('Murphy');
    expect(docu.order.number).toBe('PO-1');
    const text = await extractPdfText(Buffer.from(await renderPurchaseOrderPdf(docu)));
    expect(text).toContain('PURCHASE ORDER');
    expect(text).toContain('PO-1');
    expect(text).toContain('Toner');
    expect(text).toContain('100.00');
  });
});

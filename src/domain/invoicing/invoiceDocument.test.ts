import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from './invoices';
import { salesInvoiceDocument } from './invoiceDocument';
import { addCustomerContact } from '../parties/customerAccount';
import { renderInvoicePdf } from '@/lib/invoicePdf';
import { extractPdfText } from '../extraction/pdfText';
import { asIsoDate } from '../dates';
import { companies, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const complete = () => {
  db.update(companies).set({ principalBusinessAddress: '1 Main Street, Dublin 1', vatNumber: 'IE6388047V', croNumber: '123456' })
    .where(eq(companies.id, companyId)).run();
  db.update(customers).set({ addressLines: '2 Quay Street, Cork', legalName: 'Mulligan Digital Ltd' })
    .where(eq(customers.id, customerId)).run();
};

const invoice = (over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [
    { description: 'Consulting', quantityMilli: 2000, unitPriceMinor: 50_000, discountBasisPoints: 1_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
    { description: 'Training materials', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_RED']! },
  ],
  ...over,
});

describe('sales invoice document (#395)', () => {
  it('states every reg.20 particular, the net and VAT at each rate, and nothing missing', () => {
    complete();
    addCustomerContact(db, { companyId, customerId, name: 'Aoife', email: 'aoife@mulligan.ie', isBilling: true, actor: 'Joe' });
    const inv = invoice();
    const doc = salesInvoiceDocument(db, { companyId, invoiceId: inv.invoiceId });
    expect(doc.missing).toEqual([]);
    expect(doc.supplier).toMatchObject({ name: 'Acme Ltd', address: '1 Main Street, Dublin 1', vatNumber: 'IE6388047V' });
    expect(doc.customer).toMatchObject({ name: 'Mulligan Digital Ltd', attention: 'Aoife' });
    expect(doc.lines[0]).toMatchObject({ undiscountedNetMinor: 100_000, discountMinor: 10_000, netMinor: 90_000, vatMinor: 20_700 });
    expect(doc.rates).toEqual([
      { rateBasisPoints: 2300, netMinor: 90_000, vatMinor: 20_700 },
      { rateBasisPoints: 1350, netMinor: 10_000, vatMinor: 1_350 },
    ]);
    expect([doc.netMinor, doc.vatMinor, doc.grossMinor]).toEqual([inv.netMinor, inv.vatMinor, inv.grossMinor]);
    expect(doc.legends).toEqual([]);
  });

  it('lists what is missing rather than filling it in', () => {
    const inv = invoice();
    const codes = salesInvoiceDocument(db, { companyId, invoiceId: inv.invoiceId }).missing.map((m) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['supplier_address', 'supplier_vat_number', 'customer_address']));
  });

  it('requires the customer VAT number and states the legend for an EU services supply', () => {
    complete();
    const inv = invoice({ lines: [{ description: 'Design', netMinor: 50_000, accountId: byCode['4020']!, vatTreatmentId: tr['EU_SERVICES_SUPPLY']! }] });
    const doc = salesInvoiceDocument(db, { companyId, invoiceId: inv.invoiceId });
    expect(doc.missing.map((m) => m.code)).toEqual(['customer_vat_number']);
    expect(doc.legends[0]).toMatch(/^Reverse charge/);
  });

  it('prints a credit note as positive figures that refer to the invoice credited', () => {
    complete();
    const original = invoice();
    const credit = invoice({
      isCreditNote: true, creditNoteOfId: original.invoiceId,
      lines: [{ description: 'Refund', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const doc = salesInvoiceDocument(db, { companyId, invoiceId: credit.invoiceId });
    expect(doc.kind).toBe('credit_note');
    expect([doc.netMinor, doc.vatMinor, doc.grossMinor]).toEqual([10_000, 2_300, 12_300]);
    expect(doc.creditsInvoiceNumber).toBe(salesInvoiceDocument(db, { companyId, invoiceId: original.invoiceId }).number);
    expect(doc.missing).toEqual([]);
  });

  it('renders a PDF saying what the document says, marked draft when particulars are missing', async () => {
    complete();
    const inv = invoice();
    const doc = salesInvoiceDocument(db, { companyId, invoiceId: inv.invoiceId });
    const bytes = await renderInvoicePdf(doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const text = await extractPdfText(Buffer.from(bytes));
    for (const s of ['INVOICE', doc.number!, 'IE6388047V', 'Mulligan Digital Ltd', 'Consulting', '10.00%', 'Net at 13.5%', 'Total due', '€1,220.50']) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('DRAFT');

    const draft = await extractPdfText(Buffer.from(await renderInvoicePdf({ ...doc, missing: [{ code: 'x', paragraph: 'reg.20(2)(c)', what: 'your address' }] })));
    expect(draft).toContain('DRAFT');
    expect(draft).toContain('your address');
  });
});

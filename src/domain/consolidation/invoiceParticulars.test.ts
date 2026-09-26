import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { invoices, reviewItems, suppliers, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import { missingInvoiceParticulars, type ParticularsInput } from './invoiceParticulars';
import { postDocumentAsInvoice, ConsolidationError } from './postDocument';
import { documentLineChoices } from './suggest';
import type { AppDatabase } from '@/db';

/** Issue #209 part 2: input VAT is deducted only on an invoice with the reg.20(2) particulars. */

const full: ParticularsInput = {
  documentType: 'supplier_invoice', invoiceNumber: 'INV-1', documentDate: '2026-03-01',
  supplierNameStated: 'Murphy Ltd', supplierAddress: '1 Main St, Dublin', supplierVatNumber: 'IE6388047V',
  customerNameStated: 'Acme Ltd', customerAddress: '2 Quay St, Cork',
  lines: [{ description: 'Paper', netMinor: 10_000, vatRateBasisPoints: 2300, vatMinor: 2_300 }],
  vatTotals: [], vatMinor: 2_300, netMinor: 10_000, reverseCharge: false,
};
const codes = (over: Partial<ParticularsInput>) => missingInvoiceParticulars({ ...full, ...over }).map((m) => m.code);

describe('the reg.20(2) particulars (pure)', () => {
  it('a complete invoice lacks nothing', () => expect(codes({})).toEqual([]));

  it('each missing particular is named', () => {
    expect(codes({ invoiceNumber: null })).toEqual(['sequential_number']);
    expect(codes({ supplierAddress: ' ' })).toEqual(['supplier_address']);
    expect(codes({ supplierVatNumber: null })).toEqual(['supplier_vat_number']);
    expect(codes({ supplierVatNumber: 'IE123' })).toEqual(['supplier_vat_number']);
    expect(codes({ customerNameStated: null, customerAddress: null })).toEqual(['customer_name', 'customer_address']);
    expect(codes({ lines: [{ description: 'Paper', netMinor: 10_000, vatRateBasisPoints: null, vatMinor: 2_300 }] }))
      .toEqual(['rate_and_net_per_rate']);
  });

  it('a single-rate invoice states the rate and net in its totals', () => {
    expect(codes({
      lines: [{ description: 'Paper', netMinor: 10_000, vatRateBasisPoints: null, vatMinor: null }],
      vatTotals: [{ rateBasisPoints: 2300, netMinor: null, vatMinor: 2_300 }],
    })).toEqual([]);
  });

  it('a receipt is not a VAT invoice', () => expect(codes({ documentType: 'receipt' })).toContain('not_an_invoice'));

  it('no VAT charged: nothing to deduct, nothing required', () => {
    expect(codes({ vatMinor: 0, lines: [{ description: 'Paper', netMinor: 10_000, vatRateBasisPoints: 0, vatMinor: 0 }], supplierVatNumber: null })).toEqual([]);
  });

  it('a reverse charge needs no Irish VAT number, rate or tax on the invoice', () => {
    expect(codes({ reverseCharge: true, vatMinor: 0, supplierVatNumber: 'DE812871812',
      lines: [{ description: 'Hosting', netMinor: 10_000, vatRateBasisPoints: null, vatMinor: null }] })).toEqual([]);
  });
});

let db: AppDatabase;
let companyId: string;
let root: string;
let tr: Record<string, string>;
let byCode: Record<string, string>;
let supplierId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  companyId = created.companyId; tr = created.treatmentsByCode; byCode = created.accountsByCode;
  root = mkdtempSync(join(tmpdir(), 'particulars-'));
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy Ltd', matchKey: 'murphy ltd', countryCode: 'IE' }).run();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function confirmed(over: Partial<ReviewedDocumentValues>): string {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 7)}`,
    documentDate: '2026-03-10', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Murphy Ltd', supplierAddress: '1 Main St, Dublin', supplierVatNumber: 'IE6388047V', supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: 10_000, vatMinor: 2_300, grossMinor: 12_300, vatTotals: [],
    lines: [{ description: 'Paper', quantity: null, unitPriceMinor: null, netMinor: 10_000, vatRateBasisPoints: 2300, vatMinor: 2_300, grossMinor: 12_300 }],
    ...over,
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, { companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId, acknowledgedCheckCodes: ['vat_totals_missing'] });
  return stored.documentId;
}
const coding = [{ accountId: '', vatTreatmentId: '' }];

describe('posting a purchase invoice that lacks a particular', () => {
  it('the posting choices name what is missing', () => {
    const doc = confirmed({});
    expect(documentLineChoices(db, { companyId, documentId: doc }).missingParticulars.map((m) => m.code)).toEqual(['customer_address']);
  });

  it('is refused with the list; posted with the VAT held back, nothing is recovered and a review item says why', () => {
    const doc = confirmed({});
    const code = [{ ...coding[0]!, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }];
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: code })).toThrow(ConsolidationError);
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: code })).toThrow(/your address \(reg\.20\(2\)\(d\)\)/);

    const inv = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: code, holdVatForMissingParticulars: true });
    const entries = db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).all();
    const recoverable = db.select().from(vatEntries).all().filter((e) => e.direction === 'purchases' && e.journalEntryId
      === db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!.journalEntryId);
    expect([...entries, ...recoverable].every((e) => e.recoverableVatMinor === 0)).toBe(true);
    expect(recoverable.length + entries.length).toBeGreaterThan(0);
    const item = db.select().from(reviewItems)
      .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.entityId, inv.invoiceId))).all()
      .find((r) => /Held back from recovery/.test(r.detail ?? ''));
    expect(item).toBeDefined();
  });

  it('a complete invoice posts with its VAT recovered', () => {
    const doc = confirmed({ customerAddress: '2 Quay St, Cork' });
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: doc, coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const je = db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!.journalEntryId;
    const entries = db.select().from(vatEntries).all().filter((e) => e.journalEntryId === je);
    expect(entries.reduce((s, e) => s + e.recoverableVatMinor, 0)).toBe(2_300);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from './invoices';
import { salesInvoiceDocument } from './invoiceDocument';
import { renderInvoicePdf } from '@/lib/invoicePdf';
import { extractPdfText } from '../extraction/pdfText';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import { invoices, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;
let otherId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  otherId = ids.customer();
  db.insert(customers).values({ id: otherId, companyId, name: 'Other', matchKey: 'other', countryCode: 'IE' }).run();
});

const sale = (net: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});

describe('debit notes (#403)', () => {
  it('posts an additional charge like an invoice, linked to the invoice it adds to', async () => {
    const original = sale(10_000);
    const debit = sale(1_000, { isDebitNote: true, debitNoteOfId: original.invoiceId, invoiceDate: asIsoDate('2025-03-20') });
    const row = db.select().from(invoices).where(eq(invoices.id, debit.invoiceId)).get()!;
    expect([row.isDebitNote, row.debitNoteOfId, row.grossMinor, row.outstandingMinor]).toEqual([true, original.invoiceId, 1_230, 1_230]);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(12_300 + 1_230);

    const doc = salesInvoiceDocument(db, { companyId, invoiceId: debit.invoiceId });
    expect(doc.kind).toBe('debit_note');
    const originalNumber = db.select().from(invoices).where(eq(invoices.id, original.invoiceId)).get()!.invoiceNumber!;
    expect(doc.adjustsInvoiceNumber).toBe(originalNumber);
    const text = await extractPdfText(Buffer.from(await renderInvoicePdf(doc)));
    expect(text).toContain('DEBIT NOTE');
    expect(text).toContain(`Adds to invoice ${originalNumber}`);
  });

  it('refuses a debit note without its invoice, against another party or a credit note, or that is also a credit note', () => {
    const original = sale(10_000);
    const credit = sale(1_000, { isCreditNote: true });
    expect(() => sale(100, { isDebitNote: true })).toThrow(/names the invoice/);
    expect(() => sale(100, { isDebitNote: true, debitNoteOfId: original.invoiceId, customerId: otherId })).toThrow(/same party/);
    expect(() => sale(100, { isDebitNote: true, debitNoteOfId: credit.invoiceId })).toThrow(/not a credit note/);
    expect(() => sale(100, { isDebitNote: true, isCreditNote: true, debitNoteOfId: original.invoiceId })).toThrow(/not both/);
    expect(() => sale(100, { debitNoteOfId: original.invoiceId })).toThrow(/Only a debit note/);
  });
});

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
import { postDocumentAsInvoice } from './postDocument';
import { invoiceIssueDeadline } from './creditNotes';
import { invoiceConflicts } from './invoiceConflicts';
import type { AppDatabase } from '@/db';

/** Issue #209 part 3: credit notes against their original invoice (s.67), and the s.70 time limit. */

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
  root = mkdtempSync(join(tmpdir(), 'credit-notes-'));
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy Ltd', matchKey: 'murphy ltd', countryCode: 'IE' }).run();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function post(over: Partial<ReviewedDocumentValues> & { net: number; vat: number; rate: number | null }, treatment = 'IE_STD'): string {
  const { net, vat, rate, ...rest } = over;
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 7)}`,
    documentDate: '2026-03-10', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Murphy Ltd', supplierAddress: '1 Main St, Dublin', supplierVatNumber: 'IE6388047V', supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: '2 Quay St, Cork', customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: net, vatMinor: vat, grossMinor: net + vat, vatTotals: [],
    lines: [{ description: 'Paper', quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: rate, vatMinor: vat, grossMinor: net + vat }],
    ...rest,
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId,
    acknowledgedCheckCodes: ['vat_totals_missing', 'credit_note_without_original'],
  });
  return postDocumentAsInvoice(db, {
    companyId, documentId: stored.documentId, coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr[treatment]! }],
  }).invoiceId;
}
const findings = (invoiceId: string) => db.select().from(reviewItems)
  .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.entityId, invoiceId))).all()
  .map((r) => r.dedupeKey?.split(':').at(-1)).filter((k) => k?.startsWith('credit_note'));

describe('a credit note received', () => {
  it('is linked to the invoice it names, reduces the VAT in its own period, and raises nothing when it agrees', () => {
    const original = post({ invoiceNumber: 'INV-100', net: 10_000, vat: 2_300, rate: 2300 });
    const credit = post({ documentType: 'credit_note', invoiceNumber: 'CN-1', originalDocumentNumber: 'INV 100',
      documentDate: '2026-04-02', net: 2_000, vat: 460, rate: 2300 });
    const row = db.select().from(invoices).where(eq(invoices.id, credit)).get()!;
    expect(row.creditNoteOfId).toBe(original);
    const je = row.journalEntryId;
    const entries = db.select().from(vatEntries).all().filter((e) => e.journalEntryId === je);
    expect(entries.reduce((s, e) => s + e.recoverableVatMinor, 0)).toBe(-460);
    expect(entries.every((e) => e.taxPointDate === '2026-04-02')).toBe(true);
    expect(findings(credit)).toEqual([]);
  });

  it('naming no invoice, or one not posted: flagged', () => {
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: null, net: 1_000, vat: 230, rate: 2300 })))
      .toContain('credit_note_original_not_found');
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: 'NOPE-9', net: 1_000, vat: 230, rate: 2300 })))
      .toContain('credit_note_original_not_found');
  });

  it('more than is left on the original, after earlier credit notes: flagged', () => {
    post({ invoiceNumber: 'INV-200', net: 10_000, vat: 2_300, rate: 2300 });
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: 'INV-200', net: 6_000, vat: 1_380, rate: 2300 }))).toEqual([]);
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: 'INV-200', net: 6_000, vat: 1_380, rate: 2300 })))
      .toContain('credit_note_exceeds_original');
  });

  it('a rate the original did not charge (s.67(3)), or no VAT at all (s.67(5) or s.69(1)(b)): flagged', () => {
    post({ invoiceNumber: 'INV-300', net: 10_000, vat: 2_300, rate: 2300 });
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: 'INV-300', net: 1_000, vat: 135, rate: 1350 }, 'IE_RED')))
      .toContain('credit_note_rate_differs');
    expect(findings(post({ documentType: 'credit_note', originalDocumentNumber: 'INV-300', net: 1_000, vat: 0, rate: 0 }, 'IE_ZERO')))
      .toContain('credit_note_without_vat');
  });
});

describe('the time limit for issuing an invoice (s.70, reg.23)', () => {
  it('is 15 days after the end of the month of supply', () => {
    expect(invoiceIssueDeadline('2026-03-10')).toBe('2026-04-15');
    expect(invoiceIssueDeadline('2026-12-31')).toBe('2027-01-15');
  });
  it('a sales invoice issued later is a conflict', () => {
    const base = {
      direction: 'sales' as const, documentVatMinor: 2_300, lineVatMinor: [2_300], supplierVatNumber: null, customerVatNumber: null,
      companyVatNumber: null, counterpartyCountry: 'IE', counterpartyEstablishment: null, customerVies: null, legends: [],
    };
    expect(invoiceConflicts({ ...base, supplyDate: '2026-03-10', documentDate: '2026-04-20' }).map((c) => c.code)).toEqual(['invoice_issued_late']);
    expect(invoiceConflicts({ ...base, supplyDate: '2026-03-10', documentDate: '2026-04-15' })).toEqual([]);
  });
});

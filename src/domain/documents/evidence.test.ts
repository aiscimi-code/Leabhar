import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { storeDocument } from './storage';
import { confirmDocument, type ReviewedDocumentValues } from './review';
import { postDocumentAsInvoice } from '../consolidation/postDocument';
import { settleBankTransaction } from '../consolidation/settle';
import { documentEvidence } from './evidence';
import { bankTransactions, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * The evidence chain behind one document (issue #431). Every link must be
 * assembled from what was posted, never recomputed — so the test posts the
 * real thing and asserts the chain matches it.
 */
let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let bankAccountId: string;
let supplierId: string;
let root: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered',
    vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, { companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01' });
  supplierId = ids.supplier();
  db.insert(suppliers).values({
    id: supplierId, companyId, name: 'Murphy Office Supplies',
    matchKey: 'murphy office supplies', countryCode: 'IE', vatNumber: 'IE8254410U',
  }).run();
  root = mkdtempSync(join(tmpdir(), 'evidence-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const INVOICE_VALUES: ReviewedDocumentValues = {
  documentType: 'supplier_invoice', invoiceNumber: 'INV-1', documentDate: '2025-03-14',
  dueDate: null, supplyDate: null, currency: 'EUR',
  supplierNameStated: 'Murphy Office Supplies', supplierAddress: '1 Main Street',
  supplierVatNumber: 'IE6388047V', supplierCountry: 'IE',
  customerNameStated: 'Acme Ltd', customerAddress: '1 Acme Road, Dublin 1',
  customerVatNumber: null, customerCountry: 'IE',
  vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
  netMinor: 2_000, vatMinor: 460, grossMinor: 2_460,
  lines: [{
    description: 'Printer paper', quantity: null, unitPriceMinor: null,
    netMinor: 2_000, vatRateBasisPoints: 2300, vatMinor: 460, grossMinor: 2_460,
  }],
  vatTotals: [],
};

function postedAndSettled() {
  const stored = storeDocument(db, {
    companyId, filename: 'invoice.pdf', content: Buffer.from(`invoice-${Math.random()}`), root,
  });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values: INVOICE_VALUES, reviewedBy: 'joe',
    acknowledgedCheckCodes: [], supplierId, customerId: null,
  });
  const invoice = postDocumentAsInvoice(db, {
    companyId, documentId: stored.documentId,
    coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  });
  importStatement(db, {
    companyId, bankAccountId, filename: 's.csv',
    content: ['Date,Description,Amount', '20/03/2025,MURPHY,-24.60'].join(String.fromCharCode(10)),
    fileFormat: 'csv', columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  const bank = db.select().from(bankTransactions).where(eq(bankTransactions.description, 'MURPHY')).get()!;
  settleBankTransaction(db, {
    companyId, bankTransactionId: bank.id,
    allocations: [{ invoiceId: invoice.invoiceId, amountMinor: 2_460 }],
  });
  return { documentId: stored.documentId, invoiceId: invoice.invoiceId, bank };
}

describe('documentEvidence', () => {
  it('returns null for a document that is not there', () => {
    expect(documentEvidence(db, { companyId, documentId: 'doc_none' })).toBeNull();
  });

  it('chains document to invoice to journal to VAT entries to payment to bank line', () => {
    const { documentId, invoiceId, bank } = postedAndSettled();
    const evidence = documentEvidence(db, { companyId, documentId })!;

    expect(evidence.document.filename).toBe('invoice.pdf');
    expect(evidence.invoice).not.toBeNull();
    expect(evidence.invoice!.invoiceId).toBe(invoiceId);
    expect(evidence.invoice!.journalEntry).toMatchObject({ entryNumber: expect.any(Number), entryDate: '2025-03-14' });
    expect(evidence.invoice!.vatEntries).toHaveLength(1);
    expect(evidence.invoice!.vatEntries[0]).toMatchObject({
      direction: 'purchases', vatMinor: 460, recoverableVatMinor: 460, vatBox: 'T2',
    });
    expect(evidence.invoice!.payments).toHaveLength(1);
    expect(evidence.invoice!.payments[0]).toMatchObject({
      amountMinor: 2_460, allocatedMinor: 2_460,
      bankTransaction: { id: bank.id, description: 'MURPHY' },
    });
  });

  it('names the document it duplicates and the duplicates pointing at it', () => {
    const first = storeDocument(db, {
      companyId, filename: 'original.pdf', content: Buffer.from('same bytes'), root,
    });
    const second = storeDocument(db, {
      companyId, filename: 'copy.pdf', content: Buffer.from('same bytes'), root,
    });
    const evidence = documentEvidence(db, { companyId, documentId: second.documentId })!;
    expect(evidence.duplicateOf).toMatchObject({ id: first.documentId, filename: 'original.pdf' });

    const ofFirst = documentEvidence(db, { companyId, documentId: first.documentId })!;
    expect(ofFirst.duplicates).toHaveLength(1);
    expect(ofFirst.duplicates[0]).toMatchObject({ id: second.documentId, filename: 'copy.pdf' });
  });

  it('shows a stored document that nothing rests on yet', () => {
    const stored = storeDocument(db, {
      companyId, filename: 'loose.pdf', content: Buffer.from('loose'), root,
    });
    const evidence = documentEvidence(db, { companyId, documentId: stored.documentId })!;
    expect(evidence.invoice).toBeNull();
    expect(evidence.linkedTransaction).toBeNull();
    expect(evidence.matches).toEqual([]);
  });
});

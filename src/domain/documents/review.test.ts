import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { storeDocument } from './storage';
import { extractDocument } from '../extraction/service';
import { LocalExtractionProvider } from '../extraction/localProvider';
import {
  checkDocumentValues, confirmDocument, rejectDocument, reopenDocument, documentReviewValues,
  DocumentReviewError, type ReviewedDocumentValues,
} from './review';
import { findMatchesForDocument, linkDocument, matchAllUnmatched, unmatchDocument } from '../matching/service';
import { transactionFacts } from '../rules/vatSuggestion';
import {
  documents, documentLines, documentVatTotals, auditEvents, reviewItems, suppliers, bankTransactions,
} from '@/db/schema';
import type { AppDatabase } from '@/db';

const INVOICE = [
  'Byrne Accountancy Services Limited',
  '14 Fitzwilliam Square, Dublin 2, Ireland',
  'VAT Number: IE9876543W',
  '',
  'INVOICE',
  'Invoice Number: BAS-2025-0044',
  'Invoice Date: 14/03/2025',
  '',
  'Annual accounts preparation      1   400.00   23%    92.00   492.00',
  'Printed stationery               1   100.00   23%    23.00   123.00',
  'Subtotal                               500.00',
  'VAT @ 23%                              115.00',
  'Total Due                              615.00',
  'Currency: EUR',
].join('\n');

let db: AppDatabase;
let companyId: string;
let root: string;

beforeEach(async () => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  const bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
  });
  root = mkdtempSync(join(tmpdir(), 'review-'));
  await importStatement(db, {
    companyId, bankAccountId, filename: 'statement.csv',
    content: ['Date,Description,Amount', '20/03/2025,BYRNE ACCOUNTANCY,-615.00'].join('\n'),
    fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function ingest(text = INVOICE): Promise<string> {
  const stored = storeDocument(db, { companyId, filename: `inv-${Math.random()}.txt`, content: Buffer.from(text), root });
  await extractDocument(db, {
    companyId, documentId: stored.documentId, storageRootPath: root, providers: [new LocalExtractionProvider()],
  });
  return stored.documentId;
}

const doc = (id: string) => db.select().from(documents).where(eq(documents.id, id)).get()!;

const base = (over: Partial<ReviewedDocumentValues> = {}): ReviewedDocumentValues => ({
  documentType: 'supplier_invoice', invoiceNumber: 'X-1', documentDate: '2025-03-14', dueDate: null,
  supplyDate: null, currency: 'EUR', supplierNameStated: 'Supplier Ltd', supplierAddress: null,
  supplierVatNumber: null, supplierCountry: 'IE', customerNameStated: null, customerAddress: null,
  customerVatNumber: null, customerCountry: null, vatLegends: [], paymentTerms: null,
  originalDocumentNumber: null, netMinor: 10_000, vatMinor: 2_300, grossMinor: 12_300,
  lines: [{ description: 'Item', quantity: '1', unitPriceMinor: 10_000, netMinor: 10_000, vatRateBasisPoints: 2300, vatMinor: 2_300, grossMinor: 12_300 }],
  vatTotals: [{ rateBasisPoints: 2300, label: '23%', netMinor: 10_000, vatMinor: 2_300 }],
  ...over,
});

describe('checkDocumentValues', () => {
  it('passes a consistent invoice', () => {
    expect(checkDocumentValues(base())).toEqual([]);
  });

  it('refuses a document with no date, total, currency or supplier', () => {
    const codes = checkDocumentValues(base({
      documentDate: null, grossMinor: null, currency: null, supplierNameStated: null,
    })).filter((c) => c.severity === 'error').map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['missing_date', 'missing_total', 'missing_currency', 'missing_party']));
  });

  it('asks a sales invoice for its customer, not a supplier', () => {
    const codes = checkDocumentValues(base({ documentType: 'sales_invoice', customerNameStated: null }))
      .map((c) => c.code);
    expect(codes).toContain('missing_party');
    expect(checkDocumentValues(base({ documentType: 'sales_invoice', customerNameStated: 'Client Ltd' }))
      .map((c) => c.code)).not.toContain('missing_party');
  });

  it('flags net + VAT that does not make the total', () => {
    expect(checkDocumentValues(base({ grossMinor: 12_400 })).map((c) => c.code)).toContain('header_net_vat_gross');
  });

  it('flags a line whose VAT is not its rate of its net, but tolerates a cent of rounding', () => {
    const line = { description: 'Item', quantity: null, unitPriceMinor: null, netMinor: 10_000, vatRateBasisPoints: 2300, grossMinor: null };
    expect(checkDocumentValues(base({ lines: [{ ...line, vatMinor: 2_301 }] })).map((c) => c.code)).not.toContain('line_1_vat');
    expect(checkDocumentValues(base({ lines: [{ ...line, vatMinor: 1_350 }] })).map((c) => c.code)).toContain('line_1_vat');
  });

  it('flags lines that do not add up to the header', () => {
    const codes = checkDocumentValues(base({ netMinor: 11_000, grossMinor: 13_300 })).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['lines_net_sum', 'vat_totals_net_sum']));
  });

  it('warns on a credit note that does not say what it credits', () => {
    expect(checkDocumentValues(base({ documentType: 'credit_note' })).map((c) => c.code))
      .toContain('credit_note_without_original');
  });

  it('rejects an impossible date', () => {
    expect(checkDocumentValues(base({ documentDate: '2025-02-30' })).map((c) => c.code)).toContain('invalid_documentDate');
  });
});

describe('extraction writes a draft, never a confirmed document', () => {
  it('stores every line and VAT total and puts the document up for confirmation', async () => {
    const id = await ingest();
    const d = doc(id);
    expect(d.reviewStatus).toBe('unreviewed');
    expect(d.grossMinor).toBe(61_500);
    expect(d.supplierNameStated).toBe('Byrne Accountancy Services Limited');
    expect(d.supplierVatNumber).toBe('IE9876543W');

    const lines = db.select().from(documentLines).where(eq(documentLines.documentId, id))
      .orderBy(documentLines.lineNumber).all();
    expect(lines.map((l) => [l.description, l.netMinor, l.vatRateBasisPoints, l.vatMinor, l.grossMinor])).toEqual([
      ['Annual accounts preparation', 40_000, 2300, 9_200, 49_200],
      ['Printed stationery', 10_000, 2300, 2_300, 12_300],
    ]);
    expect(lines.every((l) => l.provenanceStatus !== 'user_confirmed')).toBe(true);
    expect(db.select().from(documentVatTotals).where(eq(documentVatTotals.documentId, id)).all()
      .map((t) => [t.rateBasisPoints, t.vatMinor])).toEqual([[2300, 11_500]]);

    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `document:${id}:awaiting_confirmation`)).get();
    expect(item?.status).toBe('open');
  });

  it('does not create a supplier from an unconfirmed read', async () => {
    await ingest();
    expect(db.select().from(suppliers).where(eq(suppliers.companyId, companyId)).all()).toHaveLength(0);
  });

  it('never overwrites a confirmed document when re-read', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    confirmDocument(db, { companyId, documentId: id, values: { ...values, invoiceNumber: 'CORRECTED' }, reviewedBy: 'joe' });
    await extractDocument(db, {
      companyId, documentId: id, storageRootPath: root, providers: [new LocalExtractionProvider()],
    });
    expect(doc(id).invoiceNumber).toBe('CORRECTED');
    expect(doc(id).reviewStatus).toBe('confirmed');
  });
});

describe('confirmDocument', () => {
  it('records the confirmation, the corrections and the person', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    const result = confirmDocument(db, {
      companyId, documentId: id, reviewedBy: 'joe', createSupplier: true,
      values: { ...values, paymentTerms: 'Net 30' },
    });
    expect(result.changedFields).toEqual(['paymentTerms']);

    const d = doc(id);
    expect(d.reviewStatus).toBe('confirmed');
    expect(d.reviewedBy).toBe('joe');
    expect(d.provenanceStatus).toBe('user_confirmed');
    expect(d.paymentTerms).toBe('Net 30');
    expect(db.select().from(documentLines).where(eq(documentLines.documentId, id)).all()
      .every((l) => l.provenanceStatus === 'user_confirmed')).toBe(true);

    const audit = db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), eq(auditEvents.entityType, 'document'))).all();
    const correction = audit.find((a) => a.field === 'paymentTerms');
    expect(correction?.reason).toBe('Corrected at confirmation');
    expect(audit.some((a) => a.action === 'user_confirmed' && a.actor === 'joe')).toBe(true);

    const supplier = db.select().from(suppliers).where(eq(suppliers.id, result.supplierId!)).get()!;
    expect(supplier.name).toBe('Byrne Accountancy Services Limited');
    expect(db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `document:${id}:awaiting_confirmation`)).get()?.status).toBe('resolved');
  });

  it('refuses while an error remains', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    expect(() => confirmDocument(db, {
      companyId, documentId: id, reviewedBy: 'joe', values: { ...values, currency: null },
    })).toThrow(DocumentReviewError);
    expect(doc(id).reviewStatus).toBe('unreviewed');
  });

  it('refuses an unacknowledged warning, and accepts it once acknowledged', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    const bad = { ...values, grossMinor: 61_600 };
    expect(() => confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values: bad }))
      .toThrow(/acknowledged/);
    const codes = checkDocumentValues(bad).map((c) => c.code);
    confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values: bad, acknowledgedCheckCodes: codes });
    expect(doc(id).reviewStatus).toBe('confirmed');
  });

  it('refuses a fractional amount', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    expect(() => confirmDocument(db, {
      companyId, documentId: id, reviewedBy: 'joe', values: { ...values, grossMinor: 615.5 },
    })).toThrow(/whole number/);
  });

  it('refuses to confirm twice', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values });
    expect(() => confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values }))
      .toThrow(/already confirmed/);
  });
});

describe('nothing downstream uses an unconfirmed document', () => {
  it('matching refuses a draft', async () => {
    const id = await ingest();
    expect(() => findMatchesForDocument(db, { companyId, documentId: id })).toThrow(/has not been confirmed/);
  });

  it('a manual link refuses a draft', async () => {
    const id = await ingest();
    const tx = db.select().from(bankTransactions).get()!;
    expect(() => linkDocument(db, { companyId, documentId: id, bankTransactionId: tx.id }))
      .toThrow(/has not been confirmed/);
    expect(doc(id).matchedTransactionId).toBeNull();
  });

  it('match-all skips drafts and matches confirmed documents', async () => {
    const id = await ingest();
    expect(matchAllUnmatched(db, { companyId }).processed).toBe(0);
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values, createSupplier: true });
    expect(matchAllUnmatched(db, { companyId }).processed).toBe(1);
  });

  it('a VAT suggestion ignores a matched document that is no longer confirmed', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values, createSupplier: true });
    const tx = db.select().from(bankTransactions).get()!;
    linkDocument(db, { companyId, documentId: id, bankTransactionId: tx.id });
    expect(transactionFacts(db, { companyId, bankTransactionId: tx.id })!.factSources.invoiceAvailable)
      .toMatch(/confirmed document/);

    // Bypass the domain to simulate a stale draft still linked: the facts must not use it.
    db.update(documents).set({ reviewStatus: 'unreviewed' }).where(eq(documents.id, id)).run();
    expect(transactionFacts(db, { companyId, bankTransactionId: tx.id })!.factSources.invoiceAvailable)
      .toBe('no confirmed matched document');
  });
});

describe('reject and reopen', () => {
  it('rejects with a reason and keeps the file', async () => {
    const id = await ingest();
    expect(() => rejectDocument(db, { companyId, documentId: id, reviewedBy: 'joe', reason: ' ' })).toThrow();
    rejectDocument(db, { companyId, documentId: id, reviewedBy: 'joe', reason: 'Not our invoice' });
    const d = doc(id);
    expect(d.reviewStatus).toBe('rejected');
    expect(d.reviewNote).toBe('Not our invoice');
    expect(d.sha256).toBeTruthy();
  });

  it('reopens a confirmed document for correction, but not while it is matched', async () => {
    const id = await ingest();
    const { values } = documentReviewValues(db, { companyId, documentId: id });
    confirmDocument(db, { companyId, documentId: id, reviewedBy: 'joe', values, createSupplier: true });
    const tx = db.select().from(bankTransactions).get()!;
    linkDocument(db, { companyId, documentId: id, bankTransactionId: tx.id });
    expect(() => reopenDocument(db, { companyId, documentId: id, reviewedBy: 'joe', reason: 'typo' }))
      .toThrow(/Unmatch it first/);

    unmatchDocument(db, { companyId, documentId: id, reason: 'fixing a typo' });
    reopenDocument(db, { companyId, documentId: id, reviewedBy: 'joe', reason: 'typo' });
    expect(doc(id).reviewStatus).toBe('unreviewed');
    expect(db.select().from(reviewItems)
      .where(and(eq(reviewItems.dedupeKey, `document:${id}:awaiting_confirmation`), eq(reviewItems.status, 'open')))
      .get()).toBeTruthy();
  });
});

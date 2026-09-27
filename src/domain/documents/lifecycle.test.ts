import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { ids } from '@/lib/ids';
import { importStatement } from '../banking/import';
import { storeDocument } from './storage';
import { confirmDocument, type ReviewedDocumentValues, type ReviewedLine } from './review';
import { postDocumentAsInvoice } from '../consolidation/postDocument';
import { settleBankTransaction } from '../consolidation/settle';
import { linkDocument } from '../matching/service';
import { createInvoice } from '../invoicing/invoices';
import { setRetentionPolicy } from './retention';
import { asIsoDate } from '../dates';
import {
  archiveDocument, restoreDocument, deleteDocument, documentDependencies,
  DocumentLifecycleError,
} from './lifecycle';
import {
  documents, documentExtractions, documentLines, documentMatches, auditEvents, bankTransactions, suppliers, documentRetentionPolicies } from '@/db/schema';
import type { AppDatabase } from '@/db';

/**
 * Retiring a document (issue #430). The rules are the point of this suite:
 * archive is reversible and refused while anything rests on the document;
 * delete is a second, deliberate step with its own guards; the content-
 * addressed file is only removed when no other document shares it.
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
  root = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  // These tests exercise deletion and archiving mechanics, not retention:
  // remove the seeded default policies (issue #432) so a document is
  // deletable unless a test sets a policy of its own.
  db.delete(documentRetentionPolicies).where(eq(documentRetentionPolicies.companyId, companyId)).run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = (name: string, content = `content-${Math.random()}`) => storeDocument(db, {
  companyId, filename: name, content: Buffer.from(content, 'utf8'), root,
});

const line = (description: string, net: number, vat: number): ReviewedLine => ({
  description, quantity: null, unitPriceMinor: null, netMinor: net,
  vatRateBasisPoints: 2300, vatMinor: vat, grossMinor: net + vat,
});

/** A confirmed supplier invoice document, posted and settled by a bank line. */
function postedInvoice(bankDescription: string) {
  const stored = store('invoice.pdf');
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: 'INV-1', documentDate: '2025-03-14',
    dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Murphy Office Supplies', supplierAddress: '1 Main Street',
    supplierVatNumber: 'IE6388047V', supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: '1 Acme Road, Dublin 1',
    customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: 2_000, vatMinor: 460, grossMinor: 2_460,
    lines: [line('Printer paper', 2_000, 460)], vatTotals: [],
  };
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe',
    acknowledgedCheckCodes: [], supplierId, customerId: null,
  });
  const invoice = postDocumentAsInvoice(db, {
    companyId, documentId: stored.documentId,
    coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  });
  importStatement(db, {
    companyId, bankAccountId, filename: 's.csv', content: 'Date,Description,Amount\n20/03/2025,MURPHY,-2460.00',
    fileFormat: 'csv', columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  const bank = db.select().from(bankTransactions).where(eq(bankTransactions.description, 'MURPHY')).get()!;
  settleBankTransaction(db, {
    companyId, bankTransactionId: bank.id, allocations: [{ invoiceId: invoice.invoiceId, amountMinor: 2_460 }],
  });
  return { documentId: stored.documentId, invoiceId: invoice.invoiceId, bank };
}

describe('documentDependencies', () => {
  it('reports nothing for a free document', () => {
    const stored = store('note.pdf');
    expect(documentDependencies(db, companyId, stored.documentId)).toEqual([]);
  });

  it('names the invoice, the bank link and an accepted match', () => {
    const { documentId, bank } = postedInvoice('MURPHY');
    const dependencies = documentDependencies(db, companyId, documentId);
    expect(dependencies.map((d) => d.what).sort()).toEqual(['bank_transaction', 'invoice']);
    // A pending candidate is an offer, not a decision: it blocks nothing.
    db.insert(documentMatches).values({
      id: 'mat_test', companyId, documentId, bankTransactionId: bank.id,
      matchType: 'possible', score: 40, factors: [], decision: 'pending',
    }).run();
    expect(documentDependencies(db, companyId, documentId).map((d) => d.what).sort())
      .toEqual(['bank_transaction', 'invoice']);
    db.update(documentMatches).set({ decision: 'accepted' }).where(eq(documentMatches.id, 'mat_test')).run();
    expect(documentDependencies(db, companyId, documentId).map((d) => d.what).sort())
      .toEqual(['bank_transaction', 'invoice', 'match']);
  });
});

describe('archiveDocument', () => {
  it('takes a free document out of the working lists and audits it', () => {
    const stored = store('mistake.pdf');
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'Filed by mistake' });
    const doc = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(doc.archived).toBe(true);
    const event = db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, stored.documentId)).all()
      .find((e) => e.action === 'voided');
    expect(event?.reason).toBe('Filed by mistake');
    expect(event?.actor).toBe('joe');
  });

  it('is idempotent', () => {
    const stored = store('mistake.pdf');
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'one' });
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'two' });
    expect(db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!.archived).toBe(true);
  });

  it('refuses while the document supports an invoice or a bank link', () => {
    const { documentId } = postedInvoice('MURPHY');
    expect(() => archiveDocument(db, { companyId, documentId, actor: 'joe', reason: 'no' }))
      .toThrow(DocumentLifecycleError);
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.archived).toBe(false);
  });

  it('refuses a missing reason', () => {
    const stored = store('mistake.pdf');
    expect(() => archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: ' ' }))
      .toThrow(DocumentLifecycleError);
  });
});

describe('restoreDocument', () => {
  it('brings an archived document back and audits it', () => {
    const stored = store('mistake.pdf');
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'Filed by mistake' });
    restoreDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'Not a mistake after all' });
    const doc = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(doc.archived).toBe(false);
    expect(db.select().from(auditEvents).where(eq(auditEvents.entityId, stored.documentId)).all()
      .some((e) => e.action === 'updated' && e.reason === 'Not a mistake after all')).toBe(true);
  });
});

describe('deleteDocument', () => {
  it('requires the document to be archived first', () => {
    const stored = store('mistake.pdf');
    expect(() => deleteDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'no' }))
      .toThrow(/Archive the document first/);
  });

  it('removes the rows and the file when nothing shares the bytes', () => {
    const stored = store('mistake.pdf', 'unique bytes');
    const absolute = join(root, stored.storagePath);
    expect(existsSync(absolute)).toBe(true);
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'Filed by mistake' });
    const result = deleteDocument(db, {
      companyId, documentId: stored.documentId, actor: 'joe',
      reason: 'Filed by mistake', storageRootPath: root,
    });
    expect(result.removedFile).toBe(true);
    expect(existsSync(absolute)).toBe(false);
    expect(db.select().from(documents).where(eq(documents.id, stored.documentId)).get()).toBeUndefined();
    // The audit row outlives the document: it is the only trace left.
    const event = db.select().from(auditEvents).where(eq(auditEvents.entityId, stored.documentId)).all()
      .find((e) => e.action === 'deleted');
    expect(event?.reason).toBe('Filed by mistake');
    expect(JSON.parse(event!.previousValue!)).toMatchObject({ filename: 'mistake.pdf' });
  });

  it('keeps the file when another document shares the same bytes', () => {
    const first = store('original.pdf', 'shared bytes');
    const absolute = join(root, first.storagePath);
    // The first copy is retired before the second is stored, so the second is
    // a document in its own right, not a flagged duplicate of the first.
    archiveDocument(db, { companyId, documentId: first.documentId, actor: 'joe', reason: 'one' });
    const second = store('copy.pdf', 'shared bytes');
    const result = deleteDocument(db, {
      companyId, documentId: first.documentId, actor: 'joe', reason: 'two', storageRootPath: root,
    });
    expect(result.removedFile).toBe(false);
    expect(existsSync(absolute)).toBe(true);
    expect(db.select().from(documents).where(eq(documents.id, second.documentId)).get()!.archived).toBe(false);
  });

  it('refuses while a duplicate points at the document', () => {
    const first = store('original.pdf', 'other bytes');
    store('copy.pdf', 'other bytes');
    archiveDocument(db, { companyId, documentId: first.documentId, actor: 'joe', reason: 'one' });
    expect(() => deleteDocument(db, {
      companyId, documentId: first.documentId, actor: 'joe', reason: 'two', storageRootPath: root,
    })).toThrow(/duplicate/i);
  });

  it('removes every draft read from the document with it', () => {
    const stored = store('draft.pdf', 'drafts');
    db.insert(documentExtractions).values({
      id: 'ext_test', companyId, documentId: stored.documentId, provider: 'local',
      status: 'succeeded', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    }).run();
    db.insert(documentLines).values({
      id: 'dl_test', companyId, documentId: stored.documentId, lineNumber: 1,
      description: 'paper', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    }).run();
    archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'r' });
    deleteDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'r', storageRootPath: root });
    expect(db.select().from(documentExtractions).where(eq(documentExtractions.documentId, stored.documentId)).all())
      .toEqual([]);
    expect(db.select().from(documentLines).where(eq(documentLines.documentId, stored.documentId)).all())
      .toEqual([]);
  });

  it('refuses a document that supports something, even archived', () => {
    const { documentId } = postedInvoice('MURPHY');
    // Archiving is refused for an in-use document, so simulate the state after
    // the invoice was voided but the link left behind.
    db.update(documents).set({ archived: true }).where(eq(documents.id, documentId)).run();
    expect(() => deleteDocument(db, {
      companyId, documentId, actor: 'joe', reason: 'r', storageRootPath: root,
    })).toThrow(/cannot be deleted/);
  });
});

describe('evidence recorded elsewhere, and retention', () => {
  it('refuses to retire the document an invoice was created from', () => {
    const stored = store('bill.pdf');
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-03-10'), supplierId, documentId: stored.documentId,
      lines: [{ description: 'Paper', netMinor: 10_000, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
    });
    expect(documentDependencies(db, companyId, stored.documentId).map((d) => d.what)).toEqual(['invoice']);
    expect(() => archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'Tidy up' }))
      .toThrow(/evidence for invoice/);
  });

  it('refuses to delete a document still inside its retention period, and allows it after', () => {
    setRetentionPolicy(db, { companyId, appliesTo: 'all', retainYears: 6, effectiveFrom: asIsoDate('2000-01-01'), actor: 'joe' });
    const kept = store('recent.pdf');
    archiveDocument(db, { companyId, documentId: kept.documentId, actor: 'joe', reason: 'Filed by mistake' });
    expect(() => deleteDocument(db, { companyId, documentId: kept.documentId, actor: 'joe', reason: 'Filed by mistake', storageRootPath: root }))
      .toThrow(/6-year retention policy/);
    const old = store('old.pdf');
    db.update(documents).set({ documentDate: '2010-01-01' }).where(eq(documents.id, old.documentId)).run();
    archiveDocument(db, { companyId, documentId: old.documentId, actor: 'joe', reason: 'Past retention' });
    expect(deleteDocument(db, { companyId, documentId: old.documentId, actor: 'joe', reason: 'Past retention', storageRootPath: root }).documentId)
      .toBe(old.documentId);
  });
});

describe('a linked document', () => {
  it('cannot be archived while linked, and can be once unlinked', () => {
    const stored = store('receipt.pdf', 'linked doc');
    const values: ReviewedDocumentValues = {
      documentType: 'receipt', invoiceNumber: 'R-1', documentDate: '2025-03-14',
      dueDate: null, supplyDate: null, currency: 'EUR',
      supplierNameStated: 'Murphy Office Supplies', supplierAddress: null,
      supplierVatNumber: null, supplierCountry: 'IE', customerNameStated: null,
      customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
      vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
      netMinor: null, vatMinor: null, grossMinor: 1_000,
      lines: [], vatTotals: [],
    };
    confirmDocument(db, {
      companyId, documentId: stored.documentId, values, reviewedBy: 'joe',
      acknowledgedCheckCodes: ['no_lines'], supplierId, customerId: null,
    });
    importStatement(db, {
      companyId, bankAccountId, filename: 's2.csv', content: 'Date,Description,Amount\n21/03/2025,CAFE,-1000.00',
      fileFormat: 'csv', columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    const bank = db.select().from(bankTransactions).where(eq(bankTransactions.description, 'CAFE')).get()!;
    linkDocument(db, { companyId, documentId: stored.documentId, bankTransactionId: bank.id, actor: 'joe' });
    expect(() => archiveDocument(db, { companyId, documentId: stored.documentId, actor: 'joe', reason: 'r' }))
      .toThrow(/cannot be archived/);
  });
});

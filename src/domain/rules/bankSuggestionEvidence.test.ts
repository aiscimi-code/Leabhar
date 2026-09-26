import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { documents } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestVatTreatment } from './vatSuggestion';
import type { AppDatabase } from '@/db';

/**
 * Issue #206: a bank line's statutory suggestion reads the confirmed invoice's
 * own lines when there is one, and says when it rests on the bank words alone.
 */

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let root: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Evidence Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026],
  });
  companyId = created.companyId;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01',
    accountId: created.accountsByKey['bank_control']!,
  });
  loadStatutoryKnowledgeBase(db, { companyId });
  root = mkdtempSync(join(tmpdir(), 'bank-evidence-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tx = (description: string, amountMinor: number) => insertTestBankTransaction(db, {
  companyId, bankAccountId, transactionDate: '2026-03-15', description, amountMinor,
});

function invoiceFor(bankTransactionId: string, lineDescription: string, confirm: boolean): void {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `P-${Math.random().toString(36).slice(2, 7)}`,
    documentDate: '2026-03-01', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Allied Cover', supplierAddress: null, supplierVatNumber: null, supplierCountry: 'IE',
    customerNameStated: 'Evidence Ltd', customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: 60_000, vatMinor: null, grossMinor: 60_000, vatTotals: [],
    lines: [{ description: lineDescription, quantity: null, unitPriceMinor: null, netMinor: 60_000, vatRateBasisPoints: null, vatMinor: null, grossMinor: 60_000 }],
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  if (confirm) {
    confirmDocument(db, {
      companyId, documentId: stored.documentId, values, reviewedBy: 'joe', createSupplier: true,
      acknowledgedCheckCodes: ['missing_supplier_vat_number', 'no_supplier_vat_number', 'vat_totals_missing', 'no_vat_stated'],
    });
  }
  db.update(documents).set({ matchedTransactionId: bankTransactionId }).where(eq(documents.id, stored.documentId)).run();
}

describe('the evidence a bank line\'s VAT suggestion reads', () => {
  it('with a confirmed invoice, reads its lines, not the bank narrative', () => {
    const id = tx('DD ALLIED 88213', -60_000);
    invoiceFor(id, 'Public liability insurance premium 2026', true);
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: id })!;
    expect(s.decidingRule?.ruleKey).toBe('vat.exempt_insurance');
    expect(s.factSources.description).toMatch(/line\(s\) of confirmed invoice/);
    expect(s.reviewReasons.join(' ')).toMatch(/coded line by line when it is posted/);
  });

  it('a draft (unconfirmed) invoice is not evidence: the bank words are used, and it says so', () => {
    const id = tx('DD ALLIED 88214', -60_000);
    invoiceFor(id, 'Public liability insurance premium 2026', false);
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: id })!;
    expect(s.decidingRule?.ruleKey).not.toBe('vat.exempt_insurance');
    expect(s.factSources.description).toMatch(/bank description/);
    expect(s.reviewReasons.join(' ')).toMatch(/No confirmed invoice: this rests on the bank description alone/);
  });

  it('a bank-only line (wages) keeps its bank-level rule, and is still flagged for confirmation', () => {
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('Salaries March', -300_000) })!;
    expect(s.treatment?.code).toBe('OUT_OF_SCOPE');
    expect(s.reviewRequired).toBe(true);
    expect(s.reviewReasons.join(' ')).toMatch(/No confirmed invoice/);
  });
});

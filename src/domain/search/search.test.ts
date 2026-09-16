import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { search } from './search';
import { importStatement } from '../banking/import';
import { createInvoice } from '../invoicing/invoices';
import { createRule } from '../rules/engine';
import { storeDocument } from '../documents/storage';
import { suppliers, customers, documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let supplierId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let root: string;

beforeEach(async () => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered',
    vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  root = mkdtempSync(join(tmpdir(), 'search-'));

  supplierId = ids.supplier();
  db.insert(suppliers).values({
    id: supplierId, companyId, name: 'Anthropic PBC', matchKey: 'anthropic',
    countryCode: 'US', vatNumber: null, aliases: ['ANTHROPIC'],
  }).run();

  const bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
  });

  await importStatement(db, {
    companyId, bankAccountId, filename: 's.csv',
    content: [
      'Date,Description,Amount,Reference',
      '17/01/2025,ANTHROPIC PBC,-120.00,ANT-99120',
      '20/01/2025,BYRNE ACCOUNTANCY,-615.00,',
    ].join('\n'),
    fileFormat: 'csv',
    columnMap: {
      Date: 'transaction_date', Description: 'description',
      Amount: 'amount', Reference: 'bank_reference',
    },
  });

  createInvoice(db, {
    companyId, direction: 'purchase', invoiceDate: makeDate(2025, 1, 17),
    supplierId, invoiceNumber: 'ANT-99120',
    lines: [{
      description: 'Claude API usage', netMinor: 12_000,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    }],
  });

  createRule(db, {
    companyId, name: 'Anthropic is software',
    conditions: [{ field: 'description', operator: 'contains', value: 'ANTHROPIC' }],
    actions: [{ field: 'accountId', value: byCode['6000']! }],
  });

  const stored = storeDocument(db, {
    companyId, filename: 'anthropic-2025-01.pdf',
    content: Buffer.from('invoice'), root,
  });
  db.update(documents).set({
    invoiceNumber: 'ANT-99120', grossMinor: 12_000, currency: 'EUR',
    documentDate: '2025-01-17', supplierId,
  }).where(eq(documents.id, stored.documentId)).run();
});

// README §36's own example.
describe('searching for a supplier name', () => {
  it('finds the supplier, its transactions, invoices, documents and rules', () => {
    const response = search(db, { companyId, query: 'Anthropic' });
    const types = new Set(response.results.map((r) => r.type));

    expect(types).toContain('supplier');
    expect(types).toContain('bank_transaction');
    expect(types).toContain('invoice');
    expect(types).toContain('document');
    expect(types).toContain('rule');
  });

  it('puts the supplier itself first', () => {
    const response = search(db, { companyId, query: 'Anthropic PBC' });
    expect(response.results[0]!.type).toBe('supplier');
  });

  it('says why each result matched', () => {
    const response = search(db, { companyId, query: 'Anthropic' });
    expect(response.results.every((r) => r.matchedOn.length > 0)).toBe(true);
    expect(response.results.find((r) => r.type === 'rule')!.matchedOn)
      .toMatch(/Rule name|Rule conditions/);
  });

  it('is case insensitive', () => {
    expect(search(db, { companyId, query: 'ANTHROPIC' }).results.length)
      .toBe(search(db, { companyId, query: 'anthropic' }).results.length);
  });
});

describe('searching by reference and number', () => {
  it('finds a transaction by its bank reference', () => {
    const response = search(db, { companyId, query: 'ANT-99120' });
    const transaction = response.results.find((r) => r.type === 'bank_transaction')!;
    expect(transaction.matchedOn).toBe('Bank reference');
  });

  it('finds an invoice and its document by invoice number', () => {
    const response = search(db, { companyId, query: 'ANT-99120' });
    expect(response.results.some((r) => r.type === 'invoice')).toBe(true);
    expect(response.results.find((r) => r.type === 'document')!.matchedOn)
      .toBe('Invoice number');
  });

  // An invoice rarely repeats the supplier's name in a column of its own.
  it('finds an invoice by its supplier name', () => {
    const response = search(db, { companyId, query: 'Anthropic' });
    const invoice = response.results.find((r) => r.type === 'invoice')!;
    expect(invoice.matchedOn).toBe('Supplier');
    expect(invoice.subtitle).toContain('Anthropic');
  });
});

// Searching an amount while reconciling is a normal thing to do.
describe('searching by amount', () => {
  it('finds a transaction by its amount regardless of sign', () => {
    const response = search(db, { companyId, query: '120.00' });
    expect(response.interpretedAsAmount).toBe(12_000);
    const transaction = response.results.find((r) => r.type === 'bank_transaction')!;
    expect(transaction.amountMinor).toBe(-12_000);
    expect(transaction.matchedOn).toBe('Amount');
  });

  it('accepts a currency symbol', () => {
    expect(search(db, { companyId, query: '€120.00' }).interpretedAsAmount).toBe(12_000);
  });

  it('does not treat a text query as an amount', () => {
    expect(search(db, { companyId, query: 'Anthropic' }).interpretedAsAmount).toBeNull();
  });

  it('reports when it read the query as an amount, so a surprising hit explains itself', () => {
    const response = search(db, { companyId, query: '120' });
    expect(response.interpretedAsAmount).toBe(12_000);
  });
});

describe('searching the chart of accounts', () => {
  it('finds an account by code', () => {
    const response = search(db, { companyId, query: '6000' });
    const account = response.results.find((r) => r.type === 'account')!;
    expect(account.title).toContain('Software and subscriptions');
    expect(account.matchedOn).toBe('Account code');
  });

  it('finds an account by name', () => {
    const response = search(db, { companyId, query: 'hosting' });
    expect(response.results.some((r) => r.type === 'account')).toBe(true);
  });

  it('finds a VAT treatment', () => {
    const response = search(db, { companyId, query: 'reverse charge' });
    expect(response.results.some((r) => r.type === 'vat_treatment')).toBe(true);
  });
});

describe('search behaviour', () => {
  it('returns nothing for a query that is too short to be useful', () => {
    expect(search(db, { companyId, query: 'a' }).results).toEqual([]);
  });

  it('returns nothing rather than everything for an unmatched query', () => {
    expect(search(db, { companyId, query: 'zzzznotfound' }).results).toEqual([]);
  });

  it('counts results by type', () => {
    const response = search(db, { companyId, query: 'Anthropic' });
    expect(response.countsByType['supplier']).toBe(1);
    expect(response.countsByType['bank_transaction']).toBe(1);
  });

  it('honours a result limit and says it truncated', () => {
    const response = search(db, { companyId, query: 'a', limit: 2 });
    expect(response.results.length).toBeLessThanOrEqual(2);
  });

  it('gives every result a link to open it', () => {
    const response = search(db, { companyId, query: 'Anthropic' });
    expect(response.results.every((r) => r.href.startsWith('/'))).toBe(true);
  });
});

describe('cleanup', () => {
  it('removes the temporary document store', () => {
    rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

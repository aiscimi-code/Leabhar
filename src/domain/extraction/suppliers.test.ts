import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { storeDocument } from '@/domain/documents/storage';
import { createSupplierFromExtraction, normaliseName } from './service';
import { suppliers, documents, auditEvents } from '@/db/schema';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let root: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  root = mkdtempSync(join(tmpdir(), 'sup-'));
});

describe('createSupplierFromExtraction', () => {
  it('creates a supplier from an extracted name with an audit trail', () => {
    const { supplierId, created } = createSupplierFromExtraction(db, {
      companyId, name: 'Vercel Inc', countryCode: 'US',
    });

    expect(created).toBe(true);
    const supplier = db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get()!;
    expect(supplier.name).toBe('Vercel Inc');
    expect(supplier.matchKey).toBe(normaliseName('Vercel Inc'));
    expect(supplier.countryCode).toBe('US');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, supplierId)).get()!;
    expect(audit.action).toBe('created');
    expect(audit.source).toBe('ai');
    expect(audit.reason).toContain('extraction');
  });

  it('links an existing supplier instead of creating a duplicate', () => {
    const first = createSupplierFromExtraction(db, { companyId, name: 'Vercel Inc' });
    const second = createSupplierFromExtraction(db, { companyId, name: 'Vercel Inc' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.supplierId).toBe(first.supplierId);
    expect(db.select().from(suppliers).all()).toHaveLength(1);
  });

  it('matches an existing supplier despite a different legal suffix', () => {
    createSupplierFromExtraction(db, { companyId, name: 'Vercel Inc' });
    const again = createSupplierFromExtraction(db, { companyId, name: 'Vercel Incorporated' });
    expect(again.created).toBe(false);
  });

  it('links the document to the created supplier', () => {
    const stored = storeDocument(db, {
      companyId, filename: 'invoice.pdf', content: Buffer.from('invoice'), root,
    });
    const { supplierId } = createSupplierFromExtraction(db, {
      companyId, name: 'Byrne Accountancy', documentId: stored.documentId,
    });

    const doc = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(doc.supplierId).toBe(supplierId);
  });

  it('links a document to an already-existing supplier', () => {
    const first = createSupplierFromExtraction(db, { companyId, name: 'Vercel Inc' });
    const stored = storeDocument(db, {
      companyId, filename: 'invoice2.pdf', content: Buffer.from('invoice'), root,
    });
    const second = createSupplierFromExtraction(db, {
      companyId, name: 'Vercel Inc', documentId: stored.documentId,
    });
    expect(second.created).toBe(false);
    const doc = db.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(doc.supplierId).toBe(first.supplierId);
  });

  it('refuses an empty name', () => {
    expect(() => createSupplierFromExtraction(db, { companyId, name: '   ' }))
      .toThrow(/cannot be empty/);
  });
});

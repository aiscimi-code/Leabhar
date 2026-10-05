import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, lte, gte } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { postDocumentAsInvoice } from './postDocument';
import { buildVat3Return } from '../vat/report';
import { loadStatutoryKnowledgeBase } from '../rules/knowledgeBase';
import { reviewItems, suppliers, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #629: the customs declaration's valuation reaches an import under
 * postponed accounting through the document-posting path, not only through
 * `createInvoice`. Without it the line posts on the invoice net and is flagged.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let root: string;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Importer Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  ({ companyId, accountsByCode: byCode, treatmentsByCode: tr } = created);
  loadStatutoryKnowledgeBase(db, { companyId });
  root = mkdtempSync(join(tmpdir(), 'import-valuation-'));
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Shenzhen Parts Co', matchKey: 'shenzhen parts co', countryCode: 'CN' }).run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function importDocument(net: number): string {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `IMP-${Math.random().toString(36).slice(2, 8)}`,
    documentDate: '2026-03-14', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Shenzhen Parts Co', supplierAddress: '12 Nanshan Road, Shenzhen', supplierVatNumber: null, supplierCountry: 'CN',
    customerNameStated: 'Importer Ltd', customerAddress: '2 Quay Street, Cork', customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: net, vatMinor: 0, grossMinor: net, vatTotals: [],
    lines: [{ description: 'Machine parts', quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: null, vatMinor: 0, grossMinor: net }],
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId,
    acknowledgedCheckCodes: ['missing_supplier_vat_number', 'no_supplier_vat_number'],
  });
  return stored.documentId;
}

const vat3 = () => buildVat3Return(db, {
  companyId,
  vatPeriodId: db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, companyId), lte(vatPeriods.startDate, '2026-03-14'), gte(vatPeriods.endDate, '2026-03-14'))).get()!.id,
});

describe('posting a confirmed import invoice under postponed accounting', () => {
  it('takes T1, T2 and PA1 from the customs valuation passed with the coding', () => {
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: importDocument(950_000),
      coding: [{
        accountId: byCode['6070']!, vatTreatmentId: tr['IMPORT_PA']!,
        importValuation: { customsValueMinor: 1_000_000, customsDutyMinor: 120_000, freightToIrelandMinor: 80_000, declarationReference: '26IE000000123456A1' },
      }],
    });
    const r = vat3();
    expect(r.T1.amountMinor).toBe(276_000);
    expect(r.T2.amountMinor).toBe(276_000);
    expect(r.PA1.amountMinor).toBe(1_120_000);
    const flags = db.select().from(reviewItems).where(and(eq(reviewItems.entityType, 'invoice'), eq(reviewItems.entityId, inv.invoiceId))).all();
    expect(flags.some((f) => /customs valuation/.test(f.detail ?? ''))).toBe(false);
  });

  it('without a valuation, posts on the invoice net and flags it for review', () => {
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: importDocument(950_000),
      coding: [{ accountId: byCode['6070']!, vatTreatmentId: tr['IMPORT_PA']! }],
    });
    expect(vat3().PA1.amountMinor).toBe(950_000);
    const flags = db.select().from(reviewItems).where(and(eq(reviewItems.entityType, 'invoice'), eq(reviewItems.entityId, inv.invoiceId))).all();
    expect(flags.some((f) => /No customs valuation was recorded/.test(f.detail ?? ''))).toBe(true);
  });
});

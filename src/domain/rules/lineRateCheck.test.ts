import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany, ensureDefaultVatTreatments } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { documentLineChoices } from '../consolidation/suggest';
import { postDocumentAsInvoice } from '../consolidation/postDocument';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suppliers, vatTreatments, reviewItems, invoiceLines, taxRates } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #205: the rate charged on each confirmed invoice line is checked
 * against the statutory rules — consistent, inconsistent or undetermined —
 * and flagged, never corrected.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let root: string;
let goodsSupplier: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  loadStatutoryKnowledgeBase(db, { companyId });
  root = mkdtempSync(join(tmpdir(), 'rate-check-'));
  // A supplier of goods: its confirmed default treatment says what kind of supply it makes.
  goodsSupplier = ids.supplier();
  db.insert(suppliers).values({
    id: goodsSupplier, companyId, name: 'Kerry Fuels', matchKey: 'kerry fuels', countryCode: 'IE',
    defaultVatTreatmentId: tr['IE_LIVESTOCK'],
  }).run();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function confirmedLine(description: string, net: number, rate: number | null, vat: number | null): string {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 8)}`,
    documentDate: '2025-03-14', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Kerry Fuels', supplierAddress: null, supplierVatNumber: null, supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: net, vatMinor: vat, grossMinor: net + (vat ?? 0), vatTotals: [],
    lines: [{ description, quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: rate, vatMinor: vat, grossMinor: net + (vat ?? 0) }],
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId: goodsSupplier,
    acknowledgedCheckCodes: ['missing_supplier_vat_number', 'no_supplier_vat_number'],
  });
  return stored.documentId;
}

const check = (documentId: string) => documentLineChoices(db, { companyId, documentId }).lines[0]!;

describe('checking the rate charged on a confirmed invoice line', () => {
  it('is consistent when a specific rule gives the rate charged', () => {
    const line = check(confirmedLine('Bagged coal, 40kg', 10_000, 1350, 1_350));
    expect(line.rateCheck).toMatchObject({
      outcome: 'consistent', chargedRateBasisPoints: 1350,
      expected: { rateBasisPoints: 1350, treatmentCode: 'IE_RED', ruleKey: 'vat.reduced_rate_solid_fuel' },
    });
    expect(line.flags.join(' ')).not.toMatch(/was charged/);
  });

  it('is inconsistent, and flagged, when the rate charged is not the one the rule gives', () => {
    const line = check(confirmedLine('Bagged coal, 40kg', 10_000, 2300, 2_300));
    expect(line.rateCheck.outcome).toBe('inconsistent');
    expect(line.rateCheck.expected?.rateBasisPoints).toBe(1350);
    expect(line.rateCheck.message).toMatch(/23% was charged, but .* gives 13\.5%/);
    expect(line.flags).toContain(line.rateCheck.message);
  });

  it('is undetermined when only the standard-rate fallback matched, listing the candidate', () => {
    const line = check(confirmedLine('Office chairs', 20_000, 2300, 4_600));
    expect(line.rateCheck.outcome).toBe('undetermined');
    expect(line.rateCheck.message).toMatch(/cannot rule out an exemption or a reduced rate/);
    expect(line.rateCheck.candidates.map((c) => c.rateBasisPoints)).toContain(2300);
    expect(line.flags).toContain(line.rateCheck.message);
  });

  it('is undetermined when the line prints no rate', () => {
    const line = check(confirmedLine('Bagged coal, 40kg', 10_000, null, null));
    expect(line.rateCheck).toMatchObject({ outcome: 'undetermined', chargedRateBasisPoints: null });
    expect(line.rateCheck.message).toMatch(/No VAT rate is printed/);
  });

  it('checks livestock against the 4.8% livestock rate', () => {
    const line = check(confirmedLine('Sale of cattle, 3 bullocks', 300_000, 480, 14_400));
    expect(line.rateCheck).toMatchObject({ outcome: 'consistent', expected: { treatmentCode: 'IE_LIVESTOCK', rateBasisPoints: 480 } });
  });

  it('posts the line as printed and records a review item when the rate is wrong', () => {
    const documentId = confirmedLine('Bagged coal, 40kg', 10_000, 2300, 2_300);
    const inv = postDocumentAsInvoice(db, { companyId, documentId, coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }] });
    const posted = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)).get()!;
    expect(posted.vatMinor).toBe(2_300); // never corrected
    const item = db.select().from(reviewItems)
      .where(and(eq(reviewItems.entityId, inv.invoiceId), eq(reviewItems.kind, 'uncertain_vat_treatment'))).get();
    expect(item).toMatchObject({ severity: 'warning', status: 'open' });
    expect(item!.detail).toMatch(/gives 13\.5%/);
  });

  it('records no review item for a consistent line', () => {
    const documentId = confirmedLine('Bagged coal, 40kg', 10_000, 1350, 1_350);
    const inv = postDocumentAsInvoice(db, { companyId, documentId, coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_RED']! }] });
    expect(db.select().from(reviewItems).where(and(eq(reviewItems.entityId, inv.invoiceId), eq(reviewItems.kind, 'uncertain_vat_treatment'))).all())
      .toHaveLength(0);
  });
});

describe('ensureDefaultVatTreatments', () => {
  it('adds a treatment seeded since the company was created, once, without touching the rest', () => {
    const { db: d } = createTestDatabase();
    const { companyId: c } = createCompany(d, { legalName: 'Old Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    d.delete(vatTreatments).where(and(eq(vatTreatments.companyId, c), eq(vatTreatments.code, 'IE_LIVESTOCK'))).run();
    const std = d.select().from(taxRates).where(and(eq(taxRates.companyId, c), eq(taxRates.code, 'VAT_STD'))).get()!;

    expect(ensureDefaultVatTreatments(d, c)).toEqual({ addedRates: [], addedTreatments: ['IE_LIVESTOCK'] });
    const added = d.select().from(vatTreatments).where(and(eq(vatTreatments.companyId, c), eq(vatTreatments.code, 'IE_LIVESTOCK'))).get()!;
    const livestockRate = d.select().from(taxRates).where(eq(taxRates.id, added.defaultTaxRateId!)).get()!;
    expect(livestockRate.rateBasisPoints).toBe(480);
    expect(ensureDefaultVatTreatments(d, c)).toEqual({ addedRates: [], addedTreatments: [] });
    expect(d.select().from(taxRates).where(eq(taxRates.id, std.id)).get()).toEqual(std);
  });
});

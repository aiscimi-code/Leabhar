import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { loadStatutoryKnowledgeBase } from '../rules/knowledgeBase';
import { COMPOSITE_SUPPLY_RULE_KEY } from '../rules/compositeSupplyCuration';
import { suppliers, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { documentLineChoices } from './suggest';
import type { AppDatabase } from '@/db';

/** Issue #206: VATCA s.47 composite and multiple supplies across an invoice's lines. */

let db: AppDatabase;
let companyId: string;
let root: string;
let supplierId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026],
  }));
  loadStatutoryKnowledgeBase(db, { companyId });
  root = mkdtempSync(join(tmpdir(), 'composite-'));
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Books Direct', matchKey: 'books direct', countryCode: 'IE' }).run();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function invoice(lines: Array<[string, number, number]>): string {
  const docLines = lines.map(([description, net, rate]) => {
    const vat = Math.round((net * rate) / 10_000);
    return { description, quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: rate, vatMinor: vat, grossMinor: net + vat };
  });
  const netMinor = docLines.reduce((s, l) => s + l.netMinor, 0);
  const vatMinor = docLines.reduce((s, l) => s + l.vatMinor, 0);
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 8)}`,
    documentDate: '2026-03-10', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Books Direct', supplierAddress: null, supplierVatNumber: null, supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor, vatMinor, grossMinor: netMinor + vatMinor, vatTotals: [], lines: docLines,
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId,
    acknowledgedCheckCodes: ['missing_supplier_vat_number', 'no_supplier_vat_number', 'vat_totals_missing'],
  });
  return stored.documentId;
}
const choices = (documentId: string) => documentLineChoices(db, { companyId, documentId }).lines;

describe('s.47 composite and multiple supplies on one invoice', () => {
  it('derives the s.47 rule from the revised section', () => {
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, COMPOSITE_SUPPLY_RULE_KEY))).get();
    expect(rule?.statement).toMatch(/composite supply/);
  });

  it('delivery charged at the books\' 0%: offers their treatment under s.47(1)(a) and asks which it is', () => {
    const [books, delivery] = choices(invoice([['Printed books x 12', 18_000, 0], ['Delivery', 800, 0]]));
    expect(books!.flags.join(' ')).not.toMatch(/s\.47/);
    const principal = books!.options.find((o) => o.treatmentId === books!.preselectedTreatmentId)
      ?? books!.options.find((o) => o.code === 'IE_ZERO')!;
    const offered = delivery!.options.find((o) => o.treatmentId === principal.treatmentId);
    expect(offered?.ruleKeys).toContain(COMPOSITE_SUPPLY_RULE_KEY);
    expect(offered?.reasons.join(' ')).toMatch(/s\.47\(1\)\(a\)/);
    expect(delivery!.flags.join(' ')).toMatch(/That is right if it is ancillary/);
    expect(delivery!.preselectedTreatmentId).toBeNull();
  });

  it('delivery charged at 23% on a 0% book invoice: flagged, with the rate s.47(1)(a) would give', () => {
    const [, delivery] = choices(invoice([['Printed books x 12', 18_000, 0], ['Delivery charge', 800, 2300]]));
    expect(delivery!.flags.join(' ')).toMatch(/charged at 23%, but "Printed books x 12" at 0%.*gives it 0%.*Check with the supplier/);
  });

  it('principal supplies at different rates: flagged as undecidable from the invoice', () => {
    const [, , packaging] = choices(invoice([
      ['Printed books x 12', 18_000, 0], ['Stationery', 5_000, 2300], ['Packaging and handling', 500, 2300],
    ]));
    expect(packaging!.flags.join(' ')).toMatch(/different rates \(0%, 23%\).*cannot be decided/);
    expect(packaging!.preselectedTreatmentId).toBeNull();
  });

  it('a courier invoice with only a delivery line is not a composite supply question', () => {
    const [delivery] = choices(invoice([['Delivery', 1_500, 2300]]));
    expect(delivery!.flags.join(' ')).not.toMatch(/s\.47/);
  });
});

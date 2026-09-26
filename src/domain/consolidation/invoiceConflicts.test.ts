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
import { confirmEstablishment } from '../parties/status';
import { companies, suppliers, vatTreatments } from '@/db/schema';
import { ids } from '@/lib/ids';
import { invoiceConflicts, type InvoiceConflictInput } from './invoiceConflicts';
import { documentLineChoices } from './suggest';
import type { AppDatabase } from '@/db';

/** Issue #207: what a confirmed invoice says against itself or against the parties' records. */

const base: InvoiceConflictInput = {
  direction: 'purchase', documentVatMinor: 0, lineVatMinor: [0], supplierVatNumber: null, customerVatNumber: null,
  companyVatNumber: 'IE6388047V', counterpartyCountry: 'IE', counterpartyEstablishment: null, customerVies: null, legends: [],
};
const codes = (over: Partial<InvoiceConflictInput>) => invoiceConflicts({ ...base, ...over }).map((c) => c.code);

describe('invoice conflicts (pure)', () => {
  it('an ordinary Irish invoice has none', () => {
    expect(codes({ documentVatMinor: 2_300, lineVatMinor: [2_300], supplierVatNumber: 'IE9825613N', customerVatNumber: 'IE6388047V' })).toEqual([]);
  });

  it('an EU supplier charging its own VAT', () => {
    expect(codes({ documentVatMinor: 1_900, supplierVatNumber: 'DE136695976', counterpartyCountry: 'DE' })).toContain('foreign_vat_charged');
  });

  it('a supplier confirmed abroad charging VAT without an Irish number', () => {
    expect(codes({ documentVatMinor: 500, counterpartyCountry: 'US', counterpartyEstablishment: 'outside_state' })).toContain('foreign_vat_charged');
    expect(codes({ documentVatMinor: 500, supplierVatNumber: 'IE3668997OH', counterpartyCountry: 'US', counterpartyEstablishment: 'outside_state' }))
      .not.toContain('foreign_vat_charged');
  });

  it('a reverse-charge legend with VAT charged', () => {
    expect(codes({ documentVatMinor: 1_900, legends: ['Reverse charge, Art. 196'] })).toContain('reverse_charge_with_vat');
  });

  it('a reverse charge from another Member State without your VAT number', () => {
    expect(codes({ supplierVatNumber: 'NL859048357B01', counterpartyCountry: 'NL', legends: ['VAT reverse charged'] }))
      .toContain('reverse_charge_without_your_vat_number');
    expect(codes({ supplierVatNumber: 'NL859048357B01', counterpartyCountry: 'NL', legends: ['VAT reverse charged'], customerVatNumber: 'IE6388047V' }))
      .toEqual([]);
  });

  it('an invoice addressed to someone else\'s VAT number', () => {
    expect(codes({ customerVatNumber: 'IE1234567T' })).toContain('not_your_vat_number');
    expect(codes({ customerVatNumber: 'ie 6388047 v' })).toEqual([]);
  });

  it('an EU supplier confirmed abroad charging no VAT and giving no reason', () => {
    expect(codes({ counterpartyCountry: 'FR', counterpartyEstablishment: 'outside_state' })).toEqual(['no_vat_no_reverse_charge_wording']);
    expect(codes({ counterpartyCountry: 'FR', counterpartyEstablishment: 'outside_state', legends: ['Autoliquidation'], customerVatNumber: 'IE6388047V' }))
      .toEqual([]);
  });

  it('a zero-VAT sale to another Member State needs the customer\'s number and the wording (SI 639/2010 reg 20)', () => {
    const sale = { direction: 'sales' as const, counterpartyCountry: 'IT' };
    expect(codes(sale)).toEqual(['zero_vat_sale_without_customer_vat_number']);
    expect(codes({ ...sale, customerVatNumber: 'IT12345678901' })).toEqual(['zero_vat_sale_without_wording']);
    expect(codes({ ...sale, customerVatNumber: 'IT12345678901', legends: ['Intra-Community supply'] })).toEqual([]);
    expect(codes({ ...sale, customerVatNumber: 'IT12345678901', legends: ['Reverse charge'], customerVies: 'invalid' }))
      .toEqual(['zero_vat_sale_invalid_vat_number']);
  });

  it('a sale to an Irish customer, or with VAT charged, is not checked for reverse-charge wording', () => {
    expect(codes({ direction: 'sales', counterpartyCountry: 'IE' })).toEqual([]);
    expect(codes({ direction: 'sales', counterpartyCountry: 'IT', documentVatMinor: 2_300 })).toEqual([]);
  });
});

let db: AppDatabase;
let companyId: string;
let root: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, {
    legalName: 'Conflicts Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026],
  }));
  db.update(companies).set({ vatNumber: 'IE6388047V' }).where(eq(companies.id, companyId)).run();
  loadStatutoryKnowledgeBase(db, { companyId });
  root = mkdtempSync(join(tmpdir(), 'conflicts-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function purchase(supplierId: string, over: Partial<ReviewedDocumentValues>, line: { rate: number | null; vat: number | null }): string {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `C-${Math.random().toString(36).slice(2, 8)}`,
    documentDate: '2026-03-10', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Supplier', supplierAddress: null, supplierVatNumber: null, supplierCountry: null,
    customerNameStated: 'Conflicts Ltd', customerAddress: null, customerVatNumber: 'IE6388047V', customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: 10_000, vatMinor: line.vat, grossMinor: 10_000 + (line.vat ?? 0), vatTotals: [],
    lines: [{ description: 'Widgets', quantity: null, unitPriceMinor: null, netMinor: 10_000, vatRateBasisPoints: line.rate, vatMinor: line.vat, grossMinor: 10_000 + (line.vat ?? 0) }],
    ...over,
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId,
    acknowledgedCheckCodes: ['vat_totals_missing', 'no_vat_stated'],
  });
  return stored.documentId;
}
const supplier = (name: string, countryCode: string) => {
  const id = ids.supplier();
  db.insert(suppliers).values({ id, companyId, name, matchKey: name.toLowerCase(), countryCode }).run();
  confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment: 'outside_state', basis: 'test', confirmedBy: 'joe' });
  return id;
};

describe('invoice conflicts on the posting choices', () => {
  it('German VAT on a German invoice: flagged, and nothing is pre-selected', () => {
    const id = purchase(supplier('Maschinen GmbH', 'DE'), { supplierVatNumber: 'DE136695976' }, { rate: 1900, vat: 1_900 });
    const c = documentLineChoices(db, { companyId, documentId: id });
    expect(c.conflicts.map((x) => x.code)).toContain('foreign_vat_charged');
    expect(c.lines.every((l) => l.preselectedTreatmentId === null)).toBe(true);
  });

  it('a reverse-charge legend from a supplier whose establishment is unconfirmed is offered but not pre-selected', () => {
    const id = ids.supplier();
    db.insert(suppliers).values({ id, companyId, name: 'Onbekend BV', matchKey: 'onbekend bv', countryCode: 'NL' }).run();
    const doc = purchase(id, { supplierVatNumber: 'NL859048357B01', vatLegends: ['BTW verlegd'] }, { rate: 0, vat: 0 });
    const [line] = documentLineChoices(db, { companyId, documentId: doc }).lines;
    expect(line!.options.map((o) => o.code)).toContain('EU_SERVICES_RCV');
    expect(line!.preselectedTreatmentId).toBeNull();
    expect(line!.flags.join(' ')).toMatch(/has not been confirmed/);
  });

  it('goods from outside the EU: both import treatments are offered, neither chosen, until the customs entry decides', () => {
    const id = supplier('Ningbo Fittings Co', 'CN');
    const importPa = db.select().from(vatTreatments)
      .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, 'IMPORT_PA'))).get()!;
    db.update(suppliers).set({ defaultVatTreatmentId: importPa.id }).where(eq(suppliers.id, id)).run();
    const doc = purchase(id, {}, { rate: null, vat: null });
    const [line] = documentLineChoices(db, { companyId, documentId: doc }).lines;
    expect(line!.statutory.decidingRule?.ruleKey).toBe('vat.import_of_goods');
    expect(line!.options.map((o) => o.code).sort()).toEqual(['IMPORT_PA', 'IMPORT_VAT_PAID']);
    expect(line!.preselectedTreatmentId).toBeNull();
  });
});

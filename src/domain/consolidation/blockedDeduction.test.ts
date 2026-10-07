import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, lte, gte } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany, systemAccountId } from '../config/setup';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues } from '../documents/review';
import { documentLineChoices } from './suggest';
import { postDocumentAsInvoice, ConsolidationError } from './postDocument';
import { createInvoice, InvoicingError } from '../invoicing/invoices';
import { buildVat3Return } from '../vat/report';
import { reconcileVatReturn } from '../vat/reconcile';
import { makeDate } from '../dates';
import { customers, journalLines, suppliers, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #616: a s.60(2)(a) block denies the deduction, not the treatment.
 * The line keeps the rate Schedule 3 gives it, and a reverse charge is still
 * accounted for in T1 (s.12: the recipient is liable), with nothing in T2.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let root: string;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Block Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  ({ companyId, accountsByCode: byCode, treatmentsByCode: tr } = created);
  root = mkdtempSync(join(tmpdir(), 'blocked-deduction-'));
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'The Winding Stair', matchKey: 'the winding stair', countryCode: 'IE' }).run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const periodOn = (date: string) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), lte(vatPeriods.startDate, date), gte(vatPeriods.endDate, date))).get()!;

function confirmedLine(description: string, net: number, rate: number, vat: number): string {
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 8)}`,
    documentDate: '2026-03-14', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'The Winding Stair', supplierAddress: '40 Ormond Quay, Dublin', supplierVatNumber: 'IE6388047V', supplierCountry: 'IE',
    customerNameStated: 'Block Ltd', customerAddress: '2 Quay Street, Cork', customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: net, vatMinor: vat, grossMinor: net + vat, vatTotals: [],
    lines: [{ description, quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: rate, vatMinor: vat, grossMinor: net + vat }],
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe', supplierId,
    acknowledgedCheckCodes: ['missing_supplier_vat_number', 'no_supplier_vat_number'],
  });
  return stored.documentId;
}

describe('a restaurant bill (s.60(2)(a)(i))', () => {
  it('is offered at the rate printed and the rules give, with the block beside it', () => {
    const line = documentLineChoices(db, { companyId, documentId: confirmedLine('Client dinner, restaurant', 10_000, 1350, 1_350) }).lines[0]!;
    expect(line.deductionBlocked).toMatchObject({ ruleKey: 'vat.blocked_food_drink_accommodation' });
    expect(line.deductionBlocked!.provision).toMatch(/s\.60/);
    expect(line.options.map((o) => o.code)).toContain('IE_RED');
    expect(line.options.map((o) => o.code)).not.toContain('NON_DEDUCTIBLE');
  });

  it('posts the VAT charged, deducts none of it, and leaves T2 at 0', () => {
    const documentId = confirmedLine('Client dinner, restaurant', 10_000, 1350, 1_350);
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId,
      coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_RED']!, blockedDeductionRuleKey: 'vat.blocked_food_drink_accommodation' }],
    });
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.journalEntryId, inv.journalEntryId)).all();
    expect(entry).toMatchObject({ baseVatMinor: 1_350, baseRecoverableVatMinor: 0 });
    expect(entry!.notes).toMatch(/s\.60/);
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-14').id });
    expect(vat3.T2.amountMinor).toBe(0);
    expect(vat3.nonRecoverableVatMinor).toBe(1_350);
  });

  it('without the block, the same bill deducts its VAT', () => {
    const documentId = confirmedLine('Client dinner, restaurant', 10_000, 1350, 1_350);
    postDocumentAsInvoice(db, { companyId, documentId, coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_RED']! }] });
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-14').id }).T2.amountMinor).toBe(1_350);
  });

  it('accepts only a s.60(2)(a) rule key', () => {
    const documentId = confirmedLine('Client dinner, restaurant', 10_000, 1350, 1_350);
    expect(() => postDocumentAsInvoice(db, {
      companyId, documentId,
      coding: [{ accountId: byCode['6120']!, vatTreatmentId: tr['IE_RED']!, blockedDeductionRuleKey: 'vat.rate_standard_current' }],
    })).toThrow(ConsolidationError);
  });
});

describe('a car leased from a lessor established in another Member State (s.60(2)(a)(iv), s.12)', () => {
  const lease = (blocked: boolean) => {
    const lessor = ids.supplier();
    db.insert(suppliers).values({
      id: lessor, companyId, name: 'Autoleasing GmbH', matchKey: 'autoleasing gmbh', countryCode: 'DE', vatNumber: 'DE123456789',
    }).run();
    return createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId: lessor, invoiceNumber: 'L-1',
      documentId: insertConfirmedDocument(db, companyId),
      lines: [{
        description: 'Car leasing, March', netMinor: 50_000, accountId: byCode['6070']!, vatTreatmentId: tr['EU_SERVICES_RCV']!,
        ...(blocked ? { blockedDeductionReason: 'No deduction: motor vehicle (VATCA 2010 s.60(2)(a)(iv)).' } : {}),
      }],
    });
  };

  it('accounts for the reverse charge in T1 and ES2, with nothing in T2, and the period reconciles', () => {
    const inv = lease(true);
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-10').id });
    expect(vat3.T1.amountMinor).toBe(11_500);
    expect(vat3.T2.amountMinor).toBe(0);
    expect(vat3.ES2.amountMinor).toBe(50_000);
    expect(vat3.netPositionMinor).toBe(11_500);
    // The VAT that cannot be deducted is part of the cost.
    const cost = db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, inv.journalEntryId), eq(journalLines.accountId, byCode['6070']!))).all()
      .reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0);
    expect(cost).toBe(61_500);
    const onPurchases = db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, inv.journalEntryId), eq(journalLines.accountId, systemAccountId(db, companyId, 'vat_on_purchases')))).all();
    expect(onPurchases.reduce((s, l) => s + l.baseDebitMinor, 0)).toBe(0);
    expect(reconcileVatReturn(db, { companyId, vatPeriodId: periodOn('2026-03-10').id }).agrees).toBe(true);
  });

  it('unblocked, the reverse charge nets to nil', () => {
    lease(false);
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-10').id });
    expect(vat3.T1.amountMinor).toBe(11_500);
    expect(vat3.T2.amountMinor).toBe(11_500);
  });
});

it('a sales line cannot carry a blocked deduction', () => {
  const customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Diner Ltd', matchKey: 'diner ltd', countryCode: 'IE' }).run();
  expect(() => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId, invoiceNumber: 'S-1',
    lines: [{ description: 'Dinner', netMinor: 1_000, accountId: byCode['4000']!, vatTreatmentId: tr['IE_RED']!, blockedDeductionReason: 's.60' }],
  })).toThrow(new InvoicingError('Line 1: a blocked deduction applies only to a purchase.'));
});

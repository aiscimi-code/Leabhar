import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, type ImportValuation } from '../invoicing/invoices';
import { trialBalance } from '../accounting/ledger';
import { buildVat3Return } from './report';
import { makeDate } from '../dates';
import { suppliers, vatEntries, vatPeriods, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #609: under postponed accounting, import VAT is charged on the value
 * for import VAT purposes — customs (CIF) value, plus duty and other charges
 * payable at importation, plus freight from the EU point of entry to Ireland
 * (Revenue Customs Manual on Import VAT §2.3) — and box PA1 reports the
 * customs value plus customs duty (Revenue, completing the VAT3). Both come
 * from the customs declaration, never from the supplier's invoice.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Importer Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Shenzhen Parts Co', matchKey: 'shenzhen parts co', countryCode: 'CN' }).run();
});

const VALUATION: ImportValuation = {
  customsValueMinor: 1_000_000, customsDutyMinor: 120_000, freightToIrelandMinor: 80_000, declarationReference: '25IE000000123456A1',
};

const importInvoice = (over: {
  netMinor?: number; currency?: string; fxRate?: { numerator: number; denominator: number; source: string };
  importValuation?: ImportValuation; treatment?: string; isCreditNote?: boolean; holdRecoveryReason?: string;
} = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: makeDate(2025, 3, 10), supplierId, invoiceNumber: `IMP-${Math.random()}`,
  documentId: insertConfirmedDocument(db, companyId),
  currency: over.currency, fxRate: over.fxRate, isCreditNote: over.isCreditNote,
  lines: [{
    description: 'Machine parts', netMinor: over.netMinor ?? 950_000, accountId: byCode['6070']!,
    vatTreatmentId: tr[over.treatment ?? 'IMPORT_PA']!, importValuation: over.importValuation, holdRecoveryReason: over.holdRecoveryReason,
  }],
});

const periodId = () => db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
const vat3 = () => buildVat3Return(db, { companyId, vatPeriodId: periodId() });
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
const flagsFor = (invoiceId: string) => db.select().from(reviewItems)
  .where(and(eq(reviewItems.entityType, 'invoice'), eq(reviewItems.entityId, invoiceId))).all();

describe('postponed accounting on a customs valuation', () => {
  it('charges VAT on customs value + duty + freight to Ireland, and reports customs value + duty in PA1', () => {
    const inv = importInvoice({ importValuation: VALUATION });
    const r = vat3();
    // 23% of 10,000 + 1,200 + 800 = 2,760.00
    expect(r.T1.amountMinor).toBe(276_000);
    expect(r.T2.amountMinor).toBe(276_000);
    expect(r.PA1.amountMinor).toBe(1_120_000);
    const entries = db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).all();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.currency === 'EUR' && e.notes?.includes('25IE000000123456A1'))).toBe(true);
    expect(flagsFor(inv.invoiceId).some((f) => /customs valuation/.test(f.detail ?? ''))).toBe(false);
    balanced();
  });

  it('takes the valuation in euro from the declaration when the supplier invoices in dollars', () => {
    importInvoice({
      currency: 'USD', netMinor: 1_100_000, fxRate: { numerator: 9, denominator: 10, source: 'test' }, importValuation: VALUATION,
    });
    const r = vat3();
    expect(r.T1.amountMinor).toBe(276_000);
    expect(r.PA1.amountMinor).toBe(1_120_000);
    balanced();
  });

  it('costs the import VAT it cannot recover, and claims none of it', () => {
    importInvoice({ importValuation: VALUATION, holdRecoveryReason: 'Goods used for exempt supplies' });
    const r = vat3();
    expect(r.T1.amountMinor).toBe(276_000);
    expect(r.T2.amountMinor).toBe(0);
    balanced();
  });

  it('without a valuation, uses the invoice net as before and flags the line', () => {
    const inv = importInvoice({ netMinor: 950_000 });
    const r = vat3();
    expect(r.PA1.amountMinor).toBe(950_000);
    expect(r.T1.amountMinor).toBe(218_500);
    expect(flagsFor(inv.invoiceId).some((f) => /No customs valuation was recorded/.test(f.detail ?? ''))).toBe(true);
    balanced();
  });

  it('refuses a valuation on a treatment other than IMPORT_PA, on a credit note, or with no customs value', () => {
    expect(() => importInvoice({ treatment: 'IE_STD', importValuation: VALUATION })).toThrow(/IMPORT_PA/);
    expect(() => importInvoice({ isCreditNote: true, importValuation: VALUATION })).toThrow(/credit note/);
    expect(() => importInvoice({ importValuation: { ...VALUATION, customsValueMinor: 0 } })).toThrow(/customs value/);
    expect(() => importInvoice({ importValuation: { ...VALUATION, customsDutyMinor: 1.5 } })).toThrow(/whole number/);
  });
});

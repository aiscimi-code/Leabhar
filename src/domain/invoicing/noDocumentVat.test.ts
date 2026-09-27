import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from './invoices';
import { createAdjustment } from '../accounting/adjustments';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { suppliers, customers, vatEntries, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy', matchKey: 'murphy', countryCode: 'IE' }).run();
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const purchase = (over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-03-10'), supplierId,
  lines: [{ description: 'Stationery', netMinor: 10_000, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const entriesFor = (id: string) => db.select().from(vatEntries).where(eq(vatEntries.sourceId, id)).all();

describe('input VAT only from a confirmed invoice (#234)', () => {
  it('holds back the VAT of a purchase posted with no document, costs it, and flags it', () => {
    const inv = purchase();
    const [entry] = entriesFor(inv.invoiceId);
    expect([entry!.vatMinor, entry!.recoverableVatMinor]).toEqual([2_300, 0]);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byCode['6120']! })).toBe(12_300);
    const flags = db.select().from(reviewItems).where(eq(reviewItems.entityId, inv.invoiceId)).all();
    expect(flags[0]?.detail).toMatch(/without a confirmed supplier invoice/);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('holds it back too when the document linked is not confirmed', () => {
    const doc = insertConfirmedDocument(db, companyId, { reviewStatus: 'unreviewed' });
    const inv = purchase({ documentId: doc });
    expect(entriesFor(inv.invoiceId)[0]!.recoverableVatMinor).toBe(0);
  });

  it('recovers it when the purchase is posted from a confirmed document', () => {
    const inv = purchase({ documentId: insertConfirmedDocument(db, companyId) });
    expect(entriesFor(inv.invoiceId)[0]!.recoverableVatMinor).toBe(2_300);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(2_300);
  });

  it('records a migrated invoice whose VAT was declared elsewhere as information only', () => {
    const buy = purchase({ vatAlreadyDeclared: { reason: 'Migrated from the previous system' } });
    const sale = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
      lines: [{ description: 'Work', netMinor: 5_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
      vatAlreadyDeclared: { reason: 'Migrated from the previous system' },
    });
    expect([entriesFor(buy.invoiceId), entriesFor(sale.invoiceId)]).toEqual([[], []]);
    expect([buy.grossMinor, sale.grossMinor]).toEqual([12_300, 6_150]);
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(12_300);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(6_150);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(0);
    expect(db.select().from(reviewItems).where(eq(reviewItems.entityId, buy.invoiceId)).all()).toEqual([]);
    expect(() => purchase({ vatAlreadyDeclared: { reason: ' ' } })).toThrow(/Say why/);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('allows an accountant\'s input VAT adjustment, and flags it', () => {
    const result = createAdjustment(db, {
      companyId, date: asIsoDate('2025-03-31'), description: 'Correct Q1 input VAT', reason: 'Invoice found late',
      lines: [
        { accountId: acc['vat_on_purchases']!, debitMinor: 500 },
        { accountId: byCode['6120']!, creditMinor: 500 },
      ],
      vat: { direction: 'purchases', treatmentId: tr['IE_STD']!, netMinor: 0, statedVatMinor: 500 },
    });
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `journal_entry:${result.journalEntryId}:input_vat_adjustment`)).get();
    expect(flag?.detail).toMatch(/Invoice found late/);
  });
});

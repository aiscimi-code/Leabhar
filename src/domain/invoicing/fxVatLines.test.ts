import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, lte, gte } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany, systemAccountId } from '../config/setup';
import { createInvoice } from './invoices';
import { reconcileVatReturn } from '../vat/reconcile';
import { makeDate } from '../dates';
import { customers, journalLines, suppliers, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #643: the VAT entries convert each invoice line's VAT on its own, so
 * a foreign-currency invoice whose journal converted the total VAT once could
 * leave the VAT accounts a cent away from the return, and the period failed
 * to reconcile. Two USD lines with VAT of 1.15 each at 7/9: each entry is
 * 1.15 → 0.89 (1.78 in all), where the total 2.30 converts to 1.79.
 */

const usd = { numerator: 7, denominator: 9, source: 'ecb', date: '2026-03-10' };

describe('VAT lines on a foreign-currency invoice (#643)', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;
  let tr: Record<string, string>;

  beforeEach(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Dollar Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    tr = created.treatmentsByCode;
  });

  const periodOn = (date: string) => db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, companyId), lte(vatPeriods.startDate, date), gte(vatPeriods.endDate, date))).get()!;

  const baseVatOn = (journalEntryId: string, key: 'vat_on_sales' | 'vat_on_purchases') => db.select().from(journalLines)
    .where(and(eq(journalLines.journalEntryId, journalEntryId), eq(journalLines.accountId, systemAccountId(db, companyId, key)))).all()
    .reduce((s, l) => s + l.baseCreditMinor - l.baseDebitMinor, 0);

  const entriesOf = (journalEntryId: string) => db.select().from(vatEntries)
    .where(eq(vatEntries.journalEntryId, journalEntryId)).all();

  const twoLines = (accountId: string, vatTreatmentId: string, withStatedVat = true) => [1, 2].map((n) => ({
    description: `Item ${n}`, netMinor: 500, ...(withStatedVat ? { statedVatMinor: 115 } : {}), accountId, vatTreatmentId,
  }));

  it('a USD purchase: input VAT in the ledger is 1.78, the sum of its VAT entries, and the period reconciles', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'NY Supplies', matchKey: 'ny supplies', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'U-1',
      documentId: insertConfirmedDocument(db, companyId), currency: 'USD', fxRate: usd,
      lines: twoLines(byCode['6070']!, tr['IE_STD']!),
    });
    expect(entriesOf(inv.journalEntryId).map((e) => e.baseRecoverableVatMinor)).toEqual([89, 89]);
    expect(baseVatOn(inv.journalEntryId, 'vat_on_purchases')).toBe(-178);
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodOn('2026-03-10').id });
    expect(rec.ledger).toMatchObject({ vatAccountsMovementMinor: -178, netPositionMinor: -178, agrees: true });
    expect(rec.agrees).toBe(true);
  });

  it('a USD sale: output VAT in the ledger is 1.78, the sum of its VAT entries, and the period reconciles', () => {
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'NY Buyer', matchKey: 'ny buyer', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId, invoiceNumber: 'S-1',
      currency: 'USD', fxRate: usd,
      lines: twoLines(byCode['4000']!, tr['IE_STD']!),
    });
    expect(entriesOf(inv.journalEntryId).map((e) => e.baseVatMinor)).toEqual([89, 89]);
    expect(baseVatOn(inv.journalEntryId, 'vat_on_sales')).toBe(178);
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodOn('2026-03-10').id });
    expect(rec.ledger).toMatchObject({ vatAccountsMovementMinor: 178, agrees: true });
    expect(rec.agrees).toBe(true);
  });

  it('a USD reverse-charge purchase: both legs in the ledger match the entries, and the period reconciles', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'Berlin GmbH', matchKey: 'berlin gmbh', countryCode: 'DE', vatNumber: 'DE123456789' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'RC-1',
      documentId: insertConfirmedDocument(db, companyId), currency: 'USD', fxRate: usd,
      lines: twoLines(byCode['6070']!, tr['EU_SERVICES_RCV']!, false),
    });
    const entries = entriesOf(inv.journalEntryId);
    expect(entries.filter((e) => e.direction === 'sales').map((e) => e.baseVatMinor)).toEqual([89, 89]);
    expect(baseVatOn(inv.journalEntryId, 'vat_on_sales')).toBe(178);
    expect(baseVatOn(inv.journalEntryId, 'vat_on_purchases')).toBe(-178);
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodOn('2026-03-10').id });
    expect(rec.ledger.agrees).toBe(true);
    expect(rec.agrees).toBe(true);
  });

  it('a euro invoice still posts one VAT line for the total', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'Cork Supplies', matchKey: 'cork supplies', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'E-1',
      documentId: insertConfirmedDocument(db, companyId),
      lines: twoLines(byCode['6070']!, tr['IE_STD']!),
    });
    const vatLines = db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, inv.journalEntryId), eq(journalLines.accountId, systemAccountId(db, companyId, 'vat_on_purchases')))).all();
    expect(vatLines).toHaveLength(1);
    expect(vatLines[0]).toMatchObject({ baseDebitMinor: 230 });
  });
});

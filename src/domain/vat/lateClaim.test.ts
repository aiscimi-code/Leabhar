import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, lte, gte } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { createVatEntries, VatError } from './engine';
import { lateClaimLimit, REFUND_CLAIM_LIMIT_TEXT } from './lateClaim';
import { buildVat3Return } from './report';
import { reconcileVatReturn } from './reconcile';
import { asIsoDate, makeDate } from '../dates';
import { reviewItems, suppliers, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #646: a late input VAT claim is made only within 4 years after the end
 * of the taxable period it relates to (VATCA s.99(4)). Input VAT with a tax
 * point in Jan-Feb 2022 (ending 28 February 2022) may be claimed until
 * 28 February 2026: in the Jan-Feb 2026 return, not the Mar-Apr 2026 one.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Late Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2022, 2023, 2024, 2025, 2026],
  });
  ({ companyId, accountsByCode: byCode, treatmentsByCode: tr } = created);
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Cork Supplies', matchKey: 'cork supplies', countryCode: 'IE' }).run();
});

const periodOn = (date: string) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), lte(vatPeriods.startDate, date), gte(vatPeriods.endDate, date))).get()!;

const latePurchase = (declaredOn: string, treatment = 'IE_STD') => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: makeDate(2022, 2, 10), supplierId, invoiceNumber: `P-${declaredOn}`,
  documentId: insertConfirmedDocument(db, companyId), vatDeclarationDate: asIsoDate(declaredOn),
  lines: [{ description: 'Stationery', netMinor: 10_000, accountId: byCode['6070']!, vatTreatmentId: tr[treatment]! }],
});

describe('the s.99(4) limit', () => {
  it('quotes the statute verbatim', () => {
    const text = readFileSync('docs/statutes/vatca-2010-revised/s099.md', 'utf8').replace(/\s+/g, ' ');
    expect(text).toContain(REFUND_CLAIM_LIMIT_TEXT);
  });

  it('runs 4 years from the end of the period covering the tax point', () => {
    const limit = lateClaimLimit(db, companyId, asIsoDate('2022-02-10'), asIsoDate('2026-02-01'))!;
    expect(limit.ownPeriod.endDate).toBe('2022-02-28');
    expect(limit.limitDate).toBe('2026-02-28');
    expect(limit.outOfTime).toBe(false);
  });

  it('a claim in the same period is not late', () => {
    expect(lateClaimLimit(db, companyId, asIsoDate('2022-02-10'), asIsoDate('2022-02-20'))).toBeNull();
  });
});

describe('a late purchase declaration', () => {
  it('on the last period that ends by the limit: claimed, with a warning to make that return by the limit', () => {
    const inv = latePurchase('2026-02-01');
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-02-01').id });
    expect(vat3.T2.amountMinor).toBe(2_300);
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.journalEntryId, inv.journalEntryId)).all();
    const late = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `vat_entry:${entry!.id}:declared_late`)).get()!;
    // The Jan-Feb 2026 return is due 19 March 2026, after the limit.
    expect(late.detail).toMatch(/is due 2026-03-19: make it by 2026-02-28 or the claim is out of time/);
  });

  it('one period later: out of time, so the VAT is costed, not claimed, and flagged', () => {
    const inv = latePurchase('2026-03-01');
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-01').id });
    expect(vat3.T2.amountMinor).toBe(0);
    expect(vat3.nonRecoverableVatMinor).toBe(2_300);
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.map((i) => i.detail).join(' ')).toMatch(/only within 4 years .* by 2026-02-28 \(VATCA 2010 s\.99\(4\)\)/);
    expect(reconcileVatReturn(db, { companyId, vatPeriodId: periodOn('2026-03-01').id }).ledger.agrees).toBe(true);
    expect(inv.vatMinor).toBe(2_300);
  });

  it('a reverse charge out of time still declares its output VAT; only the deduction is withheld', () => {
    const de = ids.supplier();
    db.insert(suppliers).values({ id: de, companyId, name: 'Berlin GmbH', matchKey: 'berlin gmbh', countryCode: 'DE', vatNumber: 'DE123456789' }).run();
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2022, 2, 10), supplierId: de, invoiceNumber: 'RC-late',
      documentId: insertConfirmedDocument(db, companyId), vatDeclarationDate: asIsoDate('2026-03-01'),
      lines: [{ description: 'Consulting', netMinor: 10_000, accountId: byCode['6070']!, vatTreatmentId: tr['EU_SERVICES_RCV']! }],
    });
    const vat3 = buildVat3Return(db, { companyId, vatPeriodId: periodOn('2026-03-01').id });
    expect(vat3.T1.amountMinor).toBe(2_300);
    expect(vat3.T2.amountMinor).toBe(0);
  });

  it('any other path claiming out of time is refused before anything is written', () => {
    expect(() => createVatEntries(db, {
      companyId, sourceType: 'manual_adjustment', direction: 'purchases', treatmentId: tr['IE_STD']!,
      taxPointDate: asIsoDate('2022-02-10'), declarationDate: asIsoDate('2026-03-01'),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    })).toThrow(VatError);
    expect(db.select().from(vatEntries).where(eq(vatEntries.companyId, companyId)).all()).toHaveLength(0);
  });

  it('nothing to claim is not refused', () => {
    expect(() => createVatEntries(db, {
      companyId, sourceType: 'manual_adjustment', direction: 'purchases', treatmentId: tr['IE_STD']!,
      taxPointDate: asIsoDate('2022-02-10'), declarationDate: asIsoDate('2026-03-01'),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR', recoverableOverrideMinor: 0,
    })).not.toThrow();
  });
});

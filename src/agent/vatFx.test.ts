import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { createInvoice } from '@/domain/invoicing/invoices';
import { parseVatFxRate } from '@/domain/invoicing/vatFxRate';
import { buildVat3Return } from '@/domain/vat/report';
import { findVatPeriod } from '@/domain/vat/engine';
import { testVatBasis } from '@/db/testing';
import { makeDate } from '@/domain/dates';
import { customers, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { recordPaymentCli } from './books';
import { vatFxFromArgs } from './vatFx';

/**
 * Issue #661: the s.37(4) rate at a cash-basis receipt reaches the domain from
 * the CLI. (The forms and server actions build it with the same
 * `parseVatFxRate`.)
 */

let db: AppDatabase;
let companyId: string;
let invoiceId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Cash Dollar Ltd', vatRegistrationStatus: 'registered', ...testVatBasis('cash_receipts'), seedYears: [2026],
  });
  companyId = created.companyId;
  const customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Boston Co', matchKey: 'boston co', countryCode: 'IE' }).run();
  invoiceId = createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: makeDate(2026, 2, 20), customerId, invoiceNumber: 'S-1',
    currency: 'USD', fxRate: { numerator: 9, denominator: 10, source: 'ecb', date: '2026-02-20' },
    lines: [{ description: 'Consulting', netMinor: 100_000, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode['IE_STD']! }],
  }).invoiceId;
});

describe('parseVatFxRate', () => {
  it('reads a decimal or a fraction exactly, with its source and date', () => {
    expect(parseVatFxRate({ rate: '0.95', currency: 'usd', source: 'ECB', date: '2026-03-10' }))
      .toEqual({ currency: 'USD', numerator: 95, denominator: 100, source: 'ECB', date: '2026-03-10' });
    expect(parseVatFxRate({ rate: '19/20', currency: 'USD' })).toEqual({ currency: 'USD', numerator: 19, denominator: 20, source: 'user_supplied' });
  });
  it('is null when no rate is typed, and refuses a bad rate or a missing currency', () => {
    expect(parseVatFxRate({ rate: '  ', currency: 'USD' })).toBeNull();
    expect(() => parseVatFxRate({ rate: 'abc', currency: 'USD' })).toThrow(/not an exchange rate/);
    expect(() => parseVatFxRate({ rate: '0.95', currency: '' })).toThrow(/currency/);
  });
});

describe('vatFxFromArgs', () => {
  it('takes the currency from the one foreign invoice', () => {
    expect(vatFxFromArgs(db, companyId, { rate: '0.95' }, [invoiceId])).toMatchObject({ currency: 'USD', numerator: 95, denominator: 100 });
  });
  it('asks for the currency when the invoices do not name exactly one foreign currency', () => {
    expect(() => vatFxFromArgs(db, companyId, { rate: '0.95' }, [])).toThrow(/--vat-fx-currency/);
  });
  it('refuses a source or date given without a rate', () => {
    expect(() => vatFxFromArgs(db, companyId, { source: 'ECB' }, [invoiceId])).toThrow(/need --vat-fx/);
  });
});

describe('record-payment --vat-fx', () => {
  const receive = (vatFx?: string) => recordPaymentCli(db, {
    companyId, invoices: 'S-1', date: '2026-03-10', unallocated: false, fx: '0.95',
    ...(vatFx ? { vatFx, vatFxSource: 'ECB reference rate', vatFxDate: '2026-03-10' } : {}),
  });
  const t1 = () => buildVat3Return(db, { companyId, vatPeriodId: findVatPeriod(db, companyId, makeDate(2026, 3, 10))!.id }).T1.amountMinor;

  it('converts the released VAT at the rate at the receipt and records its source', () => {
    const paid = receive('0.95');
    // USD 230 of VAT at 0.95 is €218.50.
    expect(paid.vatReleasedBaseMinor).toBe(21_850);
    expect(t1()).toBe(21_850);
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.sourceId, paid.paymentId)).all();
    expect(entry).toMatchObject({ fxRateSource: 'ECB reference rate', fxRateDate: '2026-03-10' });
  });

  it('without it, uses the invoice\'s own rate', () => {
    expect(receive().vatReleasedBaseMinor).toBe(20_700);
  });
});

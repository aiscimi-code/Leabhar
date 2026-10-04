import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { createVatEntries, findVatPeriod } from './engine';
import { validateVatPeriod } from './periodClose';
import { s37RateSource } from './fxRate';
import { makeDate } from '../dates';
import { suppliers, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #614: VAT on an amount in another currency is converted at "the latest
 * selling rate recorded by the Central Bank of Ireland or the European Central
 * Bank for the currency in question at the time the tax becomes due", unless a
 * method is agreed with Revenue (VATCA s.37(4)).
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Dollar Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'NY Supplies', matchKey: 'ny supplies', countryCode: 'IE' }).run();
});

const usdPurchase = (source: string, over: { treatment?: string; statedVatMinor?: number } = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: `U-${Math.random()}`,
  documentId: insertConfirmedDocument(db, companyId), currency: 'USD',
  fxRate: { numerator: 7, denominator: 9, source, date: '2026-03-10' },
  lines: [
    {
      description: 'Parts', netMinor: 1_001, statedVatMinor: 'statedVatMinor' in over ? over.statedVatMinor : 230,
      accountId: byCode['6070']!, vatTreatmentId: tr[over.treatment ?? 'IE_STD']!,
    },
    // A second line whose rounding offsets the first across the invoice, so the
    // journal needs no rounding line (that case is fxRounding.test.ts, #639).
    ...(over.treatment ? [] : [{
      description: 'Fittings', netMinor: 500, statedVatMinor: 115, accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
    }]),
  ],
});
const entriesOf = (invoiceId: string) => db.select().from(vatEntries).where(eq(vatEntries.sourceId, invoiceId)).all();
const findings = () => validateVatPeriod(db, {
  companyId, vatPeriodId: findVatPeriod(db, companyId, makeDate(2026, 3, 10))!.id,
}).findings.filter((f) => f.code === 'fx_rate_not_s37');

describe('the rate sources s.37(4) accepts', () => {
  it('the CBI, the ECB or a method agreed with Revenue; nothing else', () => {
    expect(s37RateSource('ECB')).toBe('european_central_bank');
    expect(s37RateSource('Central Bank of Ireland')).toBe('central_bank_of_ireland');
    expect(s37RateSource('revenue-agreed-method')).toBe('revenue_agreed_method');
    expect(s37RateSource('bank_statement')).toBeNull();
    expect(s37RateSource('invoice')).toBeNull();
    expect(s37RateSource(null)).toBeNull();
  });
});

describe('converting a foreign-currency VAT entry', () => {
  it('records the rate\'s source and date, and derives the base net so the base figures add up', () => {
    const inv = usdPurchase('ecb');
    const e = entriesOf(inv.invoiceId).find((x) => x.netMinor === 1_001);
    expect(e).toMatchObject({ currency: 'USD', fxRateSource: 'ecb', fxRateDate: '2026-03-10' });
    // USD 10.01 + 2.30 = 12.31 at 7/9: VAT 1.79, gross 9.57, so net 7.78.
    // Converting the net on its own would give 7.79, and 7.79 + 1.79 is not 9.57.
    expect(e).toMatchObject({ baseVatMinor: 179, baseGrossMinor: 957, baseNetMinor: 778, baseRecoverableVatMinor: 179 });
    expect(e!.baseNetMinor + e!.baseVatMinor).toBe(e!.baseGrossMinor);
    expect(findings()).toEqual([]);
  });

  it('a reverse charge: the base gross is the base net', () => {
    const inv = usdPurchase('ecb', { treatment: 'NON_EU_SERVICES_RCV', statedVatMinor: undefined });
    const entries = entriesOf(inv.invoiceId);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.baseGrossMinor).toBe(e.baseNetMinor);
      expect(e).toMatchObject({ baseNetMinor: 779, baseVatMinor: 179 });
    }
  });

  it('refuses a foreign amount with no rate, rather than storing it as euro', () => {
    expect(() => createVatEntries(db, {
      companyId, sourceType: 'manual_adjustment', direction: 'sales', treatmentId: tr['IE_STD']!,
      taxPointDate: makeDate(2026, 3, 10), netMinor: 1_000, currency: 'USD', baseCurrency: 'EUR',
    })).toThrow(/s\.37\(4\)/);
  });
});

describe('period validation', () => {
  it('flags VAT converted at a rate whose source is not the CBI, the ECB or an agreed method', () => {
    const inv = usdPurchase('bank_statement');
    usdPurchase('revenue_agreed_method');
    const [f] = findings();
    expect(f).toMatchObject({ severity: 'warning', count: 2, entityIds: entriesOf(inv.invoiceId).map((e) => e.id) });
    expect(f!.detail).toMatch(/bank_statement/);
    expect(f!.detail).toMatch(/s\.37\(4\)/);
  });

  it('an entry in the base currency is not checked', () => {
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'E-1',
      documentId: insertConfirmedDocument(db, companyId),
      lines: [{ description: 'Parts', netMinor: 1_000, accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']! }],
    });
    expect(findings()).toEqual([]);
  });
});

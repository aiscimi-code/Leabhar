import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument, testVatBasis } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { reversePayment } from '../invoicing/reversal';
import { accountBalance, trialBalance } from '../accounting/ledger';
import { buildVat3Return } from './report';
import { createVatEntries, findVatPeriod } from './engine';
import { validateVatPeriod } from './periodClose';
import { s37RateSource } from './fxRate';
import { makeDate } from '../dates';
import { customers, journalLines, suppliers, vatEntries } from '@/db/schema';
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

/**
 * The rate's date (issue #614). s.37(4) takes the latest rate recorded "at the
 * time the tax becomes due": the invoice on the invoice basis (s.74(1)(a)),
 * the receipt on the cash receipts basis (s.74(2)).
 */
describe('the rate\'s date against the tax point', () => {
  let customerId: string;
  beforeEach(() => {
    customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Boston Co', matchKey: 'boston co', countryCode: 'IE' }).run();
  });
  const usdSale = (rateDate: string | undefined) => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId, invoiceNumber: `S-${Math.random()}`,
    currency: 'USD', fxRate: { numerator: 9, denominator: 10, source: 'ecb', date: rateDate },
    lines: [{ description: 'Consulting', netMinor: 100_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  });
  const dated = (code: string) => validateVatPeriod(db, {
    companyId, vatPeriodId: findVatPeriod(db, companyId, makeDate(2026, 3, 10))!.id,
  }).findings.filter((f) => f.code === code);

  it('a rate of the invoice date is not flagged', () => {
    usdSale('2026-03-10');
    expect(dated('fx_rate_date_after_tax_point')).toEqual([]);
    expect(dated('fx_rate_date_before_tax_point')).toEqual([]);
  });

  it('flags output VAT at a rate dated after the tax point, or not dated', () => {
    const late = usdSale('2026-03-12');
    const undated = usdSale(undefined);
    const [f] = dated('fx_rate_date_after_tax_point');
    expect(f).toMatchObject({ severity: 'warning', count: 2 });
    expect(f!.entityIds.sort()).toEqual([...entriesOf(late.invoiceId), ...entriesOf(undated.invoiceId)].map((e) => e.id).sort());
    expect(f!.detail).toMatch(/s\.37\(4\)/);
  });

  it('notes output VAT at a rate dated before the tax point, to check no later rate was recorded', () => {
    usdSale('2026-03-06');
    const [f] = dated('fx_rate_date_before_tax_point');
    expect(f).toMatchObject({ severity: 'info', count: 1 });
    expect(dated('fx_rate_date_after_tax_point')).toEqual([]);
  });

  it('does not check a purchase: its tax point is the deduction, not when the supplier\'s tax became due', () => {
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'P-1',
      documentId: insertConfirmedDocument(db, companyId), currency: 'USD',
      fxRate: { numerator: 9, denominator: 10, source: 'ecb', date: '2026-03-20' },
      lines: [{ description: 'Parts', netMinor: 1_000, statedVatMinor: 230, accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']! }],
    });
    expect(dated('fx_rate_date_after_tax_point')).toEqual([]);
  });
});

describe('a foreign-currency receipt on the cash receipts basis', () => {
  let acc: Record<string, string>;
  let customerId: string;
  beforeEach(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, {
      legalName: 'Cash Dollar Ltd', vatRegistrationStatus: 'registered', ...testVatBasis('cash_receipts'), seedYears: [2026],
    });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    acc = created.accountsByKey;
    tr = created.treatmentsByCode;
    customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Boston Co', matchKey: 'boston co', countryCode: 'IE' }).run();
  });
  // USD 1,000 + 230 VAT invoiced on 20 February at 9/10: the deferral holds €207.00.
  const invoice = () => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: makeDate(2026, 2, 20), customerId, invoiceNumber: 'S-1',
    currency: 'USD', fxRate: { numerator: 9, denominator: 10, source: 'ecb', date: '2026-02-20' },
    lines: [{ description: 'Consulting', netMinor: 100_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  });
  const receive = (invoiceId: string, vatFxRate?: Parameters<typeof recordPayment>[1]['vatFxRate']) => recordPayment(db, {
    companyId, direction: 'received', paymentDate: makeDate(2026, 3, 10), amountMinor: 123_000, currency: 'USD',
    fxRate: { numerator: 95, denominator: 100, source: 'ecb', date: '2026-03-10' },
    allocations: [{ invoiceId, allocatedMinor: 123_000 }],
    vatFxRate,
  });
  const march = () => findVatPeriod(db, companyId, makeDate(2026, 3, 10))!.id;
  const codes = () => validateVatPeriod(db, { companyId, vatPeriodId: march() }).findings.map((f) => f.code);

  it('converts the VAT at the rate at the receipt, when the tax became due (s.74(2))', () => {
    const inv = invoice();
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(20_700);
    const paid = receive(inv.invoiceId, { currency: 'USD', numerator: 95, denominator: 100, source: 'ecb', date: '2026-03-10' });

    // USD 230 at 0.95 is €218.50 of output VAT, in T1 and in the ledger alike.
    expect(paid.vatReleasedBaseMinor).toBe(21_850);
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.sourceId, paid.paymentId)).all();
    expect(entry).toMatchObject({ taxPointDate: '2026-03-10', fxRateSource: 'ecb', fxRateDate: '2026-03-10', baseVatMinor: 21_850 });
    expect(buildVat3Return(db, { companyId, vatPeriodId: march() }).T1.amountMinor).toBe(21_850);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(21_850);
    // The deferral is relieved at what it was booked at; the €11.50 more owed is an exchange loss.
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    const vatFxLine = db.select().from(journalLines).where(eq(journalLines.journalEntryId, paid.journalEntryId)).all()
      .find((l) => l.accountId === acc['fx_gain_loss'] && /output VAT/.test(l.memo ?? ''));
    expect(vatFxLine).toMatchObject({ debitMinor: 1_150, creditMinor: 0 });
    expect(trialBalance(db, { companyId, asOf: makeDate(2026, 12, 31) }).balanced).toBe(true);
    expect(codes()).not.toContain('fx_rate_date_before_tax_point');
    expect(codes()).not.toContain('fx_rate_date_after_tax_point');
  });

  it('reversing the receipt puts every account back where the invoice left it', () => {
    const inv = invoice();
    const paid = receive(inv.invoiceId, { currency: 'USD', numerator: 95, denominator: 100, source: 'ecb', date: '2026-03-10' });
    reversePayment(db, { companyId, paymentId: paid.paymentId, reason: 'Wrong customer' });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(20_700);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['fx_gain_loss']! })).toBe(0);
    expect(buildVat3Return(db, { companyId, vatPeriodId: march() }).T1.amountMinor).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2026, 12, 31) }).balanced).toBe(true);
  });

  it('without it, the invoice\'s rate is used and its earlier date is flagged', () => {
    const paid = receive(invoice().invoiceId);
    expect(paid.vatReleasedBaseMinor).toBe(20_700);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(codes()).toContain('fx_rate_date_before_tax_point');
  });

  it('refuses a rate for the base currency, or for a currency the receipt releases no VAT in', () => {
    const inv = invoice();
    expect(() => receive(inv.invoiceId, { currency: 'EUR', numerator: 1, denominator: 1, source: 'ecb' }))
      .toThrow(/needs no exchange rate/);
    expect(() => receive(inv.invoiceId, { currency: 'GBP', numerator: 115, denominator: 100, source: 'ecb' }))
      .toThrow(/no output VAT on an invoice in GBP/);
  });
});

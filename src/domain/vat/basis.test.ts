import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { recordCashBasisAuthorisation } from '../config/companyStatus';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { writeOffBadDebt } from '../invoicing/badDebts';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import { companies, customers, invoices, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { vatBasisOn, vatBasisForPeriod, invoiceVatDeferred } from './basis';
import { postJournalEntry } from '../accounting/journal';
import { buildFilingPack } from './filingPack';
import { buildRtdReturn } from './rtd';
import { vatPeriods } from '@/db/schema';

/**
 * Issue #608: the cash receipts basis needs Revenue's authorisation (VATCA
 * s.80(1), S.I. 639/2010 reg.25). A sale is on it only from a recorded
 * authorisation; tax already due before it is not due again (s.80(2)(b)).
 */

describe('vatBasisOn', () => {
  const cash = (from: string | null) => ({ vatAccountingBasis: 'cash_receipts' as const, cashBasisAuthorisedFrom: from });

  it('is the invoice basis for an invoice-basis company, authorised or not', () => {
    expect(vatBasisOn({ vatAccountingBasis: 'invoice', cashBasisAuthorisedFrom: null }, '2025-03-01')).toBe('invoice');
    expect(vatBasisOn({ vatAccountingBasis: 'invoice', cashBasisAuthorisedFrom: '2020-01-01' }, '2025-03-01')).toBe('invoice');
  });

  it('is the invoice basis when the cash basis is chosen but no authorisation is recorded', () => {
    expect(vatBasisOn(cash(null), '2025-03-01')).toBe('invoice');
  });

  it('is the cash basis from the authorisation date, inclusive, and the invoice basis before it', () => {
    expect(vatBasisOn(cash('2025-03-01'), '2025-02-28')).toBe('invoice');
    expect(vatBasisOn(cash('2025-03-01'), '2025-03-01')).toBe('cash_receipts');
    expect(vatBasisOn(cash('2025-03-01'), '2025-06-30')).toBe('cash_receipts');
  });
});

describe('vatBasisForPeriod', () => {
  const company = (basis: 'invoice' | 'cash_receipts', from: string | null) => ({ vatAccountingBasis: basis, cashBasisAuthorisedFrom: from });

  it('is cash receipts when the authorisation has effect for the whole period', () => {
    expect(vatBasisForPeriod(company('cash_receipts', '2025-01-01'), '2025-03-01', '2025-04-30'))
      .toMatchObject({ basis: 'cash_receipts', chosenNotInForce: false });
  });

  it('is mixed when the authorisation starts inside the period, and names the date', () => {
    const p = vatBasisForPeriod(company('cash_receipts', '2025-04-01'), '2025-03-01', '2025-04-30');
    expect(p).toMatchObject({ basis: 'mixed', chosenNotInForce: false });
    expect(p.note).toContain('2025-04-01');
  });

  it('is the invoice basis, said to be chosen but not in force, with no authorisation or one after the period', () => {
    const none = vatBasisForPeriod(company('cash_receipts', null), '2025-03-01', '2025-04-30');
    expect(none).toMatchObject({ basis: 'invoice', chosenNotInForce: true });
    expect(none.note).toMatch(/no Revenue authorisation is recorded/);
    const later = vatBasisForPeriod(company('cash_receipts', '2025-05-01'), '2025-03-01', '2025-04-30');
    expect(later).toMatchObject({ basis: 'invoice', chosenNotInForce: true });
    expect(later.note).toContain('2025-05-01');
  });

  it('is the invoice basis, with nothing about the cash basis, for an invoice-basis company', () => {
    const p = vatBasisForPeriod(company('invoice', null), '2025-03-01', '2025-04-30');
    expect(p).toMatchObject({ basis: 'invoice', chosenNotInForce: false });
    expect(p.note).not.toMatch(/cash receipts/);
  });
});

describe('the basis applied to sales', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;
  let acc: Record<string, string>;
  let tr: Record<string, string>;
  let customerId: string;

  const setup = (input: Partial<Parameters<typeof createCompany>[1]> = {}) => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025], ...input });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    acc = created.accountsByKey;
    tr = created.treatmentsByCode;
    customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  };
  beforeEach(() => setup());

  const sale = (date: string, net = 10_000) => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
    lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  });
  const pay = (invoiceId: string, amount: number, date: string) => recordPayment(db, {
    companyId, direction: 'received', paymentDate: asIsoDate(date), amountMinor: amount,
    allocations: [{ invoiceId, allocatedMinor: amount }],
  });
  const salesVat = () => db.select().from(vatEntries).where(eq(vatEntries.direction, 'sales')).all();
  const invoiceRow = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;

  it('a new company is on the invoice basis unless told otherwise', () => {
    const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
    expect(company.vatAccountingBasis).toBe('invoice');
  });

  it('with the cash basis chosen but no authorisation recorded, output VAT is declared on the invoice, not deferred', () => {
    setup({ vatAccountingBasis: 'cash_receipts' });
    const inv = sale('2025-03-10');
    expect(invoiceVatDeferred(db, invoiceRow(inv.invoiceId))).toBe(false);
    expect(salesVat()).toHaveLength(1);
    expect(salesVat()[0]).toMatchObject({ taxPointDate: '2025-03-10', vatMinor: 2_300 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
  });

  it('a sale invoiced before the authorisation is declared on the invoice and not again when paid after it (s.80(2)(b))', () => {
    setup({ vatAccountingBasis: 'cash_receipts' });
    const before = sale('2025-02-10');
    recordCashBasisAuthorisation(db, {
      companyId, eligibility: 'turnover_threshold', authorisedFrom: '2025-03-01', reference: 'REV-1', confirmedBy: 'Joe',
    });
    const after = sale('2025-03-05');

    expect(invoiceVatDeferred(db, invoiceRow(before.invoiceId))).toBe(false);
    expect(invoiceVatDeferred(db, invoiceRow(after.invoiceId))).toBe(true);
    expect(salesVat().map((e) => e.taxPointDate)).toEqual(['2025-02-10']);

    pay(before.invoiceId, 12_300, '2025-03-20');
    pay(after.invoiceId, 12_300, '2025-03-25');
    const declared = salesVat().map((e) => ({ date: e.taxPointDate, vat: e.vatMinor }));
    // The first sale once, on its invoice; the second once, on its receipt.
    expect(declared).toEqual([{ date: '2025-02-10', vat: 2_300 }, { date: '2025-03-25', vat: 2_300 }]);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
  });

  it('a bad debt on a sale declared on the invoice cancels no deferred VAT, whatever the basis is now', () => {
    setup({ vatAccountingBasis: 'cash_receipts' });
    const inv = sale('2025-02-10');
    recordCashBasisAuthorisation(db, {
      companyId, eligibility: 'turnover_threshold', authorisedFrom: '2025-03-01', reference: 'REV-1', confirmedBy: 'Joe',
    });
    const result = writeOffBadDebt(db, {
      companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Liquidation', actor: 'Joe',
    });
    expect(result.vatCancelledMinor).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
  });

  it('records an authorisation given at creation, and refuses one without a reference', () => {
    setup({
      vatAccountingBasis: 'cash_receipts',
      cashBasisAuthorisation: { eligibility: 'turnover_threshold', authorisedFrom: '2025-01-01', reference: 'REV-2', confirmedBy: 'Joe' },
    });
    const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
    expect(company).toMatchObject({ cashBasisAuthorisedFrom: '2025-01-01', cashBasisAuthorisationReference: 'REV-2', cashBasisConfirmedBy: 'Joe' });
    expect(invoiceVatDeferred(db, invoiceRow(sale('2025-03-10').invoiceId))).toBe(true);

    expect(() => setup({
      vatAccountingBasis: 'cash_receipts',
      cashBasisAuthorisation: { eligibility: 'turnover_threshold', authorisedFrom: '2025-01-01', reference: ' ', confirmedBy: 'Joe' },
    })).toThrow(/reference/);
  });
  it('a non-deferred sale whose journal only debits the deferred VAT account is not deferred (review on #626)', () => {
    const journal = postJournalEntry(db, {
      companyId, entryDate: asIsoDate('2025-03-10'), narrative: 'Correction touching deferred VAT',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR', createdBy: 'Test', createdVia: 'user',
      lines: [
        { accountId: acc['vat_on_sales_deferred']!, debitMinor: 2_300, currency: 'EUR' },
        { accountId: acc['vat_on_sales']!, creditMinor: 2_300, currency: 'EUR' },
      ],
    });
    expect(invoiceVatDeferred(db, { companyId, direction: 'sales', vatMinor: 2_300, journalEntryId: journal.id })).toBe(false);
    // The same journal read for a credit note (VAT stored negative) is a deferral the other way round.
    expect(invoiceVatDeferred(db, { companyId, direction: 'sales', vatMinor: -2_300, journalEntryId: journal.id })).toBe(true);
  });

  it('a credit note posted under an authorisation is deferred, and one on the invoice basis is not', () => {
    setup({
      vatAccountingBasis: 'cash_receipts',
      cashBasisAuthorisation: { eligibility: 'turnover_threshold', authorisedFrom: '2025-03-01', reference: 'REV-3', confirmedBy: 'Joe' },
    });
    const credit = (date: string) => createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId, isCreditNote: true,
      lines: [{ description: 'Credit', netMinor: 1_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
    });
    expect(invoiceVatDeferred(db, invoiceRow(credit('2025-03-10').invoiceId))).toBe(true);
    expect(invoiceVatDeferred(db, invoiceRow(credit('2025-02-10').invoiceId))).toBe(false);
  });

  it('the filing pack and RTD describe a chosen but unauthorised cash basis as the invoice basis it was posted on (review on #626)', () => {
    setup({ vatAccountingBasis: 'cash_receipts' });
    sale('2025-03-10');
    const period = db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!;
    const pack = buildFilingPack(db, { companyId, vatPeriodId: period.id });
    expect(pack.vatBasis).toBe('invoice');
    expect(pack.basisNote).toMatch(/no Revenue authorisation is recorded/);
    expect(pack.report.T1.amountMinor).toBe(2_300);
    const rtd = buildRtdReturn(db, { companyId, date: '2025-06-30' });
    expect(rtd.findings.map((f) => f.code)).not.toContain('rtd_cash_basis_sales');

    recordCashBasisAuthorisation(db, {
      companyId, eligibility: 'turnover_threshold', authorisedFrom: '2025-04-01', reference: 'REV-4', confirmedBy: 'Joe',
    });
    expect(buildFilingPack(db, { companyId, vatPeriodId: period.id }).vatBasis).toBe('mixed');
    expect(buildRtdReturn(db, { companyId, date: '2025-06-30' }).findings.map((f) => f.code)).toContain('rtd_cash_basis_sales');
  });
});

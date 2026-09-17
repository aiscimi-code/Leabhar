import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount, systemAccountId } from '../config/setup';
import { createInvoice, InvoicingError } from './invoices';
import { recordPayment, outstandingInvoices, agedAnalysis } from './payments';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { buildVat3Return } from '../vat/report';
import { importStatement } from '../banking/import';
import {
  invoices, journalLines, vatEntries, vatPeriods, customers, suppliers,
  companies, bankTransactions, paymentAllocations, companyOfficers,
} from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;
let supplierId: string;

const setup = (basis: 'invoice' | 'cash_receipts' = 'cash_receipts') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered',
    vatAccountingBasis: basis, seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;

  customerId = ids.customer();
  db.insert(customers).values({
    id: customerId, companyId, name: 'Mulligan Digital Limited',
    matchKey: 'mulligan digital', countryCode: 'IE', vatNumber: 'IE6543217L',
  }).run();

  supplierId = ids.supplier();
  db.insert(suppliers).values({
    id: supplierId, companyId, name: 'Byrne Accountancy',
    matchKey: 'byrne accountancy', countryCode: 'IE', vatNumber: 'IE9876543W',
  }).run();
};

const salesInvoice = (over: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20),
    dueDate: makeDate(2025, 3, 22), customerId,
    invoiceNumber: 'INV-2025-001',
    lines: [{
      description: 'Consulting', netMinor: 100_000,
      accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
    }],
    ...over,
  });

const period = (name: string) =>
  db.select().from(vatPeriods).where(eq(vatPeriods.name, name)).get()!;

const vatFor = (name: string) =>
  buildVat3Return(db, { companyId, vatPeriodId: period(name).id });

describe('sales invoices', () => {
  beforeEach(() => setup('invoice'));

  it('posts debtors, income and VAT on the invoice basis', () => {
    const invoice = salesInvoice();
    expect(invoice.netMinor).toBe(100_000);
    expect(invoice.vatMinor).toBe(23_000);
    expect(invoice.grossMinor).toBe(123_000);
    expect(invoice.vatDeferred).toBe(false);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines[0]).toMatchObject({ accountId: acc['debtors'], debitMinor: 123_000 });
    expect(lines[1]).toMatchObject({ accountId: byCode['4020'], creditMinor: 100_000 });
    expect(lines[2]).toMatchObject({ accountId: acc['vat_on_sales'], creditMinor: 23_000 });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('creates the debtor even though nothing has been paid', () => {
    salesInvoice();
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(123_000);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(0);
  });

  it('puts the VAT in the period of the invoice date', () => {
    salesInvoice();
    expect(vatFor('Jan–Feb 2025').T1.amountMinor).toBe(23_000);
    expect(vatFor('Mar–Apr 2025').T1.amountMinor).toBe(0);
  });

  it('numbers sales invoices sequentially', () => {
    expect(salesInvoice().internalNumber).toBe(1);
    expect(salesInvoice({ invoiceNumber: 'INV-2025-002' }).internalNumber).toBe(2);
  });

  it('handles several lines with different treatments', () => {
    const invoice = salesInvoice({
      lines: [
        {
          description: 'Irish consulting', netMinor: 100_000,
          accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
        },
        {
          description: 'Licence to EU business', netMinor: 50_000,
          accountId: byCode['4000']!, vatTreatmentId: tr['EU_SERVICES_SUPPLY']!,
        },
      ],
    });
    expect(invoice.netMinor).toBe(150_000);
    expect(invoice.vatMinor).toBe(23_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const report = vatFor('Jan–Feb 2025');
    expect(report.T1.amountMinor).toBe(23_000);
    expect(report.ES1.amountMinor).toBe(50_000);
  });

  it('refuses a sales invoice without a customer', () => {
    expect(() => salesInvoice({ customerId: null })).toThrow(/needs a customer/);
  });

  it('refuses an invoice with no lines', () => {
    expect(() => salesInvoice({ lines: [] })).toThrow(/at least one line/);
  });

  it('posts a credit note as the mirror image', () => {
    const credit = salesInvoice({ isCreditNote: true, invoiceNumber: 'CN-001' });
    expect(credit.grossMinor).toBe(-123_000);
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, credit.journalEntryId)).all();
    expect(lines.find((l) => l.accountId === acc['debtors'])!.creditMinor).toBe(123_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });
});

describe('purchase invoices', () => {
  beforeEach(() => setup('cash_receipts'));

  const purchaseInvoice = (over: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 2, 20),
      supplierId, invoiceNumber: 'BAS-0044',
      lines: [{
        description: 'Accountancy', netMinor: 50_000,
        accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
      }],
      ...over,
    });

  it('posts expense, input VAT and creditors', () => {
    const invoice = purchaseInvoice();
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    expect(lines[0]).toMatchObject({ accountId: byCode['6070'], debitMinor: 50_000 });
    expect(lines[1]).toMatchObject({ accountId: acc['vat_on_purchases'], debitMinor: 11_500 });
    expect(lines[2]).toMatchObject({ accountId: acc['creditors'], creditMinor: 61_500 });
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  // The asymmetry that makes the cash receipts basis easy to get wrong.
  it('reclaims input VAT at the invoice date even on the cash receipts basis', () => {
    purchaseInvoice();
    expect(vatFor('Jan–Feb 2025').T2.amountMinor).toBe(11_500);
  });

  it('charges irrecoverable VAT to the expense rather than reclaiming it', () => {
    const invoice = purchaseInvoice({
      lines: [{
        description: 'Client entertainment', netMinor: 50_000,
        accountId: byCode['6110']!, vatTreatmentId: tr['NON_DEDUCTIBLE']!,
      }],
    });
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.journalEntryId)).all();
    expect(lines.find((l) => l.accountId === byCode['6110'])!.debitMinor).toBe(61_500);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_purchases']! })).toBe(0);
  });

  it('self-accounts VAT on a reverse-charge purchase invoice', () => {
    purchaseInvoice({
      lines: [{
        description: 'EU hosting', netMinor: 50_000,
        accountId: byCode['6010']!, vatTreatmentId: tr['EU_SERVICES_RCV']!,
      }],
    });
    const report = vatFor('Jan–Feb 2025');
    expect(report.T1.amountMinor).toBe(11_500);
    expect(report.T2.amountMinor).toBe(11_500);
    expect(report.netPositionMinor).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('refuses a purchase invoice without a supplier', () => {
    expect(() => purchaseInvoice({ supplierId: null })).toThrow(/needs a supplier/);
  });
});

describe('cash receipts basis — deferral and release', () => {
  beforeEach(() => setup('cash_receipts'));

  it('defers output VAT on a sales invoice until payment', () => {
    const invoice = salesInvoice();
    expect(invoice.vatDeferred).toBe(true);

    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.journalEntryId)).all();
    // The VAT is a liability, but a different one: not yet owed to Revenue.
    expect(lines.find((l) => l.accountId === acc['vat_on_sales_deferred'])!.creditMinor)
      .toBe(23_000);
    expect(lines.find((l) => l.accountId === acc['vat_on_sales'])).toBeUndefined();

    // And it is on no VAT return yet.
    expect(vatFor('Jan–Feb 2025').T1.amountMinor).toBe(0);
    expect(invoice.vatEntryIds).toHaveLength(0);
  });

  // The case the whole design exists for: invoiced in one period, paid in the next.
  it('puts the VAT in the period the payment falls in, not the invoice', () => {
    const invoice = salesInvoice({ invoiceDate: makeDate(2025, 2, 20) });

    const payment = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 10),
      amountMinor: 123_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });

    expect(payment.vatReleasedMinor).toBe(23_000);
    expect(vatFor('Jan–Feb 2025').T1.amountMinor).toBe(0);
    expect(vatFor('Mar–Apr 2025').T1.amountMinor).toBe(23_000);
  });

  it('clears the deferred VAT liability once paid', () => {
    const invoice = salesInvoice();
    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 10),
      amountMinor: 123_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(23_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  // A part-payment splits one invoice's VAT across two periods.
  it('releases VAT proportionally on a part-payment', () => {
    const invoice = salesInvoice();

    const first = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 10),
      amountMinor: 61_500,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
    });
    expect(first.vatReleasedMinor).toBe(11_500);
    expect(first.invoiceStatuses[0]).toMatchObject({
      status: 'part_paid', outstandingMinor: 61_500,
    });

    const second = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 5, 12),
      amountMinor: 61_500,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
    });
    expect(second.vatReleasedMinor).toBe(11_500);
    expect(second.invoiceStatuses[0]).toMatchObject({ status: 'paid', outstandingMinor: 0 });

    // One invoice, two periods, and the halves add back to the whole.
    expect(vatFor('Mar–Apr 2025').T1.amountMinor).toBe(11_500);
    expect(vatFor('May–Jun 2025').T1.amountMinor).toBe(11_500);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
  });

  // Rounding each payment's share independently would strand a cent.
  it('releases exactly the invoice VAT across awkward instalments', () => {
    const invoice = salesInvoice({
      lines: [{
        description: 'Odd amount', netMinor: 33_333,
        accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });
    const gross = invoice.grossMinor;
    expect(invoice.vatMinor).toBe(7_667);

    // Three uneven instalments that exactly consume the invoice.
    const parts = [13_333, 13_333, gross - 26_666];
    let released = 0;
    let month = 3;
    for (const part of parts) {
      const payment = recordPayment(db, {
        companyId, direction: 'received', paymentDate: makeDate(2025, month, 10),
        amountMinor: part,
        allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: part }],
      });
      released += payment.vatReleasedMinor;
      month += 2;
    }

    expect(released).toBe(invoice.vatMinor);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('releases VAT per line when treatments differ', () => {
    const invoice = salesInvoice({
      lines: [
        {
          description: 'Irish consulting', netMinor: 100_000,
          accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
        },
        {
          description: 'EU licence', netMinor: 50_000,
          accountId: byCode['4000']!, vatTreatmentId: tr['EU_SERVICES_SUPPLY']!,
        },
      ],
    });

    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 10),
      amountMinor: invoice.grossMinor,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: invoice.grossMinor }],
    });

    const report = vatFor('Mar–Apr 2025');
    expect(report.T1.amountMinor).toBe(23_000);
    // The zero-rated EU supply still reports its net value, in the right period.
    expect(report.ES1.amountMinor).toBe(50_000);
  });

  it('does not defer VAT on purchases', () => {
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 2, 20),
      supplierId, lines: [{
        description: 'Accountancy', netMinor: 50_000,
        accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });
    expect(vatFor('Jan–Feb 2025').T2.amountMinor).toBe(11_500);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
  });
});

describe('payments', () => {
  beforeEach(() => setup('invoice'));

  it('settles a supplier invoice', () => {
    const invoice = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 2, 20),
      supplierId, lines: [{
        description: 'Accountancy', netMinor: 50_000,
        accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });

    recordPayment(db, {
      companyId, direction: 'made', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 61_500,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
    });

    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(-61_500);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('refuses to allocate more than the payment is worth', () => {
    const invoice = salesInvoice();
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 10_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 50_000 }],
    })).toThrow(/cannot settle more than it is worth/);
  });

  it('refuses to allocate more than the invoice still owes', () => {
    const invoice = salesInvoice();
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 200_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 200_000 }],
    })).toThrow(/still outstanding/);
  });

  it('refuses a receipt against a purchase invoice', () => {
    const invoice = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 2, 20),
      supplierId, lines: [{
        description: 'Accountancy', netMinor: 50_000,
        accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 61_500,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
    })).toThrow(/cannot settle a purchase invoice/);
  });

  it('records an unallocated receipt as money on account', () => {
    const invoice = salesInvoice();
    const payment = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 150_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });
    expect(payment.unallocatedMinor).toBe(27_000);
    // The customer is now 27,000 in credit rather than owing anything.
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(-27_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('links a payment to the bank transaction that evidences it', async () => {
    const bankAccountId = addBankAccount(db, {
      companyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: acc['bank_control'],
    });
    await importStatement(db, {
      companyId, bankAccountId, filename: 's.csv',
      content: 'Date,Description,Amount\n01/03/2025,MULLIGAN DIGITAL,1230.00',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    const transaction = db.select().from(bankTransactions).get()!;
    const invoice = salesInvoice();

    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 123_000, bankTransactionId: transaction.id,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });

    const after = db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, transaction.id)).get()!;
    expect(after.status).toBe('posted');
    expect(after.journalEntryId).toBeTruthy();
    // The evidence itself is untouched.
    expect(after.amountMinor).toBe(transaction.amountMinor);
    expect(after.description).toBe(transaction.description);
  });

  it('refuses to link a bank transaction that is already posted on its own', async () => {
    const bankAccountId = addBankAccount(db, {
      companyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: acc['bank_control'],
    });
    await importStatement(db, {
      companyId, bankAccountId, filename: 's.csv',
      content: 'Date,Description,Amount\n01/03/2025,MULLIGAN DIGITAL,1230.00',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    const transaction = db.select().from(bankTransactions).get()!;
    db.update(bankTransactions).set({ journalEntryId: 'je_already' })
      .where(eq(bankTransactions.id, transaction.id)).run();

    const invoice = salesInvoice();
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 123_000, bankTransactionId: transaction.id,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    })).toThrow(/recorded twice/);
  });

  it('settles an invoice paid personally by a director', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({
      id: officerId, companyId, name: 'A. Director', role: 'director',
    }).run();

    const invoice = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 2, 20),
      supplierId, lines: [{
        description: 'Accountancy', netMinor: 50_000,
        accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });

    recordPayment(db, {
      companyId, direction: 'made', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 61_500, officerId,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
    });

    // The company owes the director, and the bank is untouched.
    expect(accountBalance(db, { companyId, accountId: acc['directors_current_account']! }))
      .toBe(61_500);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(0);
  });
});

describe('foreign currency settlement', () => {
  beforeEach(() => setup('invoice'));

  it('posts an exchange difference when the rate moves between invoice and payment', () => {
    // USD 1,000 invoiced at 0.92, paid at 0.95.
    const invoice = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20), customerId,
      currency: 'USD',
      fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
      lines: [{
        description: 'Export consulting', netMinor: 100_000,
        accountId: byCode['4020']!, vatTreatmentId: tr['NON_EU_SERVICES_SUPPLY']!,
      }],
    });
    expect(invoice.grossMinor).toBe(100_000);

    const payment = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 15),
      amountMinor: 100_000, currency: 'USD',
      fxRate: { numerator: 95, denominator: 100, source: 'ecb' },
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 100_000 }],
    });

    // Received EUR 95,000 against a debtor booked at EUR 92,000: a EUR 3,000 gain.
    expect(payment.fxDifferenceMinor).toBe(3_000);
    expect(accountBalance(db, { companyId, accountId: acc['fx_gain_loss']! })).toBe(3_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('posts a loss when the rate moves the other way', () => {
    const invoice = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20), customerId,
      currency: 'USD', fxRate: { numerator: 95, denominator: 100, source: 'ecb' },
      lines: [{
        description: 'Export consulting', netMinor: 100_000,
        accountId: byCode['4020']!, vatTreatmentId: tr['NON_EU_SERVICES_SUPPLY']!,
      }],
    });

    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 15),
      amountMinor: 100_000, currency: 'USD',
      fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 100_000 }],
    });

    expect(accountBalance(db, { companyId, accountId: acc['fx_gain_loss']! })).toBe(-3_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('settles an invoice in a different currency when an fxRate is supplied', () => {
    const invoice = salesInvoice();
    // Invoice is 123_000 EUR; pay 123_000 USD at 0.92 → 113_160 EUR allocated.
    const payment = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 123_000, currency: 'USD',
      fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });

    // The allocation is in the invoice's currency (EUR), not the payment's.
    const alloc = db.select().from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, payment.paymentId)).get()!;
    expect(alloc.allocatedMinor).toBe(113_160);
    expect(alloc.currency).toBe('EUR');

    const after = db.select().from(invoices).where(eq(invoices.id, invoice.invoiceId)).get()!;
    expect(after.paidMinor).toBe(113_160);
    expect(after.outstandingMinor).toBe(123_000 - 113_160);
    expect(after.status).toBe('part_paid');
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('posts an FX gain when a foreign invoice is settled in base at a different rate', () => {
    // USD invoice booked at 0.92 (1 USD = 0.92 EUR), zero-rated export.
    const invoice = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20), customerId,
      currency: 'USD', fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
      lines: [{
        description: 'Export consulting', netMinor: 100_000,
        accountId: byCode['4020']!, vatTreatmentId: tr['NON_EU_SERVICES_SUPPLY']!,
      }],
    });
    // Pay 92_000 EUR (base). fxRate EUR→USD = 95/92, so 92_000 EUR → 95_000 USD.
    // baseAtInvoiceRate = 95_000 USD * 92/100 = 87_400 EUR.
    // baseAtPaymentRate = 92_000 EUR (payment in base).
    // difference = 92_000 - 87_400 = 4_600 EUR gain.
    const payment = recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 15),
      amountMinor: 92_000, currency: 'EUR',
      fxRate: { numerator: 95, denominator: 92, source: 'manual' },
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 92_000 }],
    });

    expect(payment.fxDifferenceMinor).toBe(4_600);
    expect(accountBalance(db, { companyId, accountId: acc['fx_gain_loss']! })).toBe(4_600);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('refuses to settle across currencies when no fxRate is supplied', () => {
    // A USD invoice paid in EUR (base) with no conversion rate.
    const invoice = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20), customerId,
      currency: 'USD', fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
      lines: [{
        description: 'Export consulting', netMinor: 100_000,
        accountId: byCode['4020']!, vatTreatmentId: tr['NON_EU_SERVICES_SUPPLY']!,
      }],
    });
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 100_000, currency: 'EUR',
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 100_000 }],
    })).toThrow(/deliberate conversion/);
  });

  it('refuses a foreign-currency payment with no rate', () => {
    expect(() => recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 123_000, currency: 'USD', allocations: [],
    })).toThrow(/never an assumed 1\.0/);
  });
});

describe('aged analysis', () => {
  beforeEach(() => setup('invoice'));

  it('lists outstanding invoices and ages them', () => {
    salesInvoice({ invoiceDate: makeDate(2025, 1, 5), dueDate: makeDate(2025, 1, 20) });
    salesInvoice({
      invoiceDate: makeDate(2025, 3, 1), dueDate: makeDate(2025, 3, 31),
      invoiceNumber: 'INV-2025-002',
    });

    const open = outstandingInvoices(db, { companyId, direction: 'sales' });
    expect(open).toHaveLength(2);

    const aged = agedAnalysis(db, { companyId, direction: 'sales', asOf: makeDate(2025, 4, 15) });
    expect(aged.totalMinor).toBe(246_000);
    // 20 Jan is 85 days before 15 Apr; 31 Mar is 15 days before.
    expect(aged.buckets.find((b) => b.label === '61–90 days')!.amountMinor).toBe(123_000);
    expect(aged.buckets.find((b) => b.label === '1–30 days')!.amountMinor).toBe(123_000);
  });

  it('drops an invoice from the listing once it is paid', () => {
    const invoice = salesInvoice();
    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 123_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
    });
    expect(outstandingInvoices(db, { companyId, direction: 'sales' })).toHaveLength(0);
  });

  it('keeps a part-paid invoice in the listing at its remaining balance', () => {
    const invoice = salesInvoice();
    recordPayment(db, {
      companyId, direction: 'received', paymentDate: makeDate(2025, 3, 1),
      amountMinor: 23_000,
      allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 23_000 }],
    });
    const open = outstandingInvoices(db, { companyId, direction: 'sales' });
    expect(open).toHaveLength(1);
    expect(open[0]!.outstandingMinor).toBe(100_000);
  });
});

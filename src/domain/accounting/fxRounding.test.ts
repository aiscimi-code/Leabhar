import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany, systemAccountId, addBankAccount } from '../config/setup';
import { recordCashBasisAuthorisation } from '../config/companyStatus';
import { writeOffBadDebt } from '../invoicing/badDebts';
import { classifyTransaction } from '../banking/classify';
import { importStatement } from '../banking/import';
import { accountBalance } from './ledger';
import { createInvoice } from '../invoicing/invoices';
import { withFxRoundingLine } from './journal';
import { asIsoDate, makeDate } from '../dates';
import { bankTransactions, customers, journalLines, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #639: each journal line is converted to base currency on its own, so
 * an invoice that balances in its own currency can be a cent out in euro and
 * was refused outright. The difference now goes visibly to rounding_difference
 * (4099), and only when it is conversion rounding and nothing else.
 */

const usd = { numerator: 7, denominator: 9, source: 'ecb', date: '2026-03-10' };

describe('withFxRoundingLine', () => {
  const lines = [
    { accountId: 'cost', debitMinor: 1_001, currency: 'USD', fxRate: usd },
    { accountId: 'vat', debitMinor: 230, currency: 'USD', fxRate: usd },
    { accountId: 'creditors', creditMinor: 1_231, currency: 'USD', fxRate: usd },
  ];

  it('adds one base-currency line for the conversion difference (#639 figures)', () => {
    // 10.01 → 7.79 and 2.30 → 1.79 debit, 9.58; 12.31 → 9.57 credit.
    const out = withFxRoundingLine(lines, 'EUR', 'rounding');
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ accountId: 'rounding', creditMinor: 1, currency: 'EUR' });
    expect(out[3]!.memo).toMatch(/Rounding on conversion to EUR/);
  });

  it('adds nothing when the conversion already balances', () => {
    const even = [
      { accountId: 'cost', debitMinor: 900, currency: 'USD', fxRate: usd },
      { accountId: 'creditors', creditMinor: 900, currency: 'USD', fxRate: usd },
    ];
    expect(withFxRoundingLine(even, 'EUR', 'rounding')).toBe(even);
  });

  it('never covers an entry that does not balance in its own currency', () => {
    const short = [lines[0]!, lines[1]!, { ...lines[2]!, creditMinor: 1_230 }];
    expect(withFxRoundingLine(short, 'EUR', 'rounding')).toBe(short);
  });

  it('never covers a difference larger than the conversions can produce', () => {
    // Balanced in USD, but a base-currency line two cents out is a real error.
    const off = [...lines, { accountId: 'x', debitMinor: 2, currency: 'EUR' }];
    expect(withFxRoundingLine(off, 'EUR', 'rounding')).toBe(off);
  });

  it('leaves a base-currency entry alone', () => {
    const eur = [
      { accountId: 'a', debitMinor: 5 },
      { accountId: 'b', creditMinor: 5 },
    ];
    expect(withFxRoundingLine(eur, 'EUR', 'rounding')).toBe(eur);
  });
});

describe('posting a foreign-currency invoice', () => {
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

  const linesOf = (journalEntryId: string) => db.select().from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId)).all();

  it('a USD purchase of 10.01 + VAT 2.30 at 7/9 posts, with one cent to rounding_difference', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'NY Supplies', matchKey: 'ny supplies', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId, invoiceNumber: 'U-1',
      documentId: insertConfirmedDocument(db, companyId), currency: 'USD', fxRate: usd,
      lines: [{ description: 'Parts', netMinor: 1_001, statedVatMinor: 230, accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const lines = linesOf(inv.journalEntryId);
    const debit = lines.reduce((s, l) => s + l.baseDebitMinor, 0);
    const credit = lines.reduce((s, l) => s + l.baseCreditMinor, 0);
    expect(debit).toBe(credit);
    const rounding = lines.find((l) => l.accountId === systemAccountId(db, companyId, 'rounding_difference'));
    expect(rounding).toMatchObject({ baseCreditMinor: 1, baseDebitMinor: 0, currency: 'EUR' });
    // The creditor is owed the converted gross, 12.31 USD → 9.57.
    const creditor = lines.find((l) => l.accountId === systemAccountId(db, companyId, 'creditors'));
    expect(creditor).toMatchObject({ baseCreditMinor: 957 });
  });

  it('a USD sale with the same figures posts, with one cent to rounding_difference', () => {
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'NY Buyer', matchKey: 'ny buyer', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId, invoiceNumber: 'S-1',
      currency: 'USD', fxRate: usd,
      lines: [{ description: 'Service', netMinor: 1_001, statedVatMinor: 230, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const lines = linesOf(inv.journalEntryId);
    expect(lines.reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0)).toBe(0);
    const rounding = lines.find((l) => l.accountId === systemAccountId(db, companyId, 'rounding_difference'));
    expect(rounding).toMatchObject({ baseDebitMinor: 1, baseCreditMinor: 0 });
  });

  const balancesWithRounding = (journalEntryId: string, side: 'baseDebitMinor' | 'baseCreditMinor') => {
    const lines = linesOf(journalEntryId);
    expect(lines.reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0)).toBe(0);
    const rounding = lines.find((l) => l.accountId === systemAccountId(db, companyId, 'rounding_difference'));
    expect(rounding?.[side]).toBe(1);
  };

  it('writing off a USD cash-basis sale of 10.01 + VAT 2.30 posts, and clears the deferred VAT', () => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Cash Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'cash_receipts', seedYears: [2026] });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    tr = created.treatmentsByCode;
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'NY Buyer', matchKey: 'ny buyer', countryCode: 'IE' }).run();
    recordCashBasisAuthorisation(db, {
      companyId, eligibility: 'turnover_threshold', authorisedFrom: '2026-01-01', reference: 'REV-1', confirmedBy: 'Joe',
    });
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId, invoiceNumber: 'S-2',
      currency: 'USD', fxRate: usd,
      lines: [{ description: 'Service', netMinor: 1_001, statedVatMinor: 230, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const deferred = systemAccountId(db, companyId, 'vat_on_sales_deferred');
    // 2.30 USD → 1.79 deferred on the invoice.
    expect(accountBalance(db, { companyId, accountId: deferred })).toBe(179);
    const result = writeOffBadDebt(db, {
      companyId, invoiceId: inv.invoiceId, date: asIsoDate('2026-09-30'), reason: 'Liquidation', actor: 'Joe',
    });
    expect(result.vatCancelledMinor).toBe(230);
    // Charge 10.01 → 7.79 and deferred VAT 2.30 → 1.79 against debtors 12.31 → 9.57.
    balancesWithRounding(result.journalEntryId, 'baseCreditMinor');
    expect(accountBalance(db, { companyId, accountId: deferred })).toBe(0);
  });

  it('classifying a USD receipt of 12.31 as a standard-rated sale posts', async () => {
    const usdAccount = addBankAccount(db, {
      companyId, bankName: 'Revolut', accountName: 'USD', currency: 'USD', openingDate: '2026-01-01',
    });
    await importStatement(db, {
      companyId, bankAccountId: usdAccount, filename: 'usd.csv',
      content: 'Date,Description,Amount,Currency\n10/03/2026,NY BUYER,12.31,USD',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount', Currency: 'currency' },
    });
    const tx = db.select().from(bankTransactions).where(eq(bankTransactions.description, 'NY BUYER')).get()!;
    const result = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!, fxRate: usd,
    });
    // Bank 12.31 → 9.57 against income 10.01 → 7.79 and VAT 2.30 → 1.79.
    balancesWithRounding(result.journalEntryId, 'baseDebitMinor');
  });
});

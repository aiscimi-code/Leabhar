import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, voidInvoice } from './invoices';
import { recordPayment } from './payments';
import { writeOffBadDebt, reverseBadDebtWriteOff } from './badDebts';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { invoices, customers, vatEntries, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

const setup = (basis: 'invoice' | 'cash_receipts') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: basis, seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
};
beforeEach(() => setup('invoice'));

const sale = (net: number) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
});
const row = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
const pay = (invoiceId: string, amount: number, date = '2025-04-01') => recordPayment(db, {
  companyId, direction: 'received', paymentDate: asIsoDate(date), amountMinor: amount,
  allocations: [{ invoiceId, allocatedMinor: amount }],
});

describe('bad debts on the invoice basis (#404)', () => {
  it('charges the outstanding gross to bad debts, touches no VAT return, and flags possible relief', () => {
    const inv = sale(10_000); // 123.00
    pay(inv.invoiceId, 2_300);
    const vatBefore = db.select().from(vatEntries).all().length;
    const result = writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Customer in liquidation', actor: 'Joe' });
    expect(result).toMatchObject({ writtenOffMinor: 10_000, vatCancelledMinor: 0 });
    expect(row(inv.invoiceId)).toMatchObject({ status: 'written_off', outstandingMinor: 0, paidMinor: 2_300, writtenOffMinor: 10_000 });
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(10_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(db.select().from(vatEntries).all()).toHaveLength(vatBefore);
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `invoice:${inv.invoiceId}:bad_debt`)).get()!;
    expect(flag.detail).toMatch(/s\.39/);
    balanced();
  });

  it('is reversed when the debt is recovered, and blocks payment and voiding while it stands', () => {
    const inv = sale(10_000);
    writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe' });
    expect(() => pay(inv.invoiceId, 12_300, '2025-10-15')).toThrow(/reverse the write-off first/);
    expect(() => voidInvoice(db, { companyId, invoiceId: inv.invoiceId, voidDate: asIsoDate('2025-10-15'), reason: 'Raised in error' })).toThrow(/Reverse the write-off/);
    expect(() => writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-10-01'), reason: 'Again', actor: 'Joe' })).toThrow(/already/);

    const back = reverseBadDebtWriteOff(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-10-15'), reason: 'Paid after all', actor: 'Joe' });
    expect(back.outstandingMinor).toBe(12_300);
    expect(row(inv.invoiceId)).toMatchObject({ status: 'issued', writtenOffMinor: 0 });
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(0);
    pay(inv.invoiceId, 12_300, '2025-10-15');
    expect(row(inv.invoiceId).status).toBe('paid');
    balanced();
  });

  it('refuses a credit note, a paid invoice, a purchase, a date before the invoice, and no reason', () => {
    const inv = sale(1_000);
    const w = (over: Partial<Parameters<typeof writeOffBadDebt>[1]>) => () => writeOffBadDebt(db, {
      companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe', ...over,
    });
    expect(w({ reason: ' ' })).toThrow(/Say why/);
    expect(w({ date: asIsoDate('2025-01-01') })).toThrow(/before the invoice/);
    expect(w({ accountId: acc['debtors'] })).toThrow(/expense account/);
    pay(inv.invoiceId, 1_230);
    expect(w({})).toThrow(/nothing outstanding/);
  });
});

describe('bad debts on the cash receipts basis (#404)', () => {
  it('cancels the unpaid share of deferred VAT and charges only the net to bad debts', () => {
    setup('cash_receipts');
    const inv = sale(10_000); // 123.00, VAT 23.00 deferred
    pay(inv.invoiceId, 6_150); // half paid: 11.50 VAT released
    const result = writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe' });
    expect(result).toMatchObject({ writtenOffMinor: 6_150, vatCancelledMinor: 1_150 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(1_150);
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(5_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    balanced();
  });
});

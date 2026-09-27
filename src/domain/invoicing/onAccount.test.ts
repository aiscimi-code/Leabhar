import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from './invoices';
import { reversePayment } from './reversal';
import { allocatePaymentOnAccount, paymentsOnAccount, onAccountForInvoice } from './onAccount';
import { settleBankTransaction } from '../consolidation/settle';
import { importStatement } from '../banking/import';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { makeDate, asIsoDate } from '../dates';
import {
  invoices, payments, paymentAllocations, bankTransactions, suppliers, customers, reviewItems, vatEntries,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;
let otherCustomerId: string;

const setup = (basis: 'invoice' | 'cash_receipts' = 'invoice') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: basis, seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy', matchKey: 'murphy', countryCode: 'IE' }).run();
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  otherCustomerId = ids.customer();
  db.insert(customers).values({ id: otherCustomerId, companyId, name: 'Other', matchKey: 'other', countryCode: 'IE' }).run();
};
beforeEach(() => setup());

const sale = (net: number, customer = customerId, date = '2025-03-10') => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId: customer,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
});

async function bankLine(description: string, amount: string, date = '20/03/2025') {
  await importStatement(db, {
    companyId, bankAccountId, filename: `${description}.csv`,
    content: `Date,Description,Amount\n${date},${description},${amount}`, fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return db.select().from(bankTransactions).where(eq(bankTransactions.description, description)).get()!;
}

const receive = (tx: typeof bankTransactions.$inferSelect, allocations: Array<[string, number]>) => settleBankTransaction(db, {
  companyId, bankTransactionId: tx.id,
  allocations: allocations.map(([invoiceId, amountMinor]) => ({ invoiceId, amountMinor })),
});

const invoice = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

describe('payments record whose money it is (#386)', () => {
  it('takes the one customer every allocated invoice belongs to', async () => {
    const a = sale(10_000);
    const tx = await bankLine('MULLIGAN', '150.00');
    const p = receive(tx, [[a.invoiceId, 12_300]]);
    const row = db.select().from(payments).where(eq(payments.id, p.paymentId)).get()!;
    expect([row.customerId, row.supplierId]).toEqual([customerId, null]);
  });

  it('records no party when a payment settles two customers', async () => {
    const a = sale(10_000); const b = sale(10_000, otherCustomerId);
    const tx = await bankLine('BOTH', '246.00');
    const p = receive(tx, [[a.invoiceId, 12_300], [b.invoiceId, 12_300]]);
    const row = db.select().from(payments).where(eq(payments.id, p.paymentId)).get()!;
    expect([row.customerId, row.supplierId]).toEqual([null, null]);
  });
});

describe('allocatePaymentOnAccount (#386)', () => {
  it('applies money held on account to a later invoice without posting a journal', async () => {
    const first = sale(10_000); // 123.00
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    expect(p.unallocatedMinor).toBe(7_700);
    expect(paymentsOnAccount(db, { companyId, customerId }).map((r) => r.onAccountMinor)).toEqual([7_700]);

    const later = sale(5_000, customerId, '2025-04-02'); // 61.50
    expect(onAccountForInvoice(db, { companyId, invoiceId: later.invoiceId }).map((r) => r.paymentId)).toEqual([p.paymentId]);
    const debtorsBefore = accountBalance(db, { companyId, accountId: acc['debtors']! });
    const journalsBefore = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });

    const result = allocatePaymentOnAccount(db, {
      companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 6_150, actor: 'Joe',
    });
    expect(result).toMatchObject({ onAccountMinor: 1_550, invoiceStatus: 'paid', outstandingMinor: 0 });
    expect(invoice(later.invoiceId).paidMinor).toBe(6_150);

    // The ledger is unchanged: both balances were on debtors all along.
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(debtorsBefore);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) })).toEqual(journalsBefore);
    // Debtors = what is still owed less what is held: 0 owed, 15.50 held.
    expect(debtorsBefore).toBe(6_150 - 7_700);
    balanced();

    const row = db.select().from(paymentAllocations).where(eq(paymentAllocations.id, result.allocationId)).get()!;
    expect(row.allocationType).toBe('on_account');

    // The rest is still flagged, until it is all applied.
    const flagged = () => db.select().from(reviewItems).where(and(
      eq(reviewItems.dedupeKey, `bank_transaction:${tx.id}:unallocated`), eq(reviewItems.status, 'open'),
    )).get();
    expect(flagged()).toBeDefined();
    const last = sale(1_260, customerId, '2025-04-10'); // 15.50 (12.60 + 2.90)
    expect(invoice(last.invoiceId).grossMinor).toBe(1_550);
    allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: last.invoiceId, amountMinor: 1_550, actor: 'Joe' });
    expect(flagged()).toBeUndefined();
    expect(paymentsOnAccount(db, { companyId, customerId })).toEqual([]);
  });

  it('refuses another party, more than is on account, and more than is outstanding', async () => {
    const first = sale(10_000);
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    const other = sale(5_000, otherCustomerId);
    expect(() => allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: other.invoiceId, amountMinor: 100, actor: 'Joe' }))
      .toThrow(/different party/);
    const big = sale(20_000);
    expect(() => allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: big.invoiceId, amountMinor: 7_701, actor: 'Joe' }))
      .toThrow(/Only 7700/);
    const small = sale(1_000);
    expect(() => allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: small.invoiceId, amountMinor: 1_231, actor: 'Joe' }))
      .toThrow(/overpay/);
    expect(invoice(small.invoiceId).paidMinor).toBe(0);
  });

  it('reversing the payment reopens invoices paid from its money on account', async () => {
    const first = sale(10_000);
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    const later = sale(5_000);
    allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 6_150, actor: 'Joe' });
    reversePayment(db, { companyId, paymentId: p.paymentId, reason: 'Wrong customer' });
    expect([invoice(first.invoiceId).outstandingMinor, invoice(later.invoiceId).outstandingMinor]).toEqual([12_300, 6_150]);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(12_300 + 6_150);
    expect(() => allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 100, actor: 'Joe' }))
      .toThrow(/reversed/);
    balanced();
  });

  it('refuses a cash-basis sales invoice with VAT (#389)', async () => {
    setup('cash_receipts');
    const first = sale(10_000);
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    const later = sale(5_000);
    expect(() => allocatePaymentOnAccount(db, { companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 6_150, actor: 'Joe' }))
      .toThrow(/cash receipts basis/);
  });
});

describe('settling with a written-off shortfall (#386)', () => {
  it('closes the invoice, posting the shortfall to the chosen account and leaving VAT alone', async () => {
    const inv = sale(10_000); // 123.00 incl. 23.00 VAT
    const vatBefore = db.select().from(vatEntries).all().length;
    const tx = await bankLine('MULLIGAN LESS CHARGES', '120.50');
    const payment = settleBankTransaction(db, {
      companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_050 }],
      writeOff: { invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'Bank charges deducted by the payer\'s bank' },
      actor: 'Joe',
    });
    expect(payment.writtenOffMinor).toBe(250);
    expect(payment.invoiceStatuses).toEqual([{ invoiceId: inv.invoiceId, status: 'paid', outstandingMinor: 0 }]);
    expect(invoice(inv.invoiceId)).toMatchObject({ status: 'paid', outstandingMinor: 0 });
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byCode['6100']! })).toBe(250);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(12_050);
    expect(db.select().from(vatEntries).all().length).toBe(vatBefore);
    balanced();

    const rows = db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.paymentId)).all();
    expect(rows.map((r) => [r.allocationType, r.allocatedMinor]).sort()).toEqual([['settlement', 12_050], ['write_off', 250]]);
    // Flagged: right for bank charges, wrong for a price reduction.
    const flag = db.select().from(reviewItems).where(eq(reviewItems.entityId, inv.invoiceId)).all()
      .find((r) => r.dedupeKey?.includes('write_off'));
    expect(flag?.detail).toMatch(/credit note/);

    // Reversal undoes both, and the invoice is fully open again.
    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Redo' });
    expect(invoice(inv.invoiceId)).toMatchObject({ outstandingMinor: 12_300, paidMinor: 0, status: 'issued' });
    expect(accountBalance(db, { companyId, accountId: byCode['6100']! })).toBe(0);
    balanced();
  });

  it('refuses a write-off with money left over, an asset account, no reason, or on the cash basis', async () => {
    const inv = sale(10_000);
    const tx = await bankLine('MULLIGAN', '120.50');
    const attempt = (writeOff: { invoiceId: string; accountId: string; reason: string }, amountMinor = 12_050) =>
      () => settleBankTransaction(db, {
        companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor }], writeOff,
      });
    expect(attempt({ invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'x' }, 12_000)).toThrow(/not applied/);
    expect(attempt({ invoiceId: inv.invoiceId, accountId: acc['bank_control']!, reason: 'x' })).toThrow(/income or expense/);
    expect(attempt({ invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: ' ' })).toThrow(/Say why/);
    expect(invoice(inv.invoiceId).paidMinor).toBe(0);

    setup('cash_receipts');
    const cashInv = sale(10_000);
    const cashTx = await bankLine('MULLIGAN CASH', '120.50');
    expect(() => settleBankTransaction(db, {
      companyId, bankTransactionId: cashTx.id, allocations: [{ invoiceId: cashInv.invoiceId, amountMinor: 12_050 }],
      writeOff: { invoiceId: cashInv.invoiceId, accountId: byCode['6100']!, reason: 'Bank charges' },
    })).toThrow(/cash receipts basis/);
  });
});

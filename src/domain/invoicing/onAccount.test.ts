import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from './invoices';
import type { PaymentWriteOffReason } from './payments';
import { reversePayment } from './reversal';
import { allocatePaymentOnAccount, paymentsOnAccount, onAccountForInvoice } from './onAccount';
import { settleBankTransaction } from '../consolidation/settle';
import { importStatement } from '../banking/import';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { makeDate, asIsoDate } from '../dates';
import {
  invoices, invoiceLines, payments, paymentAllocations, bankTransactions, suppliers, customers,
  reviewItems, vatEntries, vatPeriods,
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

  it('releases the applied share\u2019s output VAT dated at the receipt, not at the application (#389)', async () => {
    setup('cash_receipts');
    const first = sale(10_000);
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    const later = sale(5_000, customerId, '2025-04-02'); // 61.50 incl. 11.50 VAT, deferred
    expect(invoice(later.invoiceId).paidMinor).toBe(0);

    // Holding the customer's money on account is flagged the moment it is
    // held: its VAT may already be due in the period it arrived (s.80(1)).
    const held = db.select().from(reviewItems).where(and(
      eq(reviewItems.dedupeKey, `payment:${p.paymentId}:on_account_vat`), eq(reviewItems.status, 'open'),
    )).get();
    expect(held?.title).toContain('77.00 received on account from Mulligan on 2025-03-20');
    expect(held?.detail).toContain('s.80(1)');

    const result = allocatePaymentOnAccount(db, {
      companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 6_150, actor: 'Joe',
    });
    expect(result.vatReleasedMinor).toBe(1_150);

    // The tax point is the receipt date, never the application date. (The
    // receipt's own release of the first invoice's VAT carries the same tax
    // point, so the later invoice's release is told apart by its line.)
    const laterLine = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, later.invoiceId)).get()!;
    const entries = db.select().from(vatEntries).where(and(
      eq(vatEntries.sourceType, 'payment'), eq(vatEntries.sourceId, p.paymentId),
    )).all();
    const releasedForLater = entries.filter((e) => e.invoiceLineId === laterLine.id);
    expect(releasedForLater.reduce((sum, e) => sum + e.vatMinor, 0)).toBe(1_150);
    expect(releasedForLater.every((e) => e.taxPointDate === '2025-03-20')).toBe(true);
    // Nothing is declared in the period of the application date (April) that
    // was not declared with the receipt's own tax point.
    expect(entries.every((e) => e.taxPointDate !== '2025-04-02')).toBe(true);

    // The deferred VAT on the applied invoice is fully released: 0 deferred.
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(2_300 + 1_150);
    balanced();

    // Reversing the payment undoes the release with it: both invoices reopen,
    // both releases go back to deferred (the payment journal's own reversal
    // takes the first, the release journal's reversal takes the later one),
    // and the register nets to zero.
    reversePayment(db, { companyId, paymentId: p.paymentId, reason: 'Wrong customer' });
    expect(invoice(later.invoiceId).outstandingMinor).toBe(6_150);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(2_300 + 1_150);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(0);
    const all = db.select().from(vatEntries).all();
    expect(all.reduce((sum, e) => sum + e.vatMinor, 0)).toBe(0);
    balanced();
  });

  it('refuses a locked receipt period and, with a named period, declares late and flags it (#389)', async () => {
    setup('cash_receipts');
    const first = sale(10_000);
    const tx = await bankLine('MULLIGAN', '200.00');
    const p = receive(tx, [[first.invoiceId, 12_300]]);
    const later = sale(5_000, customerId, '2025-04-02');

    // The receipt's own period (Mar-Apr 2025) is filed: nothing may be written
    // into it, and the VAT is never silently moved to the application date.
    const marApr = db.select().from(vatPeriods).where(and(
      eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, 'Mar–Apr 2025'),
    )).get()!;
    db.update(vatPeriods).set({ status: 'submitted' }).where(eq(vatPeriods.id, marApr.id)).run();
    const apply = (vatDeclarationDate?: string) => allocatePaymentOnAccount(db, {
      companyId, paymentId: p.paymentId, invoiceId: later.invoiceId, amountMinor: 6_150, actor: 'Joe',
      ...(vatDeclarationDate ? { vatDeclarationDate } : {}),
    });
    expect(() => apply()).toThrow(/submitted/);
    expect(invoice(later.invoiceId).paidMinor).toBe(0);
    expect(db.select().from(vatEntries).where(eq(vatEntries.sourceId, p.paymentId)).all()
      .filter((e) => e.taxPointDate === '2025-03-20' && e.vatMinor === 1_150)).toHaveLength(0);

    // With a named open period the release is a late declaration: the tax
    // point stays true, the declaration lands in the named period, and the
    // late declaration is flagged for review.
    const result = apply('2025-11-20');
    expect(result.vatReleasedMinor).toBe(1_150);
    const novDec = db.select().from(vatPeriods).where(and(
      eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, 'Nov–Dec 2025'),
    )).get()!;
    const laterLine = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, later.invoiceId)).get()!;
    const entries = db.select().from(vatEntries).where(and(
      eq(vatEntries.sourceType, 'payment'), eq(vatEntries.sourceId, p.paymentId),
    )).all().filter((e) => e.invoiceLineId === laterLine.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.taxPointDate).toBe('2025-03-20');
    expect(entries[0]!.vatPeriodId).toBe(novDec.id);
    const late = db.select().from(reviewItems).where(and(
      eq(reviewItems.kind, 'period_validation'), eq(reviewItems.status, 'open'),
    )).all();
    expect(late.length).toBeGreaterThanOrEqual(1);
    expect(late[0]!.title).toContain('2025-03-20');
    balanced();
  });
});

describe('settling with a written-off shortfall (#386)', () => {
  it('closes the invoice, posting the shortfall to the chosen account and leaving VAT alone', async () => {
    const inv = sale(10_000); // 123.00 incl. 23.00 VAT
    const vatBefore = db.select().from(vatEntries).all().length;
    const tx = await bankLine('MULLIGAN LESS CHARGES', '120.50');
    const payment = settleBankTransaction(db, {
      companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_050 }],
      writeOff: { invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'bank_charges' },
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
    // Flagged with the finding that the collected sources state no Revenue
    // position on bank charges deducted from a payment (issue #389).
    const flag = db.select().from(reviewItems).where(eq(reviewItems.entityId, inv.invoiceId)).all()
      .find((r) => r.dedupeKey?.includes('write_off'));
    expect(flag?.detail).toMatch(/bank charges/);
    expect(flag?.detail).toMatch(/no Revenue position/);

    // Reversal undoes both, and the invoice is fully open again.
    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Redo' });
    expect(invoice(inv.invoiceId)).toMatchObject({ outstandingMinor: 12_300, paidMinor: 0, status: 'issued' });
    expect(accountBalance(db, { companyId, accountId: byCode['6100']! })).toBe(0);
    balanced();
  });

  it('refuses a write-off with money left over, an asset account, or an unknown reason', async () => {
    const inv = sale(10_000);
    const tx = await bankLine('MULLIGAN', '120.50');
    const attempt = (
      writeOff: { invoiceId: string; accountId: string; reason: PaymentWriteOffReason },
      amountMinor = 12_050,
    ) => () => settleBankTransaction(db, {
      companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor }], writeOff,
    });
    expect(attempt({ invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'bank_charges' }, 12_000))
      .toThrow(/not applied/);
    expect(attempt({ invoiceId: inv.invoiceId, accountId: acc['bank_control']!, reason: 'bank_charges' }))
      .toThrow(/income or expense/);
    expect(attempt({ invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'nonsense' as unknown as 'bank_charges' }))
      .toThrow(/Unknown write-off reason/);
    expect(invoice(inv.invoiceId).paidMinor).toBe(0);
  });

  it('releases ALL the deferred VAT when bank charges are deducted from the payment (#389)', async () => {
    setup('cash_receipts');
    const inv = sale(10_000); // 123.00 incl. 23.00 VAT, deferred on the invoice
    const tx = await bankLine('MULLIGAN LESS CHARGES', '120.50');
    const payment = settleBankTransaction(db, {
      companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_050 }],
      writeOff: { invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason: 'bank_charges' },
      actor: 'Joe',
    });

    // The customer paid the full consideration: all 23.00 of VAT is due at
    // the receipt date, and the 2.50 shortfall is the cost of being paid.
    expect(payment.writtenOffMinor).toBe(250);
    expect(payment.vatReleasedBaseMinor).toBe(2_300);
    expect(invoice(inv.invoiceId)).toMatchObject({ status: 'paid', outstandingMinor: 0 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(2_300);
    expect(accountBalance(db, { companyId, accountId: byCode['6100']! })).toBe(250);
    // No deferred VAT is stranded, and no VAT3 entry reports the charges.
    const entries = db.select().from(vatEntries).where(eq(vatEntries.sourceId, payment.paymentId)).all();
    expect(entries.filter((e) => e.direction === 'sales').reduce((sum, e) => sum + e.vatMinor, 0)).toBe(2_300);
    const flag = db.select().from(reviewItems).where(eq(reviewItems.entityId, inv.invoiceId)).all()
      .find((r) => r.dedupeKey?.includes('write_off'));
    expect(flag?.detail).toContain('no Revenue position');
    balanced();
  });

  it('refuses a discount (a credit note is needed) and a bad debt (the bad-debt path owns it) (#389)', async () => {
    const inv = sale(10_000);
    const tx = await bankLine('MULLIGAN', '120.50');
    const attempt = (reason: PaymentWriteOffReason) => () => settleBankTransaction(db, {
      companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_050 }],
      writeOff: { invoiceId: inv.invoiceId, accountId: byCode['6100']!, reason },
    });
    // s.67(1)(b) requires a credit note for a reduction or discount, and
    // s.80(5) makes the VAT on it due anyway if a cash-basis trader issues none.
    expect(attempt('discount')).toThrow(/s\.67\(1\)\(b\)/);
    expect(attempt('discount')).toThrow(/s\.80\(5\)/);
    // Money never received is a bad debt: the #404 path, not this payment.
    expect(attempt('bad_debt')).toThrow(/bad debt/);
    expect(invoice(inv.invoiceId).paidMinor).toBe(0);
    expect(db.select().from(payments).all().length).toBe(0);
  });
});

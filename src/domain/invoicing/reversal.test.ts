import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from './invoices';
import { recordPayment } from './payments';
import { reversePayment } from './reversal';
import { importStatement } from '../banking/import';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { buildVat3Return } from '../vat/report';
import { transactionTrace } from '../consolidation/trace';
import { makeDate, asIsoDate } from '../dates';
import {
  invoices, payments, vatEntries, vatPeriods, bankTransactions, journalEntries, suppliers, customers,
  accountingPeriods, reviewItems,
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

const setup = (basis: 'invoice' | 'cash_receipts' = 'cash_receipts') => {
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
};
beforeEach(() => setup());

const purchase = (net: number, date = '2025-03-10') => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate(date), supplierId, invoiceNumber: `P-${net}`,
  lines: [{ description: 'Goods', netMinor: net, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!, statedVatMinor: Math.round(net * 0.23) }],
});
const sale = (net: number, date = '2025-03-10') => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
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

const pay = (tx: typeof bankTransactions.$inferSelect, allocations: Array<[string, number]>) => recordPayment(db, {
  companyId, direction: tx.amountMinor < 0 ? 'made' : 'received', paymentDate: asIsoDate(tx.transactionDate),
  amountMinor: Math.abs(tx.amountMinor), bankTransactionId: tx.id,
  allocations: allocations.map(([invoiceId, allocatedMinor]) => ({ invoiceId, allocatedMinor })),
});

const invoice = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
const period = (name: string) => db.select().from(vatPeriods).where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;

describe('reversePayment', () => {
  it('reverses a payment that settled several invoices, reopening each for what it paid', async () => {
    const a = purchase(10_000); const b = purchase(20_000);
    const tx = await bankLine('MURPHY', '-369.00');
    const creditorsBefore = accountBalance(db, { companyId, accountId: acc['creditors']! });
    const payment = pay(tx, [[a.invoiceId, 12_300], [b.invoiceId, 24_600]]);
    expect(invoice(a.invoiceId).status).toBe('paid');

    const result = reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong supplier' });
    expect(result.invoiceStatuses.map((s) => [s.status, s.outstandingMinor]).sort()).toEqual([['issued', 12_300], ['issued', 24_600]]);
    expect([invoice(a.invoiceId).paidMinor, invoice(b.invoiceId).paidMinor]).toEqual([0, 0]);

    // The journal is reversed by a new entry, never edited.
    const original = db.select().from(journalEntries).where(eq(journalEntries.id, payment.journalEntryId)).get()!;
    expect(original.reversedByEntryId).toBe(result.reversalJournalEntryId);
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(creditorsBefore);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(0);

    // The payment stays on file, marked; the bank line is free to settle again.
    const row = db.select().from(payments).where(eq(payments.id, payment.paymentId)).get()!;
    expect([row.reversalReason, row.reversedBy]).toEqual(['Wrong supplier', 'user']);
    const line = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect([line.status, line.journalEntryId]).toEqual(['unclassified', null]);
    balanced();

    // Settled again, correctly.
    pay(line, [[a.invoiceId, 12_300], [b.invoiceId, 24_600]]);
    expect([invoice(a.invoiceId).status, invoice(b.invoiceId).status]).toEqual(['paid', 'paid']);
    const trace = transactionTrace(db, { companyId, bankTransactionId: tx.id })!;
    expect(trace.kind).toBe('settled');
    expect(trace.reversals.map((r) => r.reason)).toEqual(['Wrong supplier']);
    balanced();
  });

  it('reverses one part payment and leaves the other', async () => {
    const inv = purchase(100_000);
    const first = await bankLine('PART ONE', '-500.00');
    const second = await bankLine('PART TWO', '-730.00', '25/03/2025');
    const p1 = pay(first, [[inv.invoiceId, 50_000]]);
    pay(second, [[inv.invoiceId, 73_000]]);
    expect(invoice(inv.invoiceId).status).toBe('paid');

    reversePayment(db, { companyId, paymentId: p1.paymentId, reason: 'Paid in error' });
    expect([invoice(inv.invoiceId).status, invoice(inv.invoiceId).paidMinor, invoice(inv.invoiceId).outstandingMinor])
      .toEqual(['part_paid', 73_000, 50_000]);
    // Input VAT stays with the invoice: a payment never carried it.
    expect(db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).all().map((e) => e.vatMinor)).toEqual([23_000]);
    balanced();
  });

  it('reverses the output VAT a receipt released on the cash receipts basis', async () => {
    const inv = sale(100_000);
    const tx = await bankLine('MULLIGAN', '1230.00', '02/04/2025');
    const payment = pay(tx, [[inv.invoiceId, 123_000]]);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2025').id }).T1.amountMinor).toBe(23_000);

    const result = reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Belongs to another invoice' });
    expect(result.reversedVatEntryIds).toHaveLength(1);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2025').id }).T1.amountMinor).toBe(0);
    // Deferred again until the customer pays (the liability's balance, credit-positive).
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(23_000);

    // Received again later: the full VAT is released again, at the new receipt.
    const again = await bankLine('MULLIGAN AGAIN', '1230.00', '10/05/2025');
    pay(again, [[inv.invoiceId, 123_000]]);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T1.amountMinor).toBe(23_000);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    balanced();
  });

  it('never changes a filed VAT return: refuses a reversal dated in a submitted period, allows a later date', async () => {
    const inv = sale(100_000);
    const tx = await bankLine('MULLIGAN', '1230.00', '02/04/2025');
    const payment = pay(tx, [[inv.invoiceId, 123_000]]);
    db.update(vatPeriods).set({ status: 'submitted' }).where(eq(vatPeriods.id, period('Mar–Apr 2025').id)).run();

    expect(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' }))
      .toThrow(/submitted/);
    // Nothing was written.
    expect(db.select().from(payments).where(eq(payments.id, payment.paymentId)).get()!.reversedAt).toBeNull();
    expect(db.select().from(journalEntries).where(eq(journalEntries.id, payment.journalEntryId)).get()!.reversedByEntryId).toBeNull();

    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice', reversalDate: asIsoDate('2025-05-05') });
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2025').id }).T1.amountMinor).toBe(23_000);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T1.amountMinor).toBe(-23_000);
    balanced();
  });

  it('refuses a reversal into a locked accounting period', async () => {
    const inv = purchase(10_000);
    const tx = await bankLine('MURPHY', '-123.00');
    const payment = pay(tx, [[inv.invoiceId, 12_300]]);
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(and(eq(accountingPeriods.companyId, companyId))).run();
    expect(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' })).toThrow(/locked/);
    expect(invoice(inv.invoiceId).status).toBe('paid');
  });

  it('refuses without a reason, twice, or once the bank line is reconciled', async () => {
    const inv = purchase(10_000);
    const tx = await bankLine('MURPHY', '-123.00');
    const payment = pay(tx, [[inv.invoiceId, 12_300]]);
    expect(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: ' ' })).toThrow(/reason/);

    db.update(bankTransactions).set({ reconciliationId: 'rec_1' }).where(eq(bankTransactions.id, tx.id)).run();
    expect(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' })).toThrow(/reconciliation/);
    db.update(bankTransactions).set({ reconciliationId: null }).where(eq(bankTransactions.id, tx.id)).run();

    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' });
    expect(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Again' })).toThrow(/already been reversed/);
  });

  it('closes the "left over" review item of the payment it reverses', async () => {
    const inv = purchase(10_000);
    const tx = await bankLine('MURPHY', '-150.00');
    const payment = pay(tx, [[inv.invoiceId, 12_300]]);
    db.insert(reviewItems).values({
      id: ids.reviewItem(), companyId, kind: 'unmatched_transaction', severity: 'warning', title: 'left over', detail: 'left over',
      entityType: 'bank_transaction', entityId: tx.id, dedupeKey: `bank_transaction:${tx.id}:unallocated`,
    }).run();
    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' });
    expect(db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `bank_transaction:${tx.id}:unallocated`)).get()!.status)
      .toBe('resolved');
  });
});

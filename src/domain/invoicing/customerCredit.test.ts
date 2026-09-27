import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from './invoices';
import { recordPayment } from './payments';
import { reversePayment } from './reversal';
import { applyCreditNote, unapplyCreditNote, refundOnAccount, customerCredit } from './customerCredit';
import { settleBankTransaction } from '../consolidation/settle';
import { importStatement } from '../banking/import';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { invoices, customers, bankTransactions, vatEntries, journalEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;
let otherId: string;

const setup = (basis: 'invoice' | 'cash_receipts' = 'invoice') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: basis, seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, { companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'] });
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  otherId = ids.customer();
  db.insert(customers).values({ id: otherId, companyId, name: 'Other', matchKey: 'other', countryCode: 'IE' }).run();
};
beforeEach(() => setup());

const sale = (net: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const row = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

async function bankLine(description: string, amount: string, date = '20/03/2025') {
  await importStatement(db, {
    companyId, bankAccountId, filename: `${description}.csv`,
    content: `Date,Description,Amount\n${date},${description},${amount}`, fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return db.select().from(bankTransactions).where(eq(bankTransactions.description, description)).get()!;
}

describe('applying a credit note (#402)', () => {
  it('settles an invoice from a credit note without cash, a journal or VAT, and can be undone', () => {
    const inv = sale(10_000); // 123.00
    const cn = sale(2_000, { isCreditNote: true, creditNoteOfId: inv.invoiceId }); // 24.60
    const journals = db.select().from(journalEntries).all().length;
    const vat = db.select().from(vatEntries).all().length;
    const debtors = accountBalance(db, { companyId, accountId: acc['debtors']! });

    const applied = applyCreditNote(db, { companyId, creditNoteId: cn.invoiceId, invoiceId: inv.invoiceId, amountMinor: 2_460, date: asIsoDate('2025-03-15'), actor: 'Joe' });
    expect(applied).toMatchObject({ creditNoteRemainingMinor: 0, invoiceOutstandingMinor: 9_840 });
    expect([row(inv.invoiceId).status, row(cn.invoiceId).status]).toEqual(['part_paid', 'paid']);
    expect(db.select().from(journalEntries).all()).toHaveLength(journals);
    expect(db.select().from(vatEntries).all()).toHaveLength(vat);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(debtors);
    expect(customerCredit(db, { companyId, customerId }).creditNotes).toEqual([]);

    expect(() => reversePayment(db, { companyId, paymentId: applied.paymentId, reason: 'Undo it' })).toThrow(/Unapply/);
    unapplyCreditNote(db, { companyId, paymentId: applied.paymentId, actor: 'Joe', reason: 'Wrong invoice' });
    expect([row(inv.invoiceId).outstandingMinor, row(cn.invoiceId).outstandingMinor]).toEqual([12_300, -2_460]);
    expect(customerCredit(db, { companyId, customerId }).creditNotes.map((c) => c.remainingMinor)).toEqual([2_460]);
    balanced();
  });

  it('refuses another customer, more than is left, or two credit notes', () => {
    const inv = sale(1_000);
    const cn = sale(2_000, { isCreditNote: true });
    const otherInv = sale(5_000, { customerId: otherId });
    const apply = (invoiceId: string, amountMinor: number, creditNoteId = cn.invoiceId) =>
      () => applyCreditNote(db, { companyId, creditNoteId, invoiceId, amountMinor, date: asIsoDate('2025-03-15'), actor: 'Joe' });
    expect(apply(otherInv.invoiceId, 100)).toThrow(/different parties/);
    expect(apply(inv.invoiceId, 1_231)).toThrow(/only 1230 outstanding/);
    expect(apply(inv.invoiceId, 100, inv.invoiceId)).toThrow(/must be a credit note/);
    expect(apply(cn.invoiceId, 100)).toThrow(/not to another credit note/);
  });

  it('on the cash receipts basis leaves the credited VAT deferred, and the rest is released by the receipt', async () => {
    setup('cash_receipts');
    const inv = sale(10_000); // VAT 23.00, deferred
    const cn = sale(2_000, { isCreditNote: true }); // VAT -4.60, deferred
    applyCreditNote(db, { companyId, creditNoteId: cn.invoiceId, invoiceId: inv.invoiceId, amountMinor: 2_460, date: asIsoDate('2025-03-15'), actor: 'Joe' });
    const tx = await bankLine('MULLIGAN', '98.40');
    settleBankTransaction(db, { companyId, bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 9_840 }] });
    expect(row(inv.invoiceId).status).toBe('paid');
    // Everything deferred is now accounted for: 23.00 - 4.60 released by the invoice share, 4.60 cancelled by the credit note.
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(2_300 - 460);
    balanced();
  });
});

describe('refunding money on account (#402)', () => {
  it('refunds from a bank line, lowers what is on account, and blocks reversing the original while it stands', async () => {
    const inv = sale(10_000);
    const inLine = await bankLine('MULLIGAN IN', '150.00');
    const paid = settleBankTransaction(db, { companyId, bankTransactionId: inLine.id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_300 }] });
    expect(customerCredit(db, { companyId, customerId }).totalMinor).toBe(2_700);

    const outLine = await bankLine('REFUND MULLIGAN', '-27.00', '25/03/2025');
    const refund = refundOnAccount(db, { companyId, paymentId: paid.paymentId, amountMinor: 2_700, bankTransactionId: outLine.id, actor: 'Joe', reason: 'Overpaid' });
    expect(refund.onAccountMinor).toBe(0);
    expect(customerCredit(db, { companyId, customerId }).totalMinor).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(15_000 - 2_700);
    expect(db.select().from(bankTransactions).where(eq(bankTransactions.id, outLine.id)).get()!.status).toBe('posted');

    expect(() => reversePayment(db, { companyId, paymentId: paid.paymentId, reason: 'Undo it' })).toThrow(/Reverse the refund first/);
    reversePayment(db, { companyId, paymentId: refund.refundPaymentId, reason: 'Refund bounced' });
    expect(customerCredit(db, { companyId, customerId }).totalMinor).toBe(2_700);
    balanced();
  });

  it('refuses more than is on account, a bank line of the wrong amount or sign, and a missing date', async () => {
    const inv = sale(10_000);
    const p = recordPayment(db, {
      companyId, direction: 'received', paymentDate: asIsoDate('2025-03-12'), amountMinor: 13_000, customerId,
      allocations: [{ invoiceId: inv.invoiceId, allocatedMinor: 12_300 }],
    });
    const refund = (over: Partial<Parameters<typeof refundOnAccount>[1]>) => () => refundOnAccount(db, {
      companyId, paymentId: p.paymentId, amountMinor: 700, actor: 'Joe', reason: 'Overpaid', ...over,
    });
    expect(refund({ amountMinor: 701, date: asIsoDate('2025-03-20'), bankAccountId })).toThrow(/Only 700/);
    expect(refund({})).toThrow(/its date and bank account/);
    const wrong = await bankLine('WRONG', '7.00');
    expect(refund({ bankTransactionId: wrong.id })).toThrow(/this refund is -700/);
    const ok = refundOnAccount(db, { companyId, paymentId: p.paymentId, amountMinor: 700, date: asIsoDate('2025-03-20'), bankAccountId, actor: 'Joe', reason: 'Overpaid' });
    expect(ok.onAccountMinor).toBe(0);
    balanced();
  });
});

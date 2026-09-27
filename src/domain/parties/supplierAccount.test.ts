import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { refundOnAccount } from '../invoicing/customerCredit';
import { paymentsOnAccount } from '../invoicing/onAccount';
import { setSupplierTerms } from './supplierAccount';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { invoices, suppliers, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, { companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'] });
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy', matchKey: 'murphy', countryCode: 'IE' }).run();
});

const bill = (net: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-03-10'), supplierId, documentId: insertConfirmedDocument(db, companyId),
  lines: [{ description: 'Stock', netMinor: net, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const row = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;

describe('supplier payment terms (#410)', () => {
  it('give a bill with no due date one, and a stated due date wins', () => {
    expect(row(bill(1_000).invoiceId).dueDate).toBeNull();
    setSupplierTerms(db, { companyId, supplierId, paymentTermsDays: 45, actor: 'Joe' });
    const derived = row(bill(1_000).invoiceId);
    expect([derived.dueDate, derived.dueDateSource]).toEqual(['2025-04-24', 'supplier_terms']);
    const stated = row(bill(1_000, { dueDate: asIsoDate('2025-03-31') }).invoiceId);
    expect([stated.dueDate, stated.dueDateSource]).toEqual(['2025-03-31', 'stated']);
    expect(db.select().from(auditEvents).where(eq(auditEvents.entityId, supplierId)).all().map((e) => e.field)).toEqual(['payment_terms_days']);
    expect(() => setSupplierTerms(db, { companyId, supplierId, paymentTermsDays: 400, actor: 'Joe' })).toThrow(/0 to 365/);
  });
});

describe('supplier refunds (#410)', () => {
  it('refunds money we overpaid a supplier back into the bank', () => {
    const b = bill(10_000); // 123.00
    const paid = recordPayment(db, {
      companyId, direction: 'made', paymentDate: asIsoDate('2025-03-20'), amountMinor: 15_000, bankAccountId,
      allocations: [{ invoiceId: b.invoiceId, allocatedMinor: 12_300 }],
    });
    expect(paymentsOnAccount(db, { companyId, supplierId }).map((p) => p.onAccountMinor)).toEqual([2_700]);
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(-2_700); // the supplier owes us

    const refund = refundOnAccount(db, {
      companyId, paymentId: paid.paymentId, amountMinor: 2_700, date: asIsoDate('2025-03-28'), bankAccountId,
      actor: 'Joe', reason: 'Supplier refunded the overpayment',
    });
    expect(refund.onAccountMinor).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(-15_000 + 2_700);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('settles a supplier credit note by a refund received', () => {
    const b = bill(10_000);
    recordPayment(db, {
      companyId, direction: 'made', paymentDate: asIsoDate('2025-03-20'), amountMinor: 12_300, bankAccountId,
      allocations: [{ invoiceId: b.invoiceId, allocatedMinor: 12_300 }],
    });
    const credit = bill(2_000, { isCreditNote: true, creditNoteOfId: b.invoiceId }); // 24.60 back to us
    recordPayment(db, {
      companyId, direction: 'received', paymentDate: asIsoDate('2025-04-02'), amountMinor: 2_460, bankAccountId,
      allocations: [{ invoiceId: credit.invoiceId, allocatedMinor: 2_460 }],
    });
    expect(row(credit.invoiceId)).toMatchObject({ status: 'paid', outstandingMinor: 0 });
    expect(accountBalance(db, { companyId, accountId: acc['creditors']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(-12_300 + 2_460);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });
});

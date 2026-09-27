import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from './invoices';
import { recordPayment } from './payments';
import { reversePayment } from './reversal';
import { customerStatement } from './receivables';
import { supplierStatement, reconcileSupplierStatement } from './supplierStatements';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import { suppliers, customers, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { extractPdfText } from '../extraction/pdfText';
import { renderStatementPdf } from '@/lib/receivablesPdf';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Murphy Supplies', matchKey: 'murphy supplies', countryCode: 'IE' }).run();
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const bill = (date: string, number: string, netMinor: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate(date), invoiceNumber: number, supplierId,
  documentId: insertConfirmedDocument(db, companyId),
  lines: [{ description: 'Stock', netMinor, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const pay = (date: string, invoiceId: string, amountMinor: number, over: Partial<Parameters<typeof recordPayment>[1]> = {}) =>
  recordPayment(db, {
    companyId, direction: 'made', paymentDate: asIsoDate(date), amountMinor,
    allocations: [{ invoiceId, allocatedMinor: amountMinor }], ...over,
  });
const creditors = () => accountBalance(db, { companyId, accountId: acc['creditors']! });
const statement = (from = '2025-01-01', to = '2025-12-31') =>
  supplierStatement(db, { companyId, supplierId, from: asIsoDate(from), to: asIsoDate(to) });

describe('supplier statement (#413)', () => {
  it('lists bills, credit notes and payments with a running balance that closes at creditors', () => {
    const first = bill('2025-01-10', 'M-1', 10_000);
    bill('2025-02-10', 'M-2', 5_000);
    createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-02-20'), invoiceNumber: 'MC-1', supplierId,
      isCreditNote: true, creditNoteOfId: first.invoiceId, documentId: insertConfirmedDocument(db, companyId, { documentType: 'credit_note' }),
      lines: [{ description: 'Returned', netMinor: 1_000, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
    });
    pay('2025-03-01', first.invoiceId, 12_300);

    const st = statement();
    expect(st.entries.map((e) => [e.kind, e.reference, e.amountMinor])).toEqual([
      ['invoice', 'M-1', 12_300], ['invoice', 'M-2', 6_150], ['credit_note', 'MC-1', -1_230], ['payment', 'Payment made', -12_300],
    ]);
    expect(st.closingBalanceMinor).toBe(4_920);
    expect(st.closingBalanceMinor).toBe(creditors());
  });

  it('opens a later period where the earlier one closed', () => {
    const first = bill('2025-01-10', 'M-1', 10_000);
    pay('2025-03-01', first.invoiceId, 12_300);
    bill('2025-04-10', 'M-2', 5_000);
    expect(statement('2025-04-01', '2025-12-31').openingBalanceMinor).toBe(statement('2025-01-01', '2025-03-31').closingBalanceMinor);
  });

  it('counts a shortfall written off with a payment, and puts it back when the payment is reversed', () => {
    const first = bill('2025-01-10', 'M-1', 10_000);
    const paid = pay('2025-02-01', first.invoiceId, 12_000, {
      // A discount is refused (VATCA s.67(1)(b)): the shortfall here is bank
      // charges deducted from the payment, which is what the reason names.
      writeOff: { invoiceId: first.invoiceId, accountId: byCode['6120']!, reason: 'bank_charges' },
    });
    expect(statement().closingBalanceMinor).toBe(0);
    expect(creditors()).toBe(0);

    reversePayment(db, { companyId, paymentId: paid.paymentId, reason: 'Bounced' });
    expect(statement().closingBalanceMinor).toBe(12_300);
    expect(creditors()).toBe(12_300);
  });

  it('the customer statement also counts a shortfall written off, so it closes at debtors (#405)', () => {
    const sale = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-01-10'), customerId,
      lines: [{ description: 'Work', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
    });
    recordPayment(db, {
      companyId, direction: 'received', paymentDate: asIsoDate('2025-02-01'), amountMinor: 12_290,
      allocations: [{ invoiceId: sale.invoiceId, allocatedMinor: 12_290 }],
      writeOff: { invoiceId: sale.invoiceId, accountId: byCode['6120']!, reason: 'bank_charges' },
    });
    const st = customerStatement(db, { companyId, customerId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') });
    expect(st.entries.map((e) => e.kind).sort()).toEqual(['invoice', 'payment', 'write_off']);
    expect(st.closingBalanceMinor).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
  });
});

describe('reconciling a supplier\'s statement (#413)', () => {
  it('agrees when their balance and invoices match ours, and flags nothing', () => {
    bill('2025-01-10', 'M-1', 10_000);
    const r = reconcileSupplierStatement(db, {
      companyId, supplierId, asOf: asIsoDate('2025-01-31'), statementBalanceMinor: 12_300, invoiceNumbers: ['m 1'], actor: 'test',
    });
    expect(r).toMatchObject({ ourBalanceMinor: 12_300, differenceMinor: 0, theirsNotHeld: [], oursNotOnTheirs: [] });
    expect(db.select().from(reviewItems).where(eq(reviewItems.entityId, supplierId)).all()).toEqual([]);
  });

  it('shows the difference, the invoices we do not hold and ours they do not show, and adjusts nothing', () => {
    bill('2025-01-10', 'M-1', 10_000);
    bill('2025-01-20', 'M-2', 5_000);
    const before = creditors();
    const r = reconcileSupplierStatement(db, {
      companyId, supplierId, asOf: asIsoDate('2025-01-31'), statementBalanceMinor: 20_000,
      invoiceNumbers: ['M-1', 'M-3'], actor: 'test',
    });
    expect(r.differenceMinor).toBe(20_000 - 18_450);
    expect(r.theirsNotHeld).toEqual(['M-3']);
    expect(r.oursNotOnTheirs.map((o) => o.number)).toEqual(['M-2']);
    expect(creditors()).toBe(before);
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `supplier:${supplierId}:statement:2025-01-31`)).get();
    expect(flag?.detail).toMatch(/do not hold: M-3/);
    expect(flag?.detail).toMatch(/Nothing has been adjusted/);
  });

  it('uses the balance as of the statement date, and ignores a later bill', () => {
    bill('2025-01-10', 'M-1', 10_000);
    bill('2025-03-10', 'M-2', 5_000);
    const r = reconcileSupplierStatement(db, {
      companyId, supplierId, asOf: asIsoDate('2025-01-31'), statementBalanceMinor: 12_300, actor: 'test',
    });
    expect(r).toMatchObject({ ourBalanceMinor: 12_300, differenceMinor: 0, invoiceNumbersChecked: false });
  });

  it('renders as a PDF titled as the supplier account', async () => {
    bill('2025-01-10', 'M-1', 10_000);
    const st = statement();
    const text = await extractPdfText(Buffer.from(await renderStatementPdf({ ...st, customerName: st.supplierName },
      { name: 'Acme Ltd', address: null }, { title: 'Supplier account', balanceLabel: 'Balance owed' })));
    expect(text).toContain('SUPPLIER ACCOUNT');
    expect(text).toContain('Murphy Supplies');
    expect(text).toContain('Balance owed');
    expect(text).toContain('123.00');
  });

  it('keeps to the company', () => {
    expect(() => supplierStatement(db, { companyId: 'co_other', supplierId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toThrow(/not found/);
  });
});

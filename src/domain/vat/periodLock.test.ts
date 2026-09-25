import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice, voidInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { reversePayment } from '../invoicing/reversal';
import { importStatement } from '../banking/import';
import {
  classifyTransaction, reclassifyTransaction, postBankTransactionJournal, recordDirectorPaidExpense,
} from '../banking/classify';
import { createAdjustment } from '../accounting/adjustments';
import { buildVat3Return } from './report';
import { VatPeriodClosedError } from './engine';
import { trialBalance } from '../accounting/ledger';
import { makeDate, asIsoDate } from '../dates';
import {
  vatPeriods, vatEntries, journalEntries, bankTransactions, suppliers, customers, companyOfficers, reviewItems,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #226: a locked or filed VAT return is never changed. Every path that
 * writes VAT entries is tried against a submitted Mar–Apr 2025 period; each
 * must refuse without writing anything, leave the return's boxes exactly as
 * filed, and succeed when the person names an open period to declare in.
 */

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;

const MAY = asIsoDate('2025-05-05');

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
};

const period = (name: string) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
const setStatus = (name: string, status: 'locked' | 'submitted') =>
  db.update(vatPeriods).set({ status }).where(eq(vatPeriods.id, period(name).id)).run();

const purchase = (date: string, net = 10_000, extra: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate(date), supplierId, invoiceNumber: `P-${date}-${net}`,
  lines: [{ description: 'Goods', netMinor: net, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!, statedVatMinor: Math.round(net * 0.23) }],
  ...extra,
});
const sale = (date: string, net = 100_000) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
});
async function bankLine(description: string, amount: string, date: string) {
  await importStatement(db, {
    companyId, bankAccountId, filename: `${description}.csv`,
    content: `Date,Description,Amount\n${date},${description},${amount}`, fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return db.select().from(bankTransactions).where(eq(bankTransactions.description, description)).get()!;
}

/** Everything a refusal must leave untouched. */
const snapshot = () => {
  const r = buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2025').id });
  return {
    boxes: [r.T1.amountMinor, r.T2.amountMinor, r.E1.amountMinor, r.E2.amountMinor, r.ES1.amountMinor, r.ES2.amountMinor, r.netPositionMinor],
    journals: db.select().from(journalEntries).all().length,
    vatEntries: db.select().from(vatEntries).all().length,
  };
};
const expectRefusedUnchanged = (fn: () => unknown, pattern: RegExp = /submitted/) => {
  const before = snapshot();
  expect(fn).toThrow(pattern);
  expect(snapshot()).toEqual(before);
};
const lateFlags = () => db.select().from(reviewItems)
  .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.kind, 'period_validation'))).all();

describe('a filed VAT return is never changed (invoice basis)', () => {
  let marchPurchase: ReturnType<typeof purchase>;
  let marchReceipt: typeof bankTransactions.$inferSelect;

  beforeEach(async () => {
    setup('invoice');
    marchPurchase = purchase('2025-03-10');
    sale('2025-03-12');
    marchReceipt = await bankLine('CASH SALE', '123.00', '15/03/2025');
    classifyTransaction(db, { companyId, bankTransactionId: marchReceipt.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! });
    setStatus('Mar–Apr 2025', 'submitted');
  });

  it('refuses an invoice dated in the filed period, and declares it later only when asked', () => {
    expectRefusedUnchanged(() => purchase('2025-03-20', 5_000));
    expect(VatPeriodClosedError).toBeDefined();

    const late = purchase('2025-03-20', 5_000, { vatDeclarationDate: MAY });
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.sourceId, late.invoiceId)).all();
    expect(entry!.taxPointDate).toBe('2025-03-20');
    expect(entry!.vatPeriodId).toBe(period('May–Jun 2025').id);
    expect(entry!.notes).toMatch(/declared in May–Jun 2025/);
    expect(lateFlags()).toHaveLength(1);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T2.amountMinor).toBe(1_150);
  });

  it('refuses to void into the filed period; voids into an open one without touching the filed return', () => {
    expectRefusedUnchanged(() => voidInvoice(db, {
      companyId, invoiceId: marchPurchase.invoiceId, voidDate: asIsoDate('2025-03-25'), reason: 'Duplicate',
    }));
    const before = snapshot().boxes;
    voidInvoice(db, { companyId, invoiceId: marchPurchase.invoiceId, voidDate: MAY, reason: 'Duplicate' });
    expect(snapshot().boxes).toEqual(before);
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T2.amountMinor).toBe(-2_300);
  });

  it('reclassifies with negative entries in an open period, never by detaching from the filed return', () => {
    expectRefusedUnchanged(() => reclassifyTransaction(db, {
      companyId, bankTransactionId: marchReceipt.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_ZERO']!,
      reason: 'Zero-rated after all',
    }));
    const before = snapshot().boxes;
    reclassifyTransaction(db, {
      companyId, bankTransactionId: marchReceipt.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_ZERO']!,
      reason: 'Zero-rated after all', reversalDate: MAY,
    });
    expect(snapshot().boxes).toEqual(before);
    const may = buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id });
    expect(may.T1.amountMinor).toBe(-2_300);
    // Every original entry is still in the filed period.
    expect(db.select().from(vatEntries).where(eq(vatEntries.sourceId, marchReceipt.id)).all()
      .filter((e) => e.vatPeriodId === period('Mar–Apr 2025').id).map((e) => e.vatMinor)).toEqual([2_300]);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('refuses to classify a new receipt dated in the filed period unless declared later', async () => {
    const tx = await bankLine('LATE SALE', '246.00', '20/04/2025');
    expectRefusedUnchanged(() => classifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!,
    }));
    expect(db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!.journalEntryId).toBeNull();
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!, vatDeclarationDate: MAY,
    });
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T1.amountMinor).toBe(4_600);
  });

  it('refuses a split journal with VAT and a VAT adjustment in the filed period', async () => {
    const tx = await bankLine('SPLIT', '123.00', '22/04/2025');
    expectRefusedUnchanged(() => postBankTransactionJournal(db, {
      companyId, bankTransactionId: tx.id,
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 12_300 },
        { accountId: byCode['4000']!, creditMinor: 10_000 },
        { accountId: acc['vat_on_sales']!, creditMinor: 2_300 },
      ],
      vat: { direction: 'sales', treatmentId: tr['IE_STD']!, netMinor: 10_000, statedVatMinor: 2_300 },
    }));
    expectRefusedUnchanged(() => createAdjustment(db, {
      companyId, date: asIsoDate('2025-04-30'), description: 'VAT correction', reason: 'Missed VAT',
      lines: [
        { accountId: acc['vat_on_purchases']!, debitMinor: 2_300 },
        { accountId: byCode['6120']!, creditMinor: 2_300 },
      ],
      vat: { treatmentId: tr['IE_STD']!, direction: 'purchases', netMinor: 10_000 },
    }));
  });

  it('records a director-paid expense with no invoice in a filed period: it writes no VAT', () => {
    const officerId = ids.officer();
    db.insert(companyOfficers).values({ id: officerId, companyId, name: 'Joe', role: 'director' }).run();
    const result = recordDirectorPaidExpense(db, {
      companyId, officerId, date: asIsoDate('2025-04-02'), description: 'Stationery',
      accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!, grossMinor: 12_300,
    });
    expect(result.vatEntryIds).toEqual([]);
  });

  it('refuses a locked return too, and says to unlock it', () => {
    setStatus('May–Jun 2025', 'locked');
    const before = db.select().from(journalEntries).all().length;
    expect(() => purchase('2025-05-20', 5_000)).toThrow(/locked for filing; unlock it first/);
    expect(db.select().from(journalEntries).all().length).toBe(before);
  });
});

describe('a filed VAT return is never changed (cash receipts basis)', () => {
  it('refuses a receipt that would release VAT into the filed period, and declares it later when asked', async () => {
    setup('cash_receipts');
    const inv = sale('2025-02-10');
    const tx = await bankLine('MULLIGAN', '1230.00', '14/03/2025');
    setStatus('Mar–Apr 2025', 'submitted');
    const pay = (extra: { vatDeclarationDate?: string } = {}) => recordPayment(db, {
      companyId, direction: 'received', paymentDate: asIsoDate('2025-03-14'), amountMinor: 123_000,
      bankTransactionId: tx.id, allocations: [{ invoiceId: inv.invoiceId, allocatedMinor: 123_000 }],
      vatDeclarationDate: extra.vatDeclarationDate ? asIsoDate(extra.vatDeclarationDate) : undefined,
    });
    expectRefusedUnchanged(() => pay());
    expect(db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!.journalEntryId).toBeNull();

    const payment = pay({ vatDeclarationDate: '2025-05-05' });
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T1.amountMinor).toBe(23_000);
    expect(lateFlags()).toHaveLength(1);

    // Reversing it into the filed period is refused too; into an open one it nets out there.
    expectRefusedUnchanged(() => reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice' }));
    reversePayment(db, { companyId, paymentId: payment.paymentId, reason: 'Wrong invoice', reversalDate: MAY });
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2025').id }).T1.amountMinor).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, voidInvoice } from './invoices';
import {
  createRecurringBill, runExpectedBills, matchExpectedBill, unmatchExpectedBill, dismissExpectedBill,
  deactivateRecurringBill, listRecurringBills,
} from './expectedBills';
import { asIsoDate } from '../dates';
import { suppliers, expectedBills, reviewItems, journalEntries, vatEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let landlordId: string;
let otherId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  landlordId = ids.supplier();
  otherId = ids.supplier();
  db.insert(suppliers).values([
    { id: landlordId, companyId, name: 'Quay Properties', matchKey: 'quay properties', countryCode: 'IE' },
    { id: otherId, companyId, name: 'Walsh', matchKey: 'walsh', countryCode: 'IE' },
  ]).run();
});

const rent = (over: Partial<Parameters<typeof createRecurringBill>[1]> = {}) => createRecurringBill(db, {
  companyId, supplierId: landlordId, name: 'Office rent', frequency: 'monthly',
  startDate: asIsoDate('2025-01-01'), expectedNetMinor: 100_000, actor: 'test', ...over,
});
const bill = (date: string, netMinor: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate(date), supplierId: landlordId,
  documentId: insertConfirmedDocument(db, companyId),
  lines: [{ description: 'Rent', netMinor, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const run = (asOf: string) => runExpectedBills(db, { companyId, asOf: asIsoDate(asOf), actor: 'test' });
const occurrences = () => db.select().from(expectedBills).orderBy(expectedBills.expectedDate).all();
const flag = (key: string) => db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, key)).get();

describe('recurring bills as expected bills (#412)', () => {
  it('raises each occurrence once, however often it runs, and posts nothing', () => {
    rent();
    const journals = db.select().from(journalEntries).all().length;
    expect(run('2025-03-05').raised.map((r) => r.expectedDate)).toEqual(['2025-01-01', '2025-02-01', '2025-03-01']);
    expect(run('2025-03-05').raised).toEqual([]);
    expect(occurrences()).toHaveLength(3);
    expect(db.select().from(journalEntries).all().length).toBe(journals);
    expect(db.select().from(vatEntries).all()).toEqual([]);
  });

  it('matches the bill posted from its confirmed document within the window', () => {
    rent();
    const posted = bill('2025-01-04', 100_000);
    const result = run('2025-01-20');
    expect(result.matched).toEqual([expect.objectContaining({ expectedDate: '2025-01-01', invoiceId: posted.invoiceId, differenceMinor: 0 })]);
    expect(occurrences()[0]).toMatchObject({ status: 'matched', invoiceId: posted.invoiceId });
  });

  it('never matches a bill without a confirmed document, another supplier\'s bill, or one outside the window', () => {
    rent();
    bill('2025-01-03', 100_000, { documentId: insertConfirmedDocument(db, companyId, { reviewStatus: 'unreviewed' }) });
    bill('2025-01-03', 100_000, { supplierId: otherId });
    bill('2025-01-25', 100_000);
    expect(run('2025-01-10').matched).toEqual([]);
  });

  it('flags a bill that differs beyond the tolerance, and still matches it', () => {
    rent({ toleranceBasisPoints: 500 });
    bill('2025-01-02', 104_999);
    const within = run('2025-01-10').matched[0]!;
    expect(within.differenceMinor).toBe(4_999);
    expect(flag(`expected_bill:${within.expectedBillId}:difference`)).toBeUndefined();

    bill('2025-02-03', 105_001);
    const over = run('2025-02-10').matched[0]!;
    expect(over.differenceMinor).toBe(5_001);
    expect(flag(`expected_bill:${over.expectedBillId}:difference`)?.detail).toMatch(/beyond the 5\.00% tolerance/);
  });

  it('flags a bill that has not arrived once the window has passed, not before', () => {
    rent({ windowDays: 10 });
    expect(run('2025-01-11').missing).toEqual([]);
    const late = run('2025-01-12').missing;
    expect(late).toEqual([expect.objectContaining({ expectedDate: '2025-01-01' })]);
    expect(flag(`expected_bill:${late[0]!.expectedBillId}:missing`)?.title).toBe('Office rent for 2025-01-01 has not arrived');
  });

  it('leaves two candidate bills for a person, and flags the choice', () => {
    rent();
    bill('2025-01-02', 100_000);
    bill('2025-01-05', 100_000);
    const result = run('2025-01-20');
    expect(result.matched).toEqual([]);
    expect(result.ambiguous[0]!.invoiceIds).toHaveLength(2);
    expect(flag(`expected_bill:${result.ambiguous[0]!.expectedBillId}:ambiguous`)).toBeDefined();
  });

  it('matches by hand, unmatches with a reason, and reopens when the matched bill is voided', () => {
    rent();
    run('2025-01-05');
    const [first] = occurrences();
    const late = bill('2025-01-28', 100_000);
    expect(matchExpectedBill(db, { companyId, expectedBillId: first!.id, invoiceId: late.invoiceId, actor: 'test' }).differenceMinor).toBe(0);
    expect(() => unmatchExpectedBill(db, { companyId, expectedBillId: first!.id, actor: 'test', reason: '' })).toThrow(/Say why/);
    unmatchExpectedBill(db, { companyId, expectedBillId: first!.id, actor: 'test', reason: 'Wrong month' });
    expect(occurrences()[0]!.status).toBe('expected');

    matchExpectedBill(db, { companyId, expectedBillId: first!.id, invoiceId: late.invoiceId, actor: 'test' });
    voidInvoice(db, { companyId, invoiceId: late.invoiceId, reason: 'Posted in error', voidDate: asIsoDate('2025-01-30') });
    run('2025-01-31');
    expect(occurrences()[0]).toMatchObject({ status: 'expected', invoiceId: null });
  });

  it('refuses a hand match to another supplier\'s bill, a sales invoice, or a bill already matched', () => {
    rent();
    run('2025-02-05');
    const [jan, feb] = occurrences();
    const other = bill('2025-01-03', 100_000, { supplierId: otherId });
    expect(() => matchExpectedBill(db, { companyId, expectedBillId: jan!.id, invoiceId: other.invoiceId, actor: 'test' }))
      .toThrow(/different supplier/);
    const posted = bill('2025-01-03', 100_000);
    matchExpectedBill(db, { companyId, expectedBillId: jan!.id, invoiceId: posted.invoiceId, actor: 'test' });
    expect(() => matchExpectedBill(db, { companyId, expectedBillId: feb!.id, invoiceId: posted.invoiceId, actor: 'test' }))
      .toThrow(/already answers/);
  });

  it('dismisses an occurrence with a reason, so it is never flagged missing', () => {
    rent({ windowDays: 5 });
    run('2025-01-02');
    const [jan] = occurrences();
    dismissExpectedBill(db, { companyId, expectedBillId: jan!.id, actor: 'test', reason: 'Rent-free month' });
    expect(run('2025-01-20').missing).toEqual([]);
    expect(occurrences()[0]).toMatchObject({ status: 'dismissed', dismissReason: 'Rent-free month' });
  });

  it('stops raising a deactivated template and lists what it raised', () => {
    const { recurringBillId } = rent();
    run('2025-02-05');
    deactivateRecurringBill(db, { companyId, recurringBillId, actor: 'test' });
    expect(run('2025-06-05').raised).toEqual([]);
    const [summary] = listRecurringBills(db, { companyId, asOf: asIsoDate('2025-06-05') });
    expect(summary).toMatchObject({ active: false, nextDate: null, supplierName: 'Quay Properties' });
    expect(summary!.occurrences.map((o) => [o.expectedDate, o.overdue])).toEqual([['2025-01-01', true], ['2025-02-01', true]]);
  });

  it('refuses a template with no amount, a bad tolerance or window, or an unknown supplier', () => {
    expect(() => rent({ expectedNetMinor: 0 })).toThrow(/positive/);
    expect(() => rent({ toleranceBasisPoints: 20_000 })).toThrow(/tolerance/);
    expect(() => rent({ windowDays: 90 })).toThrow(/window/);
    expect(() => rent({ supplierId: 'sup_nope' })).toThrow(/not found/);
    expect(() => rent({ endDate: asIsoDate('2024-12-01') })).toThrow(/before the start/);
  });
});

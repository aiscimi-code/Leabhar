import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  createRecurringInvoice, postDueRecurringInvoices, listRecurringInvoices, deactivateRecurringInvoice,
} from './recurringInvoices';
import { setCustomerTerms } from '../parties/customerAccount';
import { trialBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { customers, invoices, invoiceLines, vatPeriods, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const retainer = (over: Partial<Parameters<typeof createRecurringInvoice>[1]> = {}) => createRecurringInvoice(db, {
  companyId, customerId, name: 'Monthly retainer', frequency: 'monthly', startDate: asIsoDate('2025-01-31'),
  lines: [
    { description: 'Retainer', netMinor: 100_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
    { description: 'Hosting', netMinor: 5_000, discountBasisPoints: 1_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
  ],
  actor: 'Joe', ...over,
});
const raisedFor = (templateId: string) => db.select().from(invoices)
  .where(eq(invoices.recurringInvoiceId, templateId)).orderBy(invoices.invoiceDate).all();

describe('recurring sales invoices (#394)', () => {
  it('raises each due occurrence once, as an ordinary invoice with VAT, number and due date', () => {
    setCustomerTerms(db, { companyId, customerId, paymentTermsDays: 14, actor: 'Joe' });
    const { templateId } = retainer();
    const first = postDueRecurringInvoices(db, { companyId, upTo: asIsoDate('2025-03-31'), actor: 'Joe' });
    // The 31st steps to month-end: 31 Jan, 28 Feb, 31 Mar.
    expect(first.raised.map((r) => r.date)).toEqual(['2025-01-31', '2025-02-28', '2025-03-31']);
    expect(first.skipped).toEqual([]);

    const rows = raisedFor(templateId);
    expect(rows.map((r) => [r.invoiceDate, r.dueDate, r.netMinor, r.vatMinor, r.reference])).toEqual([
      ['2025-01-31', '2025-02-14', 104_500, 24_035, 'Monthly retainer'],
      ['2025-02-28', '2025-03-14', 104_500, 24_035, 'Monthly retainer'],
      ['2025-03-31', '2025-04-14', 104_500, 24_035, 'Monthly retainer'],
    ]);
    expect(new Set(rows.map((r) => r.invoiceNumber)).size).toBe(3);
    const hosting = db.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, rows[0]!.id), eq(invoiceLines.lineNumber, 2))).get()!;
    expect([hosting.discountMinor, hosting.netMinor]).toEqual([500, 4_500]);

    // Running again raises nothing new.
    const again = postDueRecurringInvoices(db, { companyId, upTo: asIsoDate('2025-03-31'), actor: 'Joe' });
    expect(again.raised).toEqual([]);
    expect(raisedFor(templateId)).toHaveLength(3);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

    const [summary] = listRecurringInvoices(db, { companyId });
    expect(summary).toMatchObject({ raisedCount: 3, lastRaisedDate: '2025-03-31', nextDueDate: '2025-04-30', netMinor: 105_000 });
  });

  it('skips and flags an occurrence in a filed VAT period rather than moving it', () => {
    const { templateId } = retainer({ startDate: asIsoDate('2025-01-15') });
    const jan = db.select().from(vatPeriods).where(and(eq(vatPeriods.companyId, companyId))).all()
      .find((p) => p.startDate <= '2025-01-15' && p.endDate >= '2025-01-15')!;
    db.update(vatPeriods).set({ status: 'submitted' }).where(eq(vatPeriods.id, jan.id)).run();

    const result = postDueRecurringInvoices(db, { companyId, upTo: asIsoDate('2025-03-20'), actor: 'Joe' });
    const all = ['2025-01-15', '2025-02-15', '2025-03-15'];
    const inFiled = all.filter((d) => d >= jan.startDate && d <= jan.endDate);
    expect(inFiled).toContain('2025-01-15');
    expect(result.skipped.map((x) => x.date)).toEqual(inFiled);
    expect(result.raised.map((r) => r.date)).toEqual(all.filter((d) => !inFiled.includes(d)));
    expect(raisedFor(templateId).map((r) => r.invoiceDate)).not.toContain('2025-01-15');
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `recurring_invoice:${templateId}:2025-01-15:skipped`)).get();
    expect(flag?.status).toBe('open');
  });

  it('stops raising once deactivated or past its end date', () => {
    const ended = retainer({ name: 'Ended', endDate: asIsoDate('2025-02-28') });
    const stopped = retainer({ name: 'Stopped' });
    deactivateRecurringInvoice(db, { companyId, templateId: stopped.templateId, actor: 'Joe', reason: 'Contract ended' });
    const result = postDueRecurringInvoices(db, { companyId, upTo: asIsoDate('2025-06-30'), actor: 'Joe' });
    expect(result.raised.map((r) => r.templateName)).toEqual(['Ended', 'Ended']);
    expect(raisedFor(stopped.templateId)).toEqual([]);
    expect(listRecurringInvoices(db, { companyId }).find((t) => t.id === ended.templateId)!.nextDueDate).toBeNull();
  });

  it('refuses a template that could never raise a valid invoice', () => {
    expect(() => retainer({ lines: [] })).toThrow(/at least one line/);
    expect(() => retainer({ lines: [{ description: 'X', netMinor: 0, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] }))
      .toThrow(/positive amount/);
    expect(() => retainer({ endDate: asIsoDate('2024-12-31') })).toThrow(/before the start/);
    expect(() => retainer({ lines: [{ description: 'X', netMinor: 100, discountBasisPoints: 20_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }] }))
      .toThrow(/at most 100%/);
  });
});

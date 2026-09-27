import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  recurringBills, expectedBills, invoices, suppliers, accounts, companies, documents, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, addDays, asIsoDate, daysBetween, type IsoDate } from '../dates';
import { dueOccurrenceDates, occurrenceDate, type RecurringFrequency } from '../accounting/recurring';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';

/**
 * Recurring bills as expected bills (issue #412).
 *
 * Rent, subscriptions and utilities arrive on a schedule, but a bill cannot be
 * raised for them the way a recurring sales invoice is: input VAT comes only
 * from the supplier's confirmed invoice (#234). So each occurrence is an
 * expectation that posts nothing. When the real bill has been posted from its
 * confirmed document it is matched to the expectation; a bill that differs
 * from what was expected by more than the template's tolerance is flagged, and
 * an expectation with no bill once its window has passed is flagged as
 * missing. Nothing is matched when two bills could fit: that is for a person.
 */

const MAX_TOLERANCE_BP = 10_000;
const MAX_WINDOW_DAYS = 45;

export function createRecurringBill(
  db: AppDatabase,
  params: {
    companyId: string; supplierId: string; name: string; frequency: RecurringFrequency;
    startDate: IsoDate; endDate?: IsoDate | null; expectedNetMinor: number;
    accountId?: string | null; toleranceBasisPoints?: number; windowDays?: number;
    notes?: string | null; actor: string;
  },
): { recurringBillId: string } {
  const name = params.name.trim();
  if (!name) throw new InvoicingError('A recurring bill needs a name, e.g. "Office rent".');
  if (!params.actor.trim()) throw new InvoicingError('Say who is setting up this recurring bill.');
  if (!['monthly', 'quarterly', 'yearly'].includes(params.frequency)) {
    throw new InvoicingError('The frequency is monthly, quarterly or yearly.');
  }
  if (params.endDate && params.endDate < params.startDate) throw new InvoicingError('The end date is before the start date.');
  if (!Number.isInteger(params.expectedNetMinor) || params.expectedNetMinor <= 0) {
    throw new InvoicingError('The expected net is a positive amount in minor units.');
  }
  const tolerance = params.toleranceBasisPoints ?? 500;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > MAX_TOLERANCE_BP) {
    throw new InvoicingError('The tolerance is a whole number of basis points between 0 and 10000 (0% to 100%).');
  }
  const windowDays = params.windowDays ?? 10;
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > MAX_WINDOW_DAYS) {
    throw new InvoicingError(`The matching window is between 0 and ${MAX_WINDOW_DAYS} days.`);
  }
  const supplier = db.select().from(suppliers)
    .where(and(eq(suppliers.id, params.supplierId), eq(suppliers.companyId, params.companyId))).get();
  if (!supplier) throw new InvoicingError(`Supplier ${params.supplierId} not found.`);
  if (params.accountId) {
    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId))).get();
    if (!account) throw new InvoicingError(`Account ${params.accountId} not found.`);
  }
  const currency = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, params.companyId)).get()!.c;
  const recurringBillId = ids.recurringBill();
  db.transaction(() => {
    db.insert(recurringBills).values({
      id: recurringBillId, companyId: params.companyId, supplierId: supplier.id, name,
      frequency: params.frequency, startDate: params.startDate, endDate: params.endDate ?? null,
      expectedNetMinor: params.expectedNetMinor, currency, accountId: params.accountId ?? null,
      toleranceBasisPoints: tolerance, windowDays, notes: params.notes ?? null, createdBy: params.actor,
    }).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_bill', entityId: recurringBillId, action: 'created',
      newValue: JSON.stringify({ name, supplierId: supplier.id, frequency: params.frequency, expectedNetMinor: params.expectedNetMinor }),
      source: 'user', actor: params.actor,
    }).run();
  });
  return { recurringBillId };
}

/** Is `diff` beyond `bp` basis points of `expected`? Integer arithmetic only. */
function beyondTolerance(expected: number, diff: number, bp: number): boolean {
  return Math.abs(diff) * 10_000 > expected * bp;
}

type Expected = typeof expectedBills.$inferSelect;
type Template = typeof recurringBills.$inferSelect;
type Bill = typeof invoices.$inferSelect;

/**
 * Bills that could be the one expected: the same supplier and currency, a
 * purchase invoice (not a credit note), not void, posted from a confirmed
 * document, dated within the window, and not already matched to another
 * expectation.
 */
function candidates(db: AppDatabase, template: Template, expected: Expected): Bill[] {
  const from = addDays(asIsoDate(expected.expectedDate), -template.windowDays);
  const to = addDays(asIsoDate(expected.expectedDate), template.windowDays);
  const taken = new Set(db.select({ id: expectedBills.invoiceId }).from(expectedBills)
    .where(eq(expectedBills.companyId, template.companyId)).all().map((r) => r.id).filter(Boolean));
  const bills = db.select().from(invoices).where(and(
    eq(invoices.companyId, template.companyId), eq(invoices.supplierId, template.supplierId),
    eq(invoices.direction, 'purchase'), eq(invoices.isCreditNote, false), eq(invoices.currency, template.currency),
  )).all().filter((b) => b.status !== 'void' && b.invoiceDate >= from && b.invoiceDate <= to && !taken.has(b.id));
  const docIds = bills.map((b) => b.documentId).filter((d): d is string => !!d);
  const confirmed = new Set(docIds.length === 0 ? [] : db.select({ id: documents.id }).from(documents)
    .where(and(inArray(documents.id, docIds), eq(documents.reviewStatus, 'confirmed'))).all().map((d) => d.id));
  return bills.filter((b) => b.documentId && confirmed.has(b.documentId));
}

function recordMatch(
  db: AppDatabase, template: Template, expected: Expected, bill: Bill, actor: string, how: 'auto' | 'user',
): number {
  const differenceMinor = bill.netMinor - expected.expectedNetMinor;
  db.update(expectedBills).set({
    status: 'matched', invoiceId: bill.id, differenceMinor, matchedAt: nowIso(), matchedBy: actor, updatedAt: nowIso(),
  }).where(eq(expectedBills.id, expected.id)).run();
  db.insert(auditEvents).values({
    id: ids.audit(), companyId: template.companyId, occurredAt: nowIso(),
    entityType: 'expected_bill', entityId: expected.id, action: 'document_matched', field: 'invoice_id',
    newValue: JSON.stringify({ invoiceId: bill.id, differenceMinor }), source: how === 'auto' ? 'system' : 'user', actor,
  }).run();
  if (beyondTolerance(expected.expectedNetMinor, differenceMinor, template.toleranceBasisPoints)) {
    const money = (m: number) => (m / 100).toFixed(2);
    upsertReviewItem(db, {
      companyId: template.companyId, kind: 'invoice_total_mismatch', severity: 'warning',
      title: `${template.name} for ${expected.expectedDate} differs from what was expected`,
      detail: `Expected ${money(expected.expectedNetMinor)} net; the bill ${bill.invoiceNumber ?? bill.id} is `
        + `${money(bill.netMinor)} (${differenceMinor > 0 ? '+' : ''}${money(differenceMinor)}), beyond the `
        + `${(template.toleranceBasisPoints / 100).toFixed(2)}% tolerance. Check the bill; if the charge has changed, `
        + 'set up the recurring bill again with the new amount.',
      entityType: 'expected_bill', entityId: expected.id, dedupeKey: `expected_bill:${expected.id}:difference`,
    });
  }
  return differenceMinor;
}

export interface ExpectedBillsRun {
  raised: Array<{ recurringBillId: string; name: string; expectedDate: string }>;
  matched: Array<{ expectedBillId: string; name: string; expectedDate: string; invoiceId: string; differenceMinor: number }>;
  missing: Array<{ expectedBillId: string; name: string; expectedDate: string }>;
  ambiguous: Array<{ expectedBillId: string; name: string; expectedDate: string; invoiceIds: string[] }>;
}

/**
 * Raise every occurrence due by `asOf` (once each, however often this runs),
 * match expectations to the bills that have arrived, and flag the ones whose
 * bill is missing once the window has passed. Nothing is posted.
 */
export function runExpectedBills(
  db: AppDatabase, params: { companyId: string; asOf: IsoDate; actor: string },
): ExpectedBillsRun {
  return db.transaction(() => {
    const run: ExpectedBillsRun = { raised: [], matched: [], missing: [], ambiguous: [] };
    const templates = db.select().from(recurringBills).where(eq(recurringBills.companyId, params.companyId)).all();
    const byId = new Map(templates.map((t) => [t.id, t]));

    for (const template of templates.filter((t) => t.active && t.startDate <= params.asOf)) {
      const have = new Set(db.select({ d: expectedBills.expectedDate }).from(expectedBills)
        .where(eq(expectedBills.recurringBillId, template.id)).all().map((r) => r.d));
      const schedule = {
        frequency: template.frequency, startDate: asIsoDate(template.startDate),
        endDate: template.endDate ? asIsoDate(template.endDate) : null,
      };
      for (const date of dueOccurrenceDates(schedule, params.asOf)) {
        if (have.has(date)) continue;
        db.insert(expectedBills).values({
          id: ids.expectedBill(), companyId: params.companyId, recurringBillId: template.id, expectedDate: date,
          expectedNetMinor: template.expectedNetMinor, currency: template.currency,
        }).run();
        run.raised.push({ recurringBillId: template.id, name: template.name, expectedDate: date });
      }
    }

    // A matched bill that was later voided no longer answers the expectation.
    const matched = db.select().from(expectedBills).where(and(
      eq(expectedBills.companyId, params.companyId), eq(expectedBills.status, 'matched'),
    )).all();
    for (const expected of matched) {
      const bill = expected.invoiceId ? db.select().from(invoices).where(eq(invoices.id, expected.invoiceId)).get() : null;
      if (bill && bill.status !== 'void') continue;
      db.update(expectedBills).set({
        status: 'expected', invoiceId: null, differenceMinor: null, matchedAt: null, matchedBy: null, updatedAt: nowIso(),
      }).where(eq(expectedBills.id, expected.id)).run();
      db.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
        entityType: 'expected_bill', entityId: expected.id, action: 'document_unmatched', field: 'invoice_id',
        previousValue: JSON.stringify({ invoiceId: expected.invoiceId }), source: 'system', actor: params.actor,
        reason: 'The matched bill was voided.',
      }).run();
    }

    const open = db.select().from(expectedBills).where(and(
      eq(expectedBills.companyId, params.companyId), eq(expectedBills.status, 'expected'),
    )).orderBy(expectedBills.expectedDate).all();
    for (const expected of open) {
      const template = byId.get(expected.recurringBillId)!;
      const found = candidates(db, template, expected);
      if (found.length === 1) {
        const differenceMinor = recordMatch(db, template, expected, found[0]!, params.actor, 'auto');
        run.matched.push({ expectedBillId: expected.id, name: template.name, expectedDate: expected.expectedDate, invoiceId: found[0]!.id, differenceMinor });
        continue;
      }
      if (found.length > 1) {
        run.ambiguous.push({ expectedBillId: expected.id, name: template.name, expectedDate: expected.expectedDate, invoiceIds: found.map((b) => b.id) });
        upsertReviewItem(db, {
          companyId: params.companyId, kind: 'uncertain_match', severity: 'warning',
          title: `${template.name} for ${expected.expectedDate}: ${found.length} bills could be the one expected`,
          detail: `Bills ${found.map((b) => b.invoiceNumber ?? b.id).join(', ')} all fit. Nothing was matched; choose the right one.`,
          entityType: 'expected_bill', entityId: expected.id, dedupeKey: `expected_bill:${expected.id}:ambiguous`,
        });
        continue;
      }
      const windowEnd = addDays(asIsoDate(expected.expectedDate), template.windowDays);
      if (params.asOf > windowEnd) {
        run.missing.push({ expectedBillId: expected.id, name: template.name, expectedDate: expected.expectedDate });
        upsertReviewItem(db, {
          companyId: params.companyId, kind: 'missing_document', severity: 'warning',
          title: `${template.name} for ${expected.expectedDate} has not arrived`,
          detail: `No confirmed bill from this supplier dated within ${template.windowDays} days of ${expected.expectedDate} `
            + 'has been posted. Ask the supplier for the invoice, match one dated outside the window, or dismiss this '
            + 'occurrence with a reason if no bill is due.',
          entityType: 'expected_bill', entityId: expected.id, dedupeKey: `expected_bill:${expected.id}:missing`,
        });
      }
    }
    return run;
  });
}

function loadExpected(db: AppDatabase, companyId: string, expectedBillId: string): { expected: Expected; template: Template } {
  const expected = db.select().from(expectedBills)
    .where(and(eq(expectedBills.id, expectedBillId), eq(expectedBills.companyId, companyId))).get();
  if (!expected) throw new InvoicingError(`Expected bill ${expectedBillId} not found.`);
  const template = db.select().from(recurringBills).where(eq(recurringBills.id, expected.recurringBillId)).get()!;
  return { expected, template };
}

/**
 * Match an expectation to a bill by hand — one dated outside the window, or
 * one of several that fit. The bill must be the template's supplier's, in its
 * currency, not void and not already matched elsewhere.
 */
export function matchExpectedBill(
  db: AppDatabase, params: { companyId: string; expectedBillId: string; invoiceId: string; actor: string },
): { differenceMinor: number } {
  const { expected, template } = loadExpected(db, params.companyId, params.expectedBillId);
  if (expected.status !== 'expected') throw new InvoicingError(`This occurrence is already ${expected.status}.`);
  const bill = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!bill) throw new InvoicingError(`Invoice ${params.invoiceId} not found.`);
  if (bill.direction !== 'purchase' || bill.isCreditNote) throw new InvoicingError('Only a bill (a purchase invoice) answers an expected bill.');
  if (bill.supplierId !== template.supplierId) throw new InvoicingError('The bill is from a different supplier.');
  if (bill.status === 'void') throw new InvoicingError('That bill has been voided.');
  if (bill.currency !== expected.currency) throw new InvoicingError(`The bill is in ${bill.currency}; ${expected.currency} was expected.`);
  const other = db.select().from(expectedBills).where(eq(expectedBills.invoiceId, bill.id)).get();
  if (other) throw new InvoicingError(`That bill already answers the occurrence of ${other.expectedDate}.`);
  return db.transaction(() => ({ differenceMinor: recordMatch(db, template, expected, bill, params.actor, 'user') }));
}

/** Undo a match. The bill itself is untouched. */
export function unmatchExpectedBill(
  db: AppDatabase, params: { companyId: string; expectedBillId: string; actor: string; reason: string },
): void {
  const { expected } = loadExpected(db, params.companyId, params.expectedBillId);
  if (expected.status !== 'matched') throw new InvoicingError('This occurrence is not matched.');
  if (params.reason.trim().length < 3) throw new InvoicingError('Say why the match is undone.');
  db.transaction(() => {
    db.update(expectedBills).set({
      status: 'expected', invoiceId: null, differenceMinor: null, matchedAt: null, matchedBy: null, updatedAt: nowIso(),
    }).where(eq(expectedBills.id, expected.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'expected_bill', entityId: expected.id, action: 'document_unmatched', field: 'invoice_id',
      previousValue: JSON.stringify({ invoiceId: expected.invoiceId }), source: 'user', actor: params.actor, reason: params.reason,
    }).run();
  });
}

/** No bill is due for this occurrence (a rent-free month, a cancelled service). */
export function dismissExpectedBill(
  db: AppDatabase, params: { companyId: string; expectedBillId: string; actor: string; reason: string },
): void {
  const { expected } = loadExpected(db, params.companyId, params.expectedBillId);
  if (expected.status === 'matched') throw new InvoicingError('This occurrence is matched to a bill; unmatch it first.');
  if (expected.status === 'dismissed') return;
  if (params.reason.trim().length < 3) throw new InvoicingError('Say why no bill is due.');
  db.transaction(() => {
    db.update(expectedBills).set({ status: 'dismissed', dismissReason: params.reason, updatedAt: nowIso() })
      .where(eq(expectedBills.id, expected.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'expected_bill', entityId: expected.id, action: 'updated', field: 'status', newValue: JSON.stringify('dismissed'),
      source: 'user', actor: params.actor, reason: params.reason,
    }).run();
  });
}

/** Stop expecting a recurring bill. Occurrences already raised are kept. */
export function deactivateRecurringBill(
  db: AppDatabase, params: { companyId: string; recurringBillId: string; actor: string; reason?: string | null },
): void {
  const template = db.select().from(recurringBills)
    .where(and(eq(recurringBills.id, params.recurringBillId), eq(recurringBills.companyId, params.companyId))).get();
  if (!template) throw new InvoicingError(`Recurring bill ${params.recurringBillId} not found.`);
  if (!template.active) return;
  db.transaction(() => {
    db.update(recurringBills).set({ active: false, updatedAt: nowIso() }).where(eq(recurringBills.id, template.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_bill', entityId: template.id, action: 'deactivated',
      source: 'user', actor: params.actor, reason: params.reason ?? null,
    }).run();
  });
}

export interface RecurringBillSummary {
  id: string; name: string; supplierId: string; supplierName: string; frequency: RecurringFrequency;
  startDate: string; endDate: string | null; active: boolean; expectedNetMinor: number; currency: string;
  toleranceBasisPoints: number; windowDays: number; nextDate: string | null;
  occurrences: Array<{
    id: string; expectedDate: string; expectedNetMinor: number; status: 'expected' | 'matched' | 'dismissed';
    overdue: boolean; invoiceId: string | null; invoiceNumber: string | null; differenceMinor: number | null;
    dismissReason: string | null;
  }>;
}

export function listRecurringBills(
  db: AppDatabase, params: { companyId: string; asOf: IsoDate },
): RecurringBillSummary[] {
  const rows = db.select({ template: recurringBills, supplierName: suppliers.name })
    .from(recurringBills).innerJoin(suppliers, eq(recurringBills.supplierId, suppliers.id))
    .where(eq(recurringBills.companyId, params.companyId)).orderBy(recurringBills.name).all();
  return rows.map(({ template, supplierName }) => {
    const occurrences = db.select({ e: expectedBills, number: invoices.invoiceNumber }).from(expectedBills)
      .leftJoin(invoices, eq(expectedBills.invoiceId, invoices.id))
      .where(eq(expectedBills.recurringBillId, template.id)).orderBy(expectedBills.expectedDate).all()
      .map(({ e, number }) => ({
        id: e.id, expectedDate: e.expectedDate, expectedNetMinor: e.expectedNetMinor, status: e.status,
        overdue: e.status === 'expected' && daysBetween(asIsoDate(e.expectedDate), params.asOf) > template.windowDays,
        invoiceId: e.invoiceId, invoiceNumber: number ?? null, differenceMinor: e.differenceMinor, dismissReason: e.dismissReason,
      }));
    const have = new Set(occurrences.map((o) => o.expectedDate));
    let nextDate: string | null = null;
    if (template.active) {
      for (let i = 0; i < 2_000; i++) {
        const date = occurrenceDate({ frequency: template.frequency, startDate: asIsoDate(template.startDate) }, i);
        if (template.endDate && date > template.endDate) break;
        if (!have.has(date)) { nextDate = date; break; }
      }
    }
    return {
      id: template.id, name: template.name, supplierId: template.supplierId, supplierName,
      frequency: template.frequency, startDate: template.startDate, endDate: template.endDate, active: template.active,
      expectedNetMinor: template.expectedNetMinor, currency: template.currency,
      toleranceBasisPoints: template.toleranceBasisPoints, windowDays: template.windowDays, nextDate, occurrences,
    };
  });
}

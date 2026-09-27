import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  recurringInvoices, recurringInvoiceLines, invoices, customers, accounts, vatTreatments, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate, type IsoDate } from '../dates';
import { atomically, assertAccountingPeriodOpen } from '../accounting/journal';
import { NoPeriodError, PeriodLockedError } from '../accounting/errors';
import { dueOccurrenceDates, occurrenceDate, type RecurringFrequency } from '../accounting/recurring';
import { assertVatPeriodWritable, VatPeriodClosedError } from '../vat/engine';
import { upsertReviewItem } from '../extraction/service';
import { createInvoice, lineDiscount, InvoicingError } from './invoices';

/**
 * Recurring sales invoices (issue #394).
 *
 * A template, not an invoice: nothing reaches the books when it is defined.
 * Each occurrence is raised by `createInvoice` as an ordinary invoice with its
 * own number, VAT and due date from the customer's terms. An occurrence is
 * identified by its template and date (a unique index on the invoice), so the
 * due-post can run any number of times and raises each occurrence once.
 *
 * An occurrence whose date falls in a locked accounting period or a locked or
 * filed VAT period is not raised and not moved: it is reported as skipped and
 * becomes a review item, for a person to decide.
 */

export interface RecurringInvoiceLineInput {
  description: string;
  netMinor: number;
  discountBasisPoints?: number;
  accountId: string;
  vatTreatmentId: string;
}

export function createRecurringInvoice(
  db: AppDatabase,
  params: {
    companyId: string; customerId: string; name: string; frequency: RecurringFrequency;
    startDate: IsoDate; endDate?: IsoDate | null; lines: RecurringInvoiceLineInput[];
    notes?: string | null; actor: string;
  },
): { templateId: string } {
  const name = params.name.trim();
  if (!name) throw new InvoicingError('A recurring invoice needs a name, e.g. "Monthly retainer".');
  if (!params.actor.trim()) throw new InvoicingError('Say who is setting up this recurring invoice.');
  if (!['monthly', 'quarterly', 'yearly'].includes(params.frequency)) {
    throw new InvoicingError('The frequency is monthly, quarterly or yearly.');
  }
  if (params.endDate && params.endDate < params.startDate) {
    throw new InvoicingError('The end date is before the start date.');
  }
  const customer = db.select().from(customers)
    .where(and(eq(customers.id, params.customerId), eq(customers.companyId, params.companyId))).get();
  if (!customer) throw new InvoicingError(`Customer ${params.customerId} not found.`);
  if (!customer.active) throw new InvoicingError(`${customer.name} is not an active customer.`);
  if (params.lines.length === 0) throw new InvoicingError('A recurring invoice needs at least one line.');

  params.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.description.trim()) throw new InvoicingError(`Line ${n} needs a description.`);
    if (!Number.isInteger(line.netMinor) || line.netMinor <= 0) {
      throw new InvoicingError(`Line ${n}: the net is a positive amount in minor units.`);
    }
    lineDiscount(line.netMinor, { discountBasisPoints: line.discountBasisPoints }, n);
    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, params.companyId))).get();
    if (!account) throw new InvoicingError(`Line ${n}: account ${line.accountId} not found.`);
    const treatment = db.select().from(vatTreatments)
      .where(and(eq(vatTreatments.id, line.vatTreatmentId), eq(vatTreatments.companyId, params.companyId))).get();
    if (!treatment) throw new InvoicingError(`Line ${n}: VAT treatment ${line.vatTreatmentId} not found.`);
    if (treatment.direction === 'purchases') {
      throw new InvoicingError(`Line ${n}: "${treatment.name}" is a purchase treatment; a sales invoice needs a sales one.`);
    }
  });

  const templateId = ids.recurringInvoice();
  db.transaction(() => {
    db.insert(recurringInvoices).values({
      id: templateId, companyId: params.companyId, customerId: customer.id, name,
      frequency: params.frequency, startDate: params.startDate, endDate: params.endDate ?? null,
      notes: params.notes ?? null, createdBy: params.actor,
    }).run();
    params.lines.forEach((line, i) => {
      db.insert(recurringInvoiceLines).values({
        id: ids.recurringInvoiceLine(), recurringInvoiceId: templateId, companyId: params.companyId,
        lineNumber: i + 1, description: line.description.trim(), netMinor: line.netMinor,
        discountBasisPoints: line.discountBasisPoints ?? null,
        accountId: line.accountId, vatTreatmentId: line.vatTreatmentId,
      }).run();
    });
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_invoice', entityId: templateId, action: 'created',
      newValue: JSON.stringify({ name, customerId: customer.id, frequency: params.frequency, startDate: params.startDate }),
      source: 'user', actor: params.actor,
    }).run();
  });
  return { templateId };
}

export interface RaisedOccurrence { templateId: string; templateName: string; date: IsoDate; invoiceId: string; invoiceNumber: string | null }
export interface SkippedInvoiceOccurrence { templateId: string; templateName: string; date: IsoDate; reason: string }

const raisedDates = (db: AppDatabase, templateId: string): Set<string> => new Set(
  db.select({ d: invoices.recurringDate }).from(invoices)
    .where(and(eq(invoices.recurringInvoiceId, templateId), isNotNull(invoices.recurringDate))).all()
    .map((r) => r.d!),
);

/**
 * Raise every due occurrence of every active template, up to `upTo`. Every
 * occurrence's periods are checked before anything is raised, so the batch
 * completes or raises nothing; an occurrence that cannot be raised is skipped,
 * reported and flagged.
 */
export function postDueRecurringInvoices(
  db: AppDatabase, params: { companyId: string; upTo: IsoDate; actor: string; requestId?: string },
): { raised: RaisedOccurrence[]; skipped: SkippedInvoiceOccurrence[] } {
  return atomically(db, () => {
    const templates = db.select().from(recurringInvoices).where(and(
      eq(recurringInvoices.companyId, params.companyId), eq(recurringInvoices.active, true),
    )).orderBy(recurringInvoices.startDate).all();

    const skipped: SkippedInvoiceOccurrence[] = [];
    const due: Array<{ template: typeof recurringInvoices.$inferSelect; date: IsoDate }> = [];
    for (const template of templates) {
      if (template.startDate > params.upTo) continue;
      const done = raisedDates(db, template.id);
      const schedule = {
        frequency: template.frequency, startDate: asIsoDate(template.startDate),
        endDate: template.endDate ? asIsoDate(template.endDate) : null,
      };
      for (const date of dueOccurrenceDates(schedule, params.upTo)) {
        if (done.has(date)) continue;
        try {
          assertAccountingPeriodOpen(db, params.companyId, date);
          assertVatPeriodWritable(db, params.companyId, date, `The ${template.name} invoice`);
        } catch (error) {
          if (error instanceof NoPeriodError || error instanceof PeriodLockedError || error instanceof VatPeriodClosedError) {
            skipped.push({ templateId: template.id, templateName: template.name, date, reason: error.message });
            continue;
          }
          throw error;
        }
        due.push({ template, date });
      }
    }

    const raised: RaisedOccurrence[] = [];
    for (const { template, date } of due) {
      const lines = db.select().from(recurringInvoiceLines)
        .where(eq(recurringInvoiceLines.recurringInvoiceId, template.id))
        .orderBy(recurringInvoiceLines.lineNumber).all();
      const created = createInvoice(db, {
        companyId: params.companyId, direction: 'sales', invoiceDate: date, customerId: template.customerId,
        reference: template.name,
        lines: lines.map((line) => ({
          description: line.description, netMinor: line.netMinor,
          ...(line.discountBasisPoints !== null ? { discountBasisPoints: line.discountBasisPoints } : {}),
          accountId: line.accountId, vatTreatmentId: line.vatTreatmentId,
        })),
        recurring: { templateId: template.id, date },
        notes: template.notes,
        actor: params.actor,
        requestId: params.requestId,
      });
      const number = db.select({ n: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, created.invoiceId)).get()!.n;
      raised.push({ templateId: template.id, templateName: template.name, date, invoiceId: created.invoiceId, invoiceNumber: number });
    }

    for (const skip of skipped) {
      upsertReviewItem(db, {
        companyId: params.companyId, kind: 'transaction_outside_period', severity: 'warning',
        title: `Recurring invoice "${skip.templateName}" for ${skip.date} was not raised`,
        detail: `${skip.reason} Raise it by hand with the right date, or deactivate the template if it is no longer wanted.`,
        entityType: 'recurring_invoice', entityId: skip.templateId,
        dedupeKey: `recurring_invoice:${skip.templateId}:${skip.date}:skipped`,
      });
    }
    return { raised, skipped };
  });
}

export interface RecurringInvoiceSummary {
  id: string; name: string; customerId: string; customerName: string;
  frequency: RecurringFrequency; startDate: string; endDate: string | null; active: boolean;
  netMinor: number; raisedCount: number; lastRaisedDate: string | null; nextDueDate: string | null;
}

export function listRecurringInvoices(
  db: AppDatabase, params: { companyId: string },
): RecurringInvoiceSummary[] {
  const rows = db.select({ template: recurringInvoices, customerName: customers.name })
    .from(recurringInvoices).innerJoin(customers, eq(recurringInvoices.customerId, customers.id))
    .where(eq(recurringInvoices.companyId, params.companyId))
    .orderBy(recurringInvoices.name).all();
  return rows.map(({ template, customerName }) => {
    const done = raisedDates(db, template.id);
    const net = db.select({ total: sql<number>`coalesce(sum(${recurringInvoiceLines.netMinor}), 0)` })
      .from(recurringInvoiceLines).where(eq(recurringInvoiceLines.recurringInvoiceId, template.id)).get()!.total;
    let next: string | null = null;
    if (template.active) {
      for (let i = 0; i < 2_000; i++) {
        const date = occurrenceDate({ frequency: template.frequency, startDate: asIsoDate(template.startDate) }, i);
        if (template.endDate && date > template.endDate) break;
        if (!done.has(date)) { next = date; break; }
      }
    }
    const dates = [...done].sort();
    return {
      id: template.id, name: template.name, customerId: template.customerId, customerName,
      frequency: template.frequency, startDate: template.startDate, endDate: template.endDate,
      active: template.active, netMinor: Number(net), raisedCount: done.size,
      lastRaisedDate: dates.at(-1) ?? null, nextDueDate: next,
    };
  });
}

/** Stop raising a template. The invoices it raised are untouched. */
export function deactivateRecurringInvoice(
  db: AppDatabase, params: { companyId: string; templateId: string; actor: string; reason?: string | null },
): void {
  const template = db.select().from(recurringInvoices)
    .where(and(eq(recurringInvoices.id, params.templateId), eq(recurringInvoices.companyId, params.companyId))).get();
  if (!template) throw new InvoicingError(`Recurring invoice ${params.templateId} not found.`);
  if (!template.active) return;
  db.transaction(() => {
    db.update(recurringInvoices).set({ active: false, updatedAt: nowIso() }).where(eq(recurringInvoices.id, template.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_invoice', entityId: template.id, action: 'deactivated',
      source: 'user', actor: params.actor, reason: params.reason ?? null,
    }).run();
  });
}

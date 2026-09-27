import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, invoiceLines, companies, accounts, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { postJournalEntry, reverseJournalEntry, atomically, type JournalLineInput } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';

/**
 * Bad debts (issue #404).
 *
 * Writing off a sales invoice takes what is still outstanding out of debtors
 * and charges it to bad debts, dated when the debt is judged irrecoverable.
 *
 * What happens to the VAT in it depends on the basis:
 * - Cash receipts basis: the unpaid share of the invoice's output VAT was never
 *   due — it is still in deferred VAT — so it is cancelled against deferred
 *   VAT, and only the net goes to bad debts. No VAT return is touched.
 * - Invoice basis: the VAT was declared when the invoice was raised. Bad-debt
 *   relief (VATCA s.39) has conditions a person must judge, so nothing is
 *   claimed here: the gross goes to bad debts, and a review item says relief
 *   may be available (tracked in #278).
 *
 * A write-off is reversed, not edited: if the customer pays after all, the
 * reversing journal restores the debtor and the invoice is open again.
 */

type Invoice = typeof invoices.$inferSelect;

function load(db: AppDatabase, companyId: string, invoiceId: string): Invoice {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId))).get();
  if (!invoice) throw new InvoicingError(`Invoice ${invoiceId} not found.`);
  return invoice;
}

/**
 * The share of an invoice's output VAT that is still deferred: its VAT less
 * what receipts have released, computed per line the way the release is
 * (cumulatively on the amount paid), so the two sum to exactly the invoice's
 * VAT.
 */
function deferredVatRemaining(db: AppDatabase, invoice: Invoice): number {
  if (invoice.grossMinor === 0) return 0;
  const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).all();
  return lines.reduce((sum, line) => sum + line.vatMinor
    - (line.vatMinor === 0 ? 0 : multiplyRational(asMinor(line.vatMinor), invoice.paidMinor, invoice.grossMinor)), 0);
}

export function writeOffBadDebt(
  db: AppDatabase,
  params: {
    companyId: string; invoiceId: string; date: IsoDate; reason: string; actor: string;
    /** An expense account to charge instead of the bad debts system account. */
    accountId?: string | null; requestId?: string;
  },
): { journalEntryId: string; writtenOffMinor: number; vatCancelledMinor: number } {
  return atomically(db, () => {
    const actor = params.actor.trim();
    const reason = params.reason.trim();
    if (!actor) throw new InvoicingError('Say who is writing this debt off.');
    if (!reason) throw new InvoicingError('Say why the debt is irrecoverable.');
    const invoice = load(db, params.companyId, params.invoiceId);
    const label = invoice.invoiceNumber ?? invoice.id;
    if (invoice.direction !== 'sales') throw new InvoicingError('Only a debt owed to the business (a sales invoice) is written off as a bad debt.');
    if (invoice.isCreditNote) throw new InvoicingError('A credit note is not a debt.');
    if (invoice.status === 'void') throw new InvoicingError(`Invoice ${label} has been voided.`);
    if (invoice.status === 'written_off') throw new InvoicingError(`Invoice ${label} has already been written off.`);
    if (invoice.outstandingMinor <= 0) throw new InvoicingError(`Invoice ${label} has nothing outstanding.`);
    if (params.date < invoice.invoiceDate) throw new InvoicingError('A debt cannot be written off before the invoice was raised.');

    const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
    let chargeId: string;
    if (params.accountId) {
      const account = db.select().from(accounts)
        .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId))).get();
      if (!account || account.type !== 'expense') throw new InvoicingError('A bad debt is charged to an expense account.');
      chargeId = account.id;
    } else {
      try {
        chargeId = systemAccountId(db, params.companyId, 'bad_debts');
      } catch {
        throw new InvoicingError('This book has no bad debts account (its code 6230 is used for something else). Choose the expense account to charge.');
      }
    }

    const cashBasis = company.vatAccountingBasis === 'cash_receipts' && invoice.vatMinor !== 0;
    const vatCancelled = cashBasis ? deferredVatRemaining(db, invoice) : 0;
    const amount = invoice.outstandingMinor;
    const fx = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? { numerator: invoice.fxRateNumerator, denominator: invoice.fxRateDenominator, source: invoice.fxRateSource ?? 'invoice' }
      : undefined;
    const memo = `Bad debt written off: ${label} — ${reason}`;
    const lines: JournalLineInput[] = [
      { accountId: chargeId, debitMinor: amount - vatCancelled, currency: invoice.currency, fxRate: fx, memo },
      ...(vatCancelled !== 0 ? [{
        accountId: systemAccountId(db, params.companyId, 'vat_on_sales_deferred'), debitMinor: vatCancelled,
        currency: invoice.currency, fxRate: fx, memo: `Deferred VAT never due on ${label} (cash receipts basis)`,
      }] : []),
      {
        accountId: systemAccountId(db, params.companyId, 'debtors'), creditMinor: amount,
        currency: invoice.currency, fxRate: fx, customerId: invoice.customerId, memo,
      },
    ];
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: params.date, narrative: memo.slice(0, 200),
      sourceType: 'sales_invoice', sourceId: invoice.id, entryType: 'adjustment',
      baseCurrency: company.baseCurrency, createdBy: actor, createdVia: 'user', requestId: params.requestId, lines,
    });

    const timestamp = nowIso();
    db.update(invoices).set({
      status: 'written_off', outstandingMinor: 0, writtenOffMinor: amount,
      writtenOffJournalEntryId: journal.id, writtenOffAt: params.date, writeOffReason: reason, updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'invoice', entityId: invoice.id, action: 'updated', field: 'status',
      previousValue: JSON.stringify(invoice.status), newValue: JSON.stringify('written_off'),
      source: 'user', actor, reason, requestId: params.requestId ?? null,
    }).run();

    upsertReviewItem(db, {
      companyId: params.companyId, kind: 'uncertain_vat_treatment', severity: 'warning',
      title: `Bad debt written off: ${label}`,
      detail: cashBasis
        ? `The unpaid share of its output VAT (${(vatCancelled / 100).toFixed(2)}) was never due on the cash receipts basis `
          + 'and has been cancelled from deferred VAT; no VAT return changes. If the customer pays later, reverse the write-off.'
        : `The ${(amount / 100).toFixed(2)} written off includes output VAT already declared. Bad-debt relief (VATCA s.39) may `
          + 'let it be reclaimed once the conditions are met; nothing has been claimed. Decide with your accountant (see #278).',
      entityType: 'invoice', entityId: invoice.id, dedupeKey: `invoice:${invoice.id}:bad_debt`,
    });
    return { journalEntryId: journal.id, writtenOffMinor: amount, vatCancelledMinor: vatCancelled };
  });
}

/** The debt recovered after all: reverse the write-off and reopen the invoice. */
export function reverseBadDebtWriteOff(
  db: AppDatabase,
  params: { companyId: string; invoiceId: string; date: IsoDate; reason: string; actor: string; requestId?: string },
): { reversalJournalEntryId: string; outstandingMinor: number } {
  return atomically(db, () => {
    const invoice = load(db, params.companyId, params.invoiceId);
    if (invoice.status !== 'written_off' || !invoice.writtenOffJournalEntryId) {
      throw new InvoicingError('This invoice has not been written off.');
    }
    if (!params.reason.trim()) throw new InvoicingError('Say why the write-off is being reversed.');
    const reversal = reverseJournalEntry(db, {
      companyId: params.companyId, entryId: invoice.writtenOffJournalEntryId, reversalDate: params.date,
      reason: params.reason, createdBy: params.actor, requestId: params.requestId,
    });
    const outstanding = invoice.grossMinor - invoice.paidMinor;
    const timestamp = nowIso();
    db.update(invoices).set({
      status: invoice.paidMinor === 0 ? 'issued' : 'part_paid', outstandingMinor: outstanding,
      writtenOffMinor: 0, writtenOffJournalEntryId: null, writtenOffAt: null, writeOffReason: null, updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'invoice', entityId: invoice.id, action: 'reversal_posted', field: 'status',
      previousValue: JSON.stringify('written_off'), newValue: JSON.stringify({ reversalJournalEntryId: reversal.id }),
      source: 'user', actor: params.actor, reason: params.reason, requestId: params.requestId ?? null,
    }).run();
    return { reversalJournalEntryId: reversal.id, outstandingMinor: outstanding };
  });
}

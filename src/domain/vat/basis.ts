import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, invoices, journalLines } from '@/db/schema';
import { systemAccountId } from '../config/setup';

/**
 * Which basis decides the tax point of a sale on a given date (issue #608).
 *
 * The moneys-received basis is available only to a person Revenue has
 * authorised (VATCA s.80(1); S.I. 639/2010 reg.25), and only for a taxable
 * period "during which the authorisation has effect". Choosing it on the
 * company profile records how the books are meant to be kept; it does not
 * authorise anything. So a sale is on the cash receipts basis only when the
 * profile says so AND an authorisation is recorded from a date on or before
 * the sale's tax point. Every other sale is on the invoice basis: tax that
 * was due before the authorisation issued is not due again on receipt
 * (s.80(2)(b)).
 *
 * A company that has chosen the cash basis without recording an authorisation
 * is flagged by `cashBasisFindings` at period validation; its sales are on the
 * invoice basis until it is recorded, so the liability is never understated.
 */
export type VatBasis = 'invoice' | 'cash_receipts';

type BasisCompany = Pick<typeof companies.$inferSelect, 'vatAccountingBasis' | 'cashBasisAuthorisedFrom'>;

export function vatBasisOn(company: BasisCompany, date: string): VatBasis {
  if (company.vatAccountingBasis !== 'cash_receipts') return 'invoice';
  const from = company.cashBasisAuthorisedFrom;
  return from && from <= date ? 'cash_receipts' : 'invoice';
}

/**
 * Whether a sales invoice's output VAT was deferred when it was posted, read
 * from its own journal: a deferred invoice credits the deferred VAT account.
 *
 * Release on receipt, and cancellation on a bad debt, follow from how the
 * invoice itself was posted, never from the company's basis today: the basis
 * or its authorisation can change between the invoice and the payment, and
 * releasing VAT that was already declared would report the supply twice.
 */
export function invoiceVatDeferred(
  db: AppDatabase, invoice: Pick<typeof invoices.$inferSelect, 'companyId' | 'direction' | 'vatMinor' | 'journalEntryId'>,
): boolean {
  if (invoice.direction !== 'sales' || invoice.vatMinor === 0 || !invoice.journalEntryId) return false;
  const deferredAccount = systemAccountId(db, invoice.companyId, 'vat_on_sales_deferred');
  const line = db.select({ id: journalLines.id }).from(journalLines)
    .where(and(eq(journalLines.journalEntryId, invoice.journalEntryId), eq(journalLines.accountId, deferredAccount)))
    .get();
  return line !== undefined;
}

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
 * The basis a VAT period's sales were declared on, for the documents that
 * describe a return (filing pack, RTD, VAT pages). Derived from the same
 * authorisation test the posting uses (`vatBasisOn`), so a return is never
 * described as cash receipts while its T1 was posted on the invoice basis.
 *
 * `mixed` is a period an authorisation starts inside: sales dated before the
 * authorisation are on the invoice basis, sales from it on the cash basis.
 */
export interface PeriodBasis {
  basis: VatBasis | 'mixed';
  /** The cash basis is chosen on the profile but is not in force for any of the period. */
  chosenNotInForce: boolean;
  note: string;
}

export function vatBasisForPeriod(company: BasisCompany, start: string, end: string): PeriodBasis {
  const atStart = vatBasisOn(company, start);
  const atEnd = vatBasisOn(company, end);
  const inputs = 'VAT on purchases is claimed by reference to the supplier\u2019s invoice date under either basis.';
  if (atStart === 'cash_receipts') {
    return {
      basis: 'cash_receipts', chosenNotInForce: false,
      note: 'Prepared on the cash receipts basis: VAT on sales arises when payment is received, so a sale invoiced '
        + `in an earlier period appears here if it was paid in this one. ${inputs}`,
    };
  }
  if (atEnd === 'cash_receipts') {
    return {
      basis: 'mixed', chosenNotInForce: false,
      note: `Revenue's authorisation for the cash receipts basis has effect from ${company.cashBasisAuthorisedFrom}. `
        + `Sales dated before then are declared on the invoice basis, when invoiced; sales from then, when paid `
        + `(VATCA s.80(1), (2)(b)). ${inputs}`,
    };
  }
  const chosen = company.vatAccountingBasis === 'cash_receipts';
  return {
    basis: 'invoice', chosenNotInForce: chosen,
    note: 'Prepared on the invoice basis: VAT on sales arises when the invoice is issued, whether or not it has been paid.'
      + (chosen
        ? (company.cashBasisAuthorisedFrom
          ? ` The cash receipts basis is chosen on the company profile, but Revenue's authorisation has effect only from `
            + `${company.cashBasisAuthorisedFrom}, after this period.`
          : ' The cash receipts basis is chosen on the company profile, but no Revenue authorisation is recorded, so it '
            + 'is not in force (VATCA s.80(1)).')
        : ''),
  };
}

/**
 * Whether a sales invoice's output VAT was deferred when it was posted, read
 * from its own journal: a deferred invoice moves its VAT into the deferred VAT
 * account — a net credit for an invoice, a net debit for a credit note (whose
 * VAT is stored negative). A line on that account the other way round, such
 * as a correction, is not a deferral (issue #608 review).
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
  const lines = db.select({ debit: journalLines.debitMinor, credit: journalLines.creditMinor }).from(journalLines)
    .where(and(eq(journalLines.journalEntryId, invoice.journalEntryId), eq(journalLines.accountId, deferredAccount)))
    .all();
  const netCredit = lines.reduce((sum, l) => sum + l.credit - l.debit, 0);
  return invoice.vatMinor > 0 ? netCredit > 0 : netCredit < 0;
}

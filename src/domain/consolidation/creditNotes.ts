import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, invoiceLines } from '@/db/schema';

/**
 * A credit note against the invoice it corrects (VATCA s.67, issue #209
 * part 3). The credit note is posted in its own period with the VAT it shows
 * (s.67(1)(b)(ii): the deduction is reduced by the tax shown on it). This
 * finds the original it names and says where the two disagree; each finding
 * is a review item, never a change to either document.
 */

export interface CreditNoteFinding { code: string; message: string }

type InvoiceRow = typeof invoices.$inferSelect;

/** The posted, non-void invoice from the same party with the number the credit note names. */
export function findOriginalInvoice(db: AppDatabase, params: {
  companyId: string; direction: 'sales' | 'purchase'; partyId: string; originalNumber: string | null;
}): InvoiceRow | undefined {
  const number = params.originalNumber?.trim();
  if (!number) return undefined;
  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return db.select().from(invoices)
    .where(and(
      eq(invoices.companyId, params.companyId), eq(invoices.direction, params.direction), eq(invoices.isCreditNote, false),
      ne(invoices.status, 'void'),
      params.direction === 'purchase' ? eq(invoices.supplierId, params.partyId) : eq(invoices.customerId, params.partyId),
    )).all()
    .find((i) => norm(i.invoiceNumber) === norm(number));
}

const eur = (minor: number) => (minor / 100).toFixed(2);

/**
 * Compare a credit note with its original. Credit note amounts are positive
 * here (as printed); earlier credit notes against the same original count
 * against what can still be credited.
 */
export function creditNoteFindings(db: AppDatabase, params: {
  companyId: string; originalNumber: string | null; original: InvoiceRow | undefined;
  creditNetMinor: number; creditVatMinor: number; creditRatesBasisPoints: number[]; excludeInvoiceId?: string;
}): CreditNoteFinding[] {
  const { original } = params;
  if (!original) {
    return [{
      code: 'credit_note_original_not_found',
      message: params.originalNumber?.trim()
        ? `The credit note names invoice "${params.originalNumber}", which is not among the posted invoices from this party. `
          + 'Post the original first, or check the number; the credit is posted in its own period either way (s.67(1)(b)).'
        : 'The credit note does not say which invoice it corrects. A credit note gives particulars of the reduction '
          + '(s.67(1)(b)(i)); ask the supplier which invoice it relates to.',
    }];
  }
  const findings: CreditNoteFinding[] = [];
  const earlier = db.select().from(invoices)
    .where(and(eq(invoices.companyId, params.companyId), eq(invoices.creditNoteOfId, original.id), ne(invoices.status, 'void')))
    .all().filter((c) => c.id !== params.excludeInvoiceId);
  const creditedNet = earlier.reduce((s, c) => s + Math.abs(c.netMinor), 0);
  const creditedVat = earlier.reduce((s, c) => s + Math.abs(c.vatMinor), 0);
  const leftNet = original.netMinor - creditedNet;
  const leftVat = original.vatMinor - creditedVat;
  if (params.creditNetMinor > leftNet || params.creditVatMinor > leftVat) {
    findings.push({
      code: 'credit_note_exceeds_original',
      message: `The credit note (net ${eur(params.creditNetMinor)}, VAT ${eur(params.creditVatMinor)}) is more than is left on invoice `
        + `${original.invoiceNumber} (net ${eur(leftNet)}, VAT ${eur(leftVat)} after earlier credit notes). Check it against the original.`,
    });
  }
  const originalRates = new Set(db.select({ r: invoiceLines.rateBasisPoints }).from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, original.id)).all().map((l) => l.r));
  const strange = params.creditRatesBasisPoints.filter((r) => !originalRates.has(r));
  if (strange.length) {
    findings.push({
      code: 'credit_note_rate_differs',
      message: `The credit note credits VAT at ${strange.map((r) => `${r / 100}%`).join(', ')}, a rate invoice ${original.invoiceNumber} `
        + 'did not charge. A credit note reduces the VAT at the rate originally charged; if the rate was wrong, the supplier '
        + 'credits the whole invoice and issues a new one (s.67(3)).',
    });
  }
  if (params.creditVatMinor === 0 && params.creditNetMinor > 0 && original.vatMinor !== 0) {
    findings.push({
      code: 'credit_note_without_vat',
      message: `The credit note reduces the price but shows no VAT, though invoice ${original.invoiceNumber} charged VAT. Either the `
        + 'parties agreed the VAT stays unaltered (s.67(5): the deduction is not reduced), or the supplier stated too little '
        + 'VAT on it (s.69(1)(b)). Confirm which with the supplier.',
    });
  }
  return findings;
}

/**
 * The last day an invoice may be issued: 15 days after the end of the month
 * of supply (VATCA s.70(1); S.I. 639/2010 reg.23).
 */
export function invoiceIssueDeadline(supplyDate: string): string {
  const [y, m] = supplyDate.split('-').map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, '0')}-15`;
}

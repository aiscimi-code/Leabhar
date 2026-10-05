import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, invoices } from '@/db/schema';
import { parseVatFxRate } from '@/domain/invoicing/vatFxRate';

export interface VatFxArgs { rate?: string; currency?: string; source?: string; date?: string }

/**
 * The s.37(4) rate at a receipt from CLI flags (issue #661). The currency may be
 * left out when the invoices it settles carry exactly one foreign currency.
 */
export function vatFxFromArgs(
  db: AppDatabase, companyId: string, args: VatFxArgs | undefined, invoiceIds: string[],
): ReturnType<typeof parseVatFxRate> {
  if (!args?.rate) {
    if (args?.currency || args?.source || args?.date) throw new Error('--vat-fx-currency, --vat-fx-source and --vat-fx-date need --vat-fx <rate>.');
    return null;
  }
  let currency = args.currency;
  if (!currency) {
    const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c.toUpperCase();
    const foreign = [...new Set(invoiceIds.map((id) => db.select({ c: invoices.currency }).from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.companyId, companyId))).get()?.c.toUpperCase())
      .filter((c): c is string => !!c && c !== base))];
    if (foreign.length !== 1) throw new Error('Give --vat-fx-currency: the invoices settled do not carry exactly one foreign currency.');
    currency = foreign[0];
  }
  return parseVatFxRate({ rate: args.rate, currency, source: args.source, date: args.date });
}

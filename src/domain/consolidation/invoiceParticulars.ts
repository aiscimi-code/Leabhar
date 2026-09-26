import { parseVatNumber } from '../extraction/vatNumbers';

/**
 * Whether a purchase invoice carries the particulars its VAT can be deducted
 * on (issue #209 part 2). VATCA s.59(2)(a) allows a deduction only for tax
 * charged "by means of invoices ... prepared in the manner prescribed by
 * regulations"; S.I. 639/2010 reg.20(2) prescribes them, under s.66(1).
 *
 * Pure, so the posting screen, the CLI and posting read the same list. A
 * missing particular is never assumed: posting is refused until the person
 * adds it from the page, or chooses to post with the VAT held back.
 */

export interface MissingParticular {
  /** Stable, for review items and tests. */
  code: string;
  /** The reg.20(2) paragraph. */
  paragraph: string;
  what: string;
}

export interface ParticularsInput {
  documentType: string;
  invoiceNumber: string | null;
  documentDate: string | null;
  supplierNameStated: string | null;
  supplierAddress: string | null;
  supplierVatNumber: string | null;
  customerNameStated: string | null;
  customerAddress: string | null;
  lines: Array<{ description: string; netMinor: number | null; vatRateBasisPoints: number | null; vatMinor: number | null }>;
  vatTotals: Array<{ rateBasisPoints: number | null; netMinor: number | null; vatMinor: number | null }>;
  vatMinor: number | null;
  /** The net stated on the document; with a single rate, it is the net at that rate. */
  netMinor: number | null;
  /** A reverse-charge supply states no rate or tax (reg.20(2)(j), (k)). */
  reverseCharge: boolean;
}

const blank = (v: string | null | undefined) => !v || !v.trim();

/** The particulars missing for input VAT to be deducted, or none. Only VAT actually charged needs them. */
export function missingInvoiceParticulars(input: ParticularsInput): MissingParticular[] {
  const vatCharged = (input.vatMinor ?? 0) !== 0 || input.lines.some((l) => (l.vatMinor ?? 0) !== 0)
    || input.vatTotals.some((t) => (t.vatMinor ?? 0) !== 0);
  if (!vatCharged && !input.reverseCharge) return [];

  const out: MissingParticular[] = [];
  const need = (cond: boolean, code: string, paragraph: string, what: string) => { if (cond) out.push({ code, paragraph, what }); };

  if (input.documentType === 'receipt') {
    need(true, 'not_an_invoice', 's.59(2)(a)', 'a VAT invoice: a receipt is not one, and VAT on it can be deducted only from the supplier\'s invoice');
  }
  need(blank(input.documentDate), 'date_of_issue', 'reg.20(2)(a)', 'the date of issue');
  need(blank(input.invoiceNumber), 'sequential_number', 'reg.20(2)(b)', 'the invoice number');
  need(blank(input.supplierNameStated), 'supplier_name', 'reg.20(2)(c)', 'the supplier\'s full name');
  need(blank(input.supplierAddress), 'supplier_address', 'reg.20(2)(c)', 'the supplier\'s address');
  const vat = input.supplierVatNumber ? parseVatNumber(input.supplierVatNumber) : null;
  need(!input.reverseCharge && !(vat?.isIrish && vat.structurallyValid), 'supplier_vat_number', 'reg.20(2)(c)',
    'the supplier\'s Irish VAT registration number');
  need(blank(input.customerNameStated), 'customer_name', 'reg.20(2)(d)', 'your full name');
  need(blank(input.customerAddress), 'customer_address', 'reg.20(2)(d)', 'your address');
  need(input.lines.length === 0 || input.lines.some((l) => blank(l.description)), 'description', 'reg.20(2)(g)',
    'what was supplied (quantity and nature of the goods, or extent and nature of the services)');
  if (!input.reverseCharge) {
    const ratePerLine = input.lines.length > 0 && input.lines.every((l) => l.vatRateBasisPoints !== null);
    const ratePerTotal = input.vatTotals.length > 0 && input.vatTotals.every((t) => t.rateBasisPoints !== null
      && (t.netMinor !== null || (input.vatTotals.length === 1 && input.netMinor !== null)));
    need(!ratePerLine && !ratePerTotal, 'rate_and_net_per_rate', 'reg.20(2)(j)', 'the rate of tax and the amount before VAT at each rate');
    need(input.vatMinor === null && input.vatTotals.every((t) => t.vatMinor === null) && input.lines.every((l) => l.vatMinor === null),
      'tax_payable', 'reg.20(2)(k)', 'the VAT payable');
  }
  return out;
}

export function describeMissing(missing: MissingParticular[]): string {
  return missing.map((m) => `${m.what} (${m.paragraph})`).join('; ');
}

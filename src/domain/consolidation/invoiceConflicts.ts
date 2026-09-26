import { parseVatNumber, normaliseVatNumber, EU_COUNTRY_CODES } from '../extraction/vatNumbers';
import { invoiceIssueDeadline } from './creditNotes';

/**
 * What a confirmed invoice says against itself or against the parties' records
 * (issue #207). Pure: the review screen, the CLI and posting read the same list.
 *
 * Each conflict is flagged, never repaired: the invoice stays as printed, and
 * while one is open no treatment is pre-selected for any line.
 */

export interface InvoiceConflict {
  /** Stable, so a review item for it is raised once. */
  code: string;
  message: string;
}

export interface InvoiceConflictInput {
  direction: 'sales' | 'purchase';
  /** The VAT printed on the document, and on each line; null where none is stated. */
  documentVatMinor: number | null;
  lineVatMinor: Array<number | null>;
  /** VAT numbers as printed on the invoice. */
  supplierVatNumber: string | null;
  customerVatNumber: string | null;
  /** The company's own VAT number. */
  companyVatNumber: string | null;
  /** The other party: its country, and where a person confirmed it is established. */
  counterpartyCountry: string | null;
  counterpartyEstablishment: 'in_state' | 'outside_state' | null;
  /** VIES's answer for the customer's current VAT number, when it was checked. */
  customerVies: 'valid' | 'invalid' | 'unavailable' | null;
  /** VAT wording printed on the invoice. */
  legends: string[];
  /** The invoice's date and the date of supply, when printed (the s.70 time limit for a sale). */
  documentDate?: string | null;
  supplyDate?: string | null;
}

const EU = new Set<string>(EU_COUNTRY_CODES);
const REVERSE_CHARGE = /reverse|autoliquidation|steuerschuldnerschaft|verlegd|inversione|inversi[oó]n|art(icle|\.)?\s*(44|196)\b/i;
const INTRA_COMMUNITY = /intra-?community|innergemeinschaftlich|intracommunautaire|art(icle|\.)?\s*138\b/i;
const EXEMPT = /exempt|befreit|exon[eé]r|vrijgesteld|esente|exento/i;
const MARGIN = /\b(margin scheme|auction scheme)\b/i;

export function invoiceConflicts(input: InvoiceConflictInput): InvoiceConflict[] {
  const out: InvoiceConflict[] = [];
  const lineVat = input.lineVatMinor.filter((v): v is number => v !== null);
  const vatCharged = input.documentVatMinor ?? (lineVat.length ? lineVat.reduce((a, b) => a + b, 0) : null);
  const charged = vatCharged !== null && vatCharged !== 0;
  const noVat = vatCharged === null || vatCharged === 0;
  const rcLegend = input.legends.find((l) => REVERSE_CHARGE.test(l));
  const icLegend = input.legends.find((l) => INTRA_COMMUNITY.test(l));
  const exemptLegend = input.legends.find((l) => EXEMPT.test(l));
  const country = input.counterpartyCountry?.toUpperCase() ?? null;
  const otherMemberState = country !== null && country !== 'IE' && EU.has(country === 'EL' ? 'GR' : country);
  const confirmedAbroad = input.counterpartyEstablishment === 'outside_state';

  if (rcLegend && charged) {
    out.push({
      code: 'reverse_charge_with_vat',
      message: `The invoice says "${rcLegend}" but also charges VAT. A reverse-charge invoice carries no VAT: the `
        + 'customer accounts for it. One of the two is wrong; ask the supplier which.',
    });
  }

  const marginLegend = input.legends.find((l) => MARGIN.test(l));
  if (marginLegend && charged) {
    out.push({
      code: 'margin_scheme_with_vat',
      message: `The invoice says "${marginLegend}" but shows VAT. A margin- or auction-scheme invoice never shows VAT `
        + 'separately (VATCA s.87(9), s.89(5)), and none can be deducted. Either the scheme was not applied or the VAT '
        + 'is shown in error; ask the supplier which.',
    });
  }

  if (input.direction === 'purchase') {
    const supplierNo = input.supplierVatNumber ? parseVatNumber(input.supplierVatNumber) : null;
    if (charged && supplierNo?.isEu && !supplierNo.isIrish) {
      out.push({
        code: 'foreign_vat_charged',
        message: `VAT is charged under the supplier's ${supplierNo.countryCode} VAT number (${supplierNo.normalised}). `
          + 'That is another Member State\'s VAT, not Irish input VAT, and cannot be claimed on the VAT3. A supply of '
          + 'goods to your business from another Member State, or most services, should be invoiced without VAT '
          + 'against your VAT number, and you account for it here. Ask the supplier for a corrected invoice, or '
          + 'reclaim it from that country under the EU VAT refund procedure.',
      });
    } else if (charged && confirmedAbroad && !(supplierNo?.isIrish)) {
      out.push({
        code: 'foreign_vat_charged',
        message: 'VAT is charged by a supplier confirmed as established outside the State, without an Irish VAT '
          + 'number on the invoice. It may be another country\'s tax, which cannot be claimed on the VAT3. Check '
          + 'which country\'s VAT this is before claiming it.',
      });
    }
    if (rcLegend && !input.customerVatNumber && (otherMemberState || (supplierNo?.isEu && !supplierNo.isIrish))) {
      out.push({
        code: 'reverse_charge_without_your_vat_number',
        message: `The invoice says "${rcLegend}" but does not show your VAT number. An invoice for a reverse-charge `
          + 'supply must state the VAT number of the business it is supplied to (in Ireland, SI 639/2010 reg '
          + '20(2)(e); the supplier\'s country has the same rule). Ask for a corrected invoice.',
      });
    }
    if (input.customerVatNumber && input.companyVatNumber
        && normaliseVatNumber(input.customerVatNumber) !== normaliseVatNumber(input.companyVatNumber)) {
      out.push({
        code: 'not_your_vat_number',
        message: `The invoice is addressed to VAT number ${normaliseVatNumber(input.customerVatNumber)}, not yours `
          + `(${normaliseVatNumber(input.companyVatNumber)}). An invoice made out to another business is not `
          + 'evidence for your VAT claim.',
      });
    }
    if (confirmedAbroad && otherMemberState && noVat && !rcLegend && !exemptLegend) {
      out.push({
        code: 'no_vat_no_reverse_charge_wording',
        message: 'A supplier established in another Member State charged no VAT, and the invoice gives no reason '
          + '(no reverse-charge or exemption wording). If the supply is to your business you still account for '
          + 'the VAT here; confirm what was supplied.',
      });
    }
  } else if (otherMemberState && noVat) {
    // A sale to another Member State without VAT: the invoice must show why (SI 639/2010 reg 20(2)(e), (f)).
    if (!input.customerVatNumber) {
      out.push({
        code: 'zero_vat_sale_without_customer_vat_number',
        message: `No VAT is charged to a customer in ${country}, but the invoice shows no customer VAT number. `
          + 'An intra-Community supply of goods, or a reverse-charge service, must state the customer\'s VAT '
          + 'number (SI 639/2010 reg 20(2)(e), (f)); without one, Irish VAT may be due on the sale.',
      });
    } else if (!rcLegend && !icLegend) {
      out.push({
        code: 'zero_vat_sale_without_wording',
        message: 'No VAT is charged to a business in another Member State, but the invoice does not say that a '
          + 'reverse charge applies or that it is an intra-Community supply (SI 639/2010 reg 20(2)(e), (f)).',
      });
    }
    if (input.customerVatNumber && input.customerVies === 'invalid') {
      out.push({
        code: 'zero_vat_sale_invalid_vat_number',
        message: `VIES reported the customer's VAT number ${normaliseVatNumber(input.customerVatNumber)} as not `
          + 'valid. It is not evidence of a business customer, and the sale may bear Irish VAT.',
      });
    }
  }
  // An invoice for a sale is issued within 15 days after the end of the month of supply (s.70(1), S.I. 639/2010 reg.23).
  if (input.direction === 'sales' && input.supplyDate && input.documentDate) {
    const deadline = invoiceIssueDeadline(input.supplyDate);
    if (input.documentDate > deadline) {
      out.push({
        code: 'invoice_issued_late',
        message: `The invoice is dated ${input.documentDate} for a supply on ${input.supplyDate}. It was due by ${deadline}: within `
          + '15 days after the end of the month of supply (VATCA s.70(1), S.I. 639/2010 reg.23). The VAT is still due for the '
          + 'period of the supply; check that it was declared there.',
      });
    }
  }
  return out;
}

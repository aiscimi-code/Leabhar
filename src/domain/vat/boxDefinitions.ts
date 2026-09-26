/**
 * The VAT3 boxes as Revenue defines them (issue #210), each quoting Revenue's
 * "How do you complete a VAT 3 return?" page, kept at
 * docs/statutes/vat3-rtd/completing-vat3-return.md. A test checks every quote
 * is in that file, and that every box a treatment reports into is defined
 * here, so a treatment's box mapping always cites the definition it
 * implements.
 */

export const VAT3_GUIDANCE_PATH = 'docs/statutes/vat3-rtd/completing-vat3-return.md';
export const VAT3_GUIDANCE_URL = 'https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx';

export interface BoxDefinition {
  box: string;
  label: string;
  /** Revenue's words, verbatim (whitespace aside). */
  quote: string;
}

export const VAT3_BOX_DEFINITIONS: Record<string, BoxDefinition> = {
  T1: { box: 'T1', label: 'VAT on sales', quote: 'This figure is the total VAT due on your: supplies of goods and services intra-Community acquisitions of goods import of goods, where you have applied VAT Postponed Accounting received services' },
  T2: { box: 'T2', label: 'VAT on purchases', quote: 'This figure is the total VAT which you are entitled to reclaim in respect of costs incurred by you on: goods and services, insofar as they relate to your taxable supplies and qualifying activities.' },
  T3: { box: 'T3', label: 'VAT payable', quote: 'VAT is payable to Revenue where the T1 figure is greater than the T2 figure.' },
  T4: { box: 'T4', label: 'VAT repayable', quote: 'VAT is repayable to you where the T2 figure is greater than the T1 figure.' },
  E1: { box: 'E1', label: 'Intra-EU supplies of goods', quote: 'This is the total value of goods sent to customers in other EU countries.' },
  E2: { box: 'E2', label: 'Intra-EU acquisitions of goods', quote: 'This is the total value of goods received from suppliers in other EU countries.' },
  ES1: { box: 'ES1', label: 'Intra-EU supply of services', quote: 'This is the total value of services supplied to customers in other EU countries.' },
  ES2: { box: 'ES2', label: 'Intra-EU acquisition of services', quote: 'This is the total value of services received from suppliers in other EU countries.' },
  PA1: { box: 'PA1', label: 'Postponed accounting', quote: 'This is the total of the Customs value of goods imported under postponed accounting, as per Customs Declarations plus Customs Duty.' },
};

/** Collapse whitespace, so a quote matches the page however its lines were broken. */
export const normaliseSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The definitions behind the boxes a treatment reports into. */
export function treatmentBoxCitations(t: {
  salesVatBox?: string | null; purchasesVatBox?: string | null; netSalesBox?: string | null; netPurchasesBox?: string | null;
}): BoxDefinition[] {
  return [t.salesVatBox, t.purchasesVatBox, t.netSalesBox, t.netPurchasesBox]
    .filter((b): b is string => !!b)
    .map((b) => VAT3_BOX_DEFINITIONS[b])
    .filter((d): d is BoxDefinition => !!d);
}

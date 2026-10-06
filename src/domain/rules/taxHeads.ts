/**
 * The tax heads a rule belongs to (ADR-0020 §3, issue #686 step 9).
 *
 * `topic` routes a lookup and names one subject; a rule can belong to more
 * than one tax head. Capital allowances are given against income tax and
 * corporation tax alike, a farm relief under either, and VAT on an import is
 * charged and collected as customs duty is. `taxHeadsFor` states each rule's
 * heads from its topic, with the keys whose heads the topic does not tell.
 * It returns none for a topic it does not know, and `taxHeads.test.ts` fails
 * on any rule a loaded book holds with none, so a new topic needs a decision.
 *
 * This module imports nothing, so every derive step can read it.
 */

export const TAX_HEADS = [
  'vat', 'customs', 'corporation_tax', 'income_tax', 'usc', 'prsi', 'paye', 'rct', 'company_law',
] as const;
export type TaxHead = (typeof TAX_HEADS)[number];

const BY_TOPIC: Record<string, TaxHead[]> = {
  vat: ['vat'], vat_scope: ['vat'], vat_reference: ['vat'], vat_registration: ['vat'], vat_return: ['vat'],
  vat_return_form: ['vat'], rtd: ['vat'], place_of_supply: ['vat'],
  // Given against trading income, whichever tax charges it (TCA 1997 Part 9).
  capital_allowances: ['corporation_tax', 'income_tax'], car: ['corporation_tax', 'income_tax'],
  corporation_tax: ['corporation_tax'], income_tax: ['income_tax'], usc: ['usc'], prsi: ['prsi'],
  paye: ['paye'], err: ['paye'], small_benefit: ['paye'], rct: ['rct'],
  company: ['company_law'], company_filing_reference: ['company_law'],
};

export function taxHeadsFor(ruleKey: string, topic: string): TaxHead[] {
  // Farm reliefs (TCA 1997 Part 23) and RCT sit under the corporation tax topic but are not only that.
  if (ruleKey.startsWith('farm.')) return ['corporation_tax', 'income_tax'];
  if (ruleKey.startsWith('rct.')) return ['rct'];
  // Capital allowances (TCA 1997 Part 9) curated under the corporation tax keys apply to a trade under either tax.
  if (/^ct\.(wear_and_tear|balancing_|allowances_|accelerated_|car_|amount_still_unallowed)/.test(ruleKey)) {
    return ['corporation_tax', 'income_tax'];
  }
  const heads = BY_TOPIC[topic] ?? [];
  // VAT on an importation is charged and collected as if it were customs duty (VATCA 2010 s.53).
  if (heads.includes('vat') && /import/.test(ruleKey)) return ['vat', 'customs'];
  return heads;
}

/**
 * The moneys-received (cash receipts) basis, VATCA s.80 (issue #208).
 *
 * The basis is the company's, recorded on its profile with Revenue's
 * authorisation; nothing on a bank line decides it. It moves the tax point of
 * sales only: VAT on purchases is still claimed by the supplier's invoice date.
 * Whether the company is authorised, and whether its turnover still meets the
 * s.80(1) test it relied on, are checked when a VAT period is validated
 * (`cashBasisFindings`).
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const CASH_BASIS_RULE_KEY = 'vat.moneys_received_basis_sales';

export const CASH_BASIS_CURATED_RULES: CuratedVatScopeRule[] = [{
  citation: '2010 Act 31 s.80', sectionNumber: '80', ruleKey: CASH_BASIS_RULE_KEY,
  ruleType: 'other', topic: 'vat_scope', effectiveFrom: '2010-11-01', treatment: null,
  name: 'Moneys-received basis: VAT on sales is due when the money is received (s.80(1))',
  statementExcerpt: 'by reference to the amount of the moneys which the person receives\nduring that taxable period (or '
    + 'part thereof) in respect of taxable supplies.',
  conditions: [
    { field: 'direction', operator: 'equals', value: 'sale' },
    { field: 'companyVatAccountingBasis', operator: 'equals', value: 'cash_receipts' },
  ],
  exceptions: [
    {
      condition: 'the tax is on an intra-Community acquisition, an import or a reverse-charged service (s.3(b), (d), (e))',
      effect: 's.80 does not apply (s.80(6)): that VAT is due on the ordinary basis',
    },
    {
      condition: 'a credit note should have issued for a reduction or discount and did not',
      effect: 'the VAT on the reduction is due as if on the invoice basis (s.80(5))',
    },
  ],
  crossReferences: ['S.I. 639/2010 reg.25 (authorisation)', 'S.I. 69/2025 reg.8 (the €2,000,000 threshold)'],
  vatEffect: 'Output VAT on the sale falls in the period the money is received, at the rate when the supply was made '
    + '(s.80(2)(a)). Input VAT is not affected.',
  accountingEffect: null,
  reportingEffect: 'T1 in the period of receipt.',
  interpretationNote: 'Applies only from the date of Revenue\'s authorisation, recorded on the company profile. The '
    + 'eligibility test relied on (s.80(1)(a) or (b)) is recorded with it and re-checked against the books when a VAT '
    + 'period is validated.',
}];

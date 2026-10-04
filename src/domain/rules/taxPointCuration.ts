/**
 * When tax falls due: the tax point that decides a transaction's VAT period
 * (issue #611). Both are enforced by `determineTaxPoint`, not by matching
 * words, so they carry no conditions and the `vat_reference` topic: citable, never
 * matched.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const SUPPLY_TAX_POINT_RULE_KEY = 'vat.tax_point_supply_invoice';
export const ACQUISITION_TAX_POINT_RULE_KEY = 'vat.tax_point_intra_community_acquisition';

export const TAX_POINT_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.74', sectionNumber: '74', ruleKey: SUPPLY_TAX_POINT_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Tax on a supply invoiced under Chapter 2 is due when the invoice is issued, or when it should have been (s.74(1)(a))',
    statementExcerpt: 'the time of issue of the invoice or, if the invoice is not\nissued in due time, upon the expiration of '
      + 'the period within\nwhich the invoice should have been issued,',
    conditions: [],
    exceptions: [
      { condition: 'the company is on the moneys-received basis (s.80)', effect: 'the VAT is due when the money is received' },
      { condition: 'no invoice is required under Chapter 2', effect: 'the VAT is due when the goods or services are supplied (s.74(1)(d))' },
    ],
    crossReferences: ['S.I. 639/2010 reg.23(a) (due time: within the 15 days following the end of the month of supply)',
      'VATCA 2010 s.74(2) (not later than a receipt)'],
    vatEffect: 'Output VAT on a sale on the invoice basis falls in the period covering the invoice date. An invoice issued '
      + 'after the 15th of the month following the supply moves the VAT to that 15th, not to the invoice date.',
    accountingEffect: null,
    reportingEffect: 'T1 in the period covering the tax point.',
    interpretationNote: 'Enforced when a sales invoice is posted (determineTaxPoint), not by matching words. A credit or '
      + 'debit note takes its own date: reg.23(e) and (f) set its time limits from the change in consideration, not the '
      + 'supply. Whether an invoice was required is not recorded, so every sales invoice is read under s.74(1)(a).',
  },
  {
    citation: '2010 Act 31 s.75', sectionNumber: '75', ruleKey: ACQUISITION_TAX_POINT_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Tax on an intra-Community acquisition is due on the 15th of the following month, or at an earlier invoice (s.75)',
    statementExcerpt: 'on the 15th day of the month following that\nduring which the intra-Community acquisition occurs,',
    conditions: [],
    exceptions: [],
    crossReferences: ['VATCA 2010 s.80(6) (the moneys-received basis does not apply)', 'VIES Traders Manual §3.4'],
    vatEffect: 'The acquisition VAT, both the T1 charge and the T2 deduction, falls in the period covering the 15th of the '
      + 'month after the acquisition, or the supplier\'s invoice date if that is earlier. The VIES and the VAT3 E2 box use '
      + 'the same date.',
    accountingEffect: null,
    reportingEffect: 'T1, T2 and E2 in the period covering the tax point.',
    interpretationNote: 'Enforced when a purchase invoice line coded EU_GOODS_ACQ is posted (determineTaxPoint). The '
      + 'acquisition is read as occurring on the supply date given, or the invoice date when none is.',
  },
];

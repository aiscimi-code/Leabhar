/**
 * When tax falls due: the tax point that decides a transaction's VAT period
 * (issues #611, #614). Each is enforced by `determineTaxPoint`, not by matching
 * words, so they carry no conditions and the `vat_reference` topic: citable, never
 * matched.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const SUPPLY_TAX_POINT_RULE_KEY = 'vat.tax_point_supply_invoice';
export const CASH_RECEIPTS_TAX_POINT_RULE_KEY = 'vat.tax_point_cash_receipts';
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
      + 'supply. Where a person records that no invoice was required, the sale is dated at its supply date (s.74(1)(d)); with nothing recorded, it is read under s.74(1)(a).',
  },
  {
    citation: '2010 Act 31 s.74', sectionNumber: '74', ruleKey: CASH_RECEIPTS_TAX_POINT_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'On the moneys-received basis, tax on a supply is due not later than when the money is received (s.74(2))',
    statementExcerpt: 'not later than the time when the amount in respect of which it\nis payable has been received in '
      + 'full or in part,',
    conditions: [],
    exceptions: [
      { condition: 'the supply is of the kind in Schedule 2 paragraph 1(1) or (2)', effect: 's.74(2) does not apply to it' },
      {
        condition: 'the accountable person is not authorised under s.80 and the tax is due under s.74(1)(a), (b) or (c)',
        effect: 's.74(2) does not apply (s.74(3)); the tax is due when the invoice is issued',
      },
    ],
    crossReferences: ['VATCA 2010 s.80 (the moneys-received basis)', 'VATCA 2010 s.37(4) (the exchange rate at the time '
      + 'the tax becomes due)', 'S.I. 639/2010 reg.25'],
    vatEffect: 'Output VAT on a sale on the cash receipts basis falls in the period covering the receipt. An amount '
      + 'received before the supply is a supply of that part at the time of receipt.',
    accountingEffect: null,
    reportingEffect: 'T1 in the period covering the receipt. A foreign-currency receipt converts the VAT it releases at '
      + 'the rate at the receipt where one is given; otherwise period validation flags the earlier rate.',
    interpretationNote: 'Enforced when a receipt is recorded against a sales invoice whose VAT was deferred '
      + '(determineTaxPoint, recordPayment), not by matching words. Schedule 2 paragraph 1(1) and (2) supplies are not '
      + 'recorded as such, so the exception is not applied automatically.',
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

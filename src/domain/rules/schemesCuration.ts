/**
 * Special schemes seen from the buyer's side (issue #208 part 4): goods or
 * travel bought under a margin or auction scheme (VATCA ss.87-89), produce
 * bought from a flat-rate farmer (s.86), and vouchers (s.43).
 *
 * - A margin- or auction-scheme invoice never shows VAT separately (s.87(9),
 *   s.89(5)); the buyer has no VAT to deduct. The line is flagged, and
 *   posting the whole amount as a cost with no VAT (OUT_OF_SCOPE) is offered.
 *   An invoice that says margin scheme and shows VAT is flagged as a conflict.
 * - A flat-rate farmer's invoice shows a flat-rate addition (4.5% of the
 *   consideration from 1 January 2026, s.86(1)), which the buyer may deduct.
 *   No treatment models it: flagged.
 * - The price paid for a voucher is disregarded (s.43(2)): outside the scope
 *   until it is redeemed, unless it is bought for resale (s.43(3)).
 */
import type { IrishRuleCondition } from '@/db/schema';
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';
const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });
const is = (field: string, value: string): IrishRuleCondition => ({ field, operator: 'equals', value });

export const MARGIN_SCHEME_RULE_KEY = 'vat.margin_scheme_goods_purchase';
export const TRAVEL_MARGIN_RULE_KEY = 'vat.margin_scheme_travel_purchase';
export const AUCTION_SCHEME_RULE_KEY = 'vat.auction_scheme_purchase';
export const FLAT_RATE_FARMER_RULE_KEY = 'vat.flat_rate_farmer_purchase';
export const VOUCHER_RULE_KEY = 'vat.voucher_consideration_disregarded';

/** The wording a margin- or auction-scheme invoice carries (S.I. 639/2010 reg.20(6), (7)). */
export const MARGIN_LEGEND = /\b(margin scheme|auction scheme|second[- ]hand goods|works of art|collectors'? items|antiques)\b/i;

type Rule = Omit<CuratedVatScopeRule, 'ruleType' | 'topic' | 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'effectiveFrom' | 'treatment' | 'exceptions'>
  & Partial<Pick<CuratedVatScopeRule, 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'exceptions'>>;
const rule = (r: Rule): CuratedVatScopeRule => ({
  ruleType: 'other', topic: 'vat_scope', crossReferences: [], accountingEffect: null, reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT, treatment: null, exceptions: [], ...r,
});

export const SCHEMES_CURATED_RULES: CuratedVatScopeRule[] = [
  rule({
    citation: 'VATCA 2010 s.88', sectionNumber: '88', ruleKey: TRAVEL_MARGIN_RULE_KEY,
    name: 'Travel bought under the travel agents\' margin scheme: no VAT to deduct (s.88)',
    statementExcerpt: 'a travel agent shall not be entitled to\na deduction or a refund of tax borne or paid in respect of bought-in services',
    conditions: [is('direction', 'purchase'), desc('\\bmargin scheme\\W{0,5}travel|\\btravel agents?\\W{0,5}margin\\b')],
    crossReferences: ['S.I. 639/2010 reg.20(7) ("margin scheme — travel agents")'],
    vatEffect: 'The travel agent accounts for VAT on its margin; the traveller\'s invoice shows none and none can be deducted.',
    interpretationNote: 'Read from the invoice\'s "margin scheme — travel agents" endorsement.',
  }),
  rule({
    citation: 'VATCA 2010 s.89', sectionNumber: '89', ruleKey: AUCTION_SCHEME_RULE_KEY,
    name: 'Goods bought at auction under the auction scheme: no VAT to deduct (s.89)',
    statementExcerpt: 'been applied, indicate separately the amount of tax chargeable in respect of the',
    conditions: [is('direction', 'purchase'), desc('\\bauction scheme\\b')],
    vatEffect: 'The auctioneer accounts for VAT on its margin; the invoice shows none and none can be deducted.',
    interpretationNote: 'Read from the invoice\'s auction-scheme wording.',
  }),
  rule({
    citation: 'VATCA 2010 s.87', sectionNumber: '87', ruleKey: MARGIN_SCHEME_RULE_KEY,
    name: 'Second-hand goods, art, antiques or collectors\' items bought under the margin scheme: no VAT to deduct (s.87(9))',
    statementExcerpt: 'applied, indicate separately the amount of tax chargeable in respect of the supply',
    conditions: [is('direction', 'purchase'), desc('\\bmargin scheme\\b')],
    exceptions: [{ condition: 'the dealer opted to charge VAT normally (s.87(4))', effect: 'the invoice shows VAT, deductible in the ordinary way' }],
    vatEffect: 'The dealer accounts for VAT on its margin; the invoice shows none and none can be deducted.',
    interpretationNote: 'Read from the invoice\'s margin-scheme wording (S.I. 639/2010 reg.20(6)).',
  }),
  rule({
    citation: '2010 Act 31 s.86', sectionNumber: '86', ruleKey: FLAT_RATE_FARMER_RULE_KEY,
    name: 'Produce or services bought from a flat-rate farmer: the flat-rate addition (s.86)',
    statementExcerpt: 'an amount (in this Act referred to as a "flat-rate addition") equal to',
    conditions: [is('direction', 'purchase'), desc('\\bflat[- ]rate (addition|farmer)\\b')],
    crossReferences: ['VATCA 2010 s.68 (farmer invoices)'],
    vatEffect: 'The buyer may deduct the flat-rate addition shown on the farmer\'s invoice (4.5% of the consideration from '
      + '1 January 2026; broiler stock-minding excluded from 1 September 2025, S.I. 327/2025).',
    interpretationNote: 'No treatment models the flat-rate addition: flagged.',
  }),
  rule({
    citation: 'VATCA 2010 s.43', sectionNumber: '43', ruleKey: VOUCHER_RULE_KEY,
    name: 'A voucher bought or sold for its redeemable value: the consideration is disregarded (s.43(2))',
    statementExcerpt: 'for a consideration, the consideration shall be disregarded for the purposes of',
    conditions: [desc('\\b(gift (card|voucher|token)s?|vouchers?|one4all|top[- ]?up voucher|prepaid (card|voucher))\\b')],
    exceptions: [{ condition: 'the voucher is bought for resale (s.43(3))', effect: 'the consideration is taxable on each sale' }],
    vatEffect: 'Outside the scope until the voucher is redeemed; VAT arises on the goods or services it pays for.',
    interpretationNote: 'Read from the description; always confirmed by a person.',
  }),
];

export const SCHEMES_GAPS: Record<string, string> = {
  [MARGIN_SCHEME_RULE_KEY]: 'Bought under the margin scheme: the dealer\'s VAT is inside the price and not shown '
    + '(s.87(9)), so there is no VAT to deduct. Post the whole amount as a cost with no VAT (OUT_OF_SCOPE).',
  [TRAVEL_MARGIN_RULE_KEY]: 'Bought under the travel agents\' margin scheme: no VAT is shown and none can be deducted '
    + '(s.88). Post the whole amount as a cost with no VAT (OUT_OF_SCOPE).',
  [AUCTION_SCHEME_RULE_KEY]: 'Bought under the auction scheme: no VAT is shown and none can be deducted (s.89). Post the '
    + 'whole amount as a cost with no VAT (OUT_OF_SCOPE).',
  [FLAT_RATE_FARMER_RULE_KEY]: 'Bought from a flat-rate farmer: the flat-rate addition on the invoice (4.5% of the '
    + 'consideration from 1 January 2026, s.86(1)) is deductible. No treatment models it; record it with your adviser.',
};

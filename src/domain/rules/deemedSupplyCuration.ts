/**
 * Deemed supplies: output VAT with no sale invoice (issue #645). Each is
 * enforced by `recordDeemedSupply` (src/domain/vat/deemedSupply.ts) from the
 * facts a person states, not by matching words, so they carry no conditions
 * and the `vat_reference` topic: citable, never matched. The €20 gift limit
 * and the floor-area formula are S.I. 639/2010 regs 5 and 7 (si639Curation.ts).
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const FREE_OF_CHARGE_SUPPLY_RULE_KEY = 'vat.deemed_supply_goods_free_of_charge';
export const DEEMED_SUPPLY_TAXABLE_AMOUNT_RULE_KEY = 'vat.deemed_supply_taxable_amount_cost';
export const IMMOVABLE_PRIVATE_USE_RULE_KEY = 'vat.self_supply_immovable_goods_private_use';
export const IMMOVABLE_PRIVATE_USE_AMOUNT_RULE_KEY = 'vat.non_business_use_immovable_goods_amount';

const ENFORCED = 'Enforced by recordDeemedSupply from the facts a person states, not by matching words.';

export const DEEMED_SUPPLY_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.21', sectionNumber: '21', ruleKey: FREE_OF_CHARGE_SUPPLY_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Goods given away or taken for a non-business purpose are a supply for consideration (s.21)',
    statementExcerpt: 'shall be deemed, for\nthe purposes of this Act, to have been effected for\nconsideration in the '
      + 'course or furtherance of the business\nconcerned except—',
    conditions: [],
    exceptions: [
      { condition: 'a gift, not one of a series or succession to the same person, costing the donor no more than the '
        + 'sum in regulations (€20 excluding tax, S.I. 639/2010 reg.5) (s.21(a))', effect: 'not a supply: no VAT is due' },
      { condition: 'industrial samples given in reasonable quantity, in a form not ordinarily available for sale to the '
        + 'public (s.21(b))', effect: 'not a supply: no VAT is due' },
      { condition: 'the VAT on the goods was not deductible in whole or in part and they did not come in a s.20(2) '
        + 'transfer (s.19(1)(g))', effect: 'not a supply: no VAT is due' },
    ],
    crossReferences: ['VATCA 2010 s.19(1)(f), (g), (h)', 'VATCA 2010 s.42(1)(a) (taxable amount: cost)',
      'S.I. 639/2010 reg.5 (€20 gift limit)'],
    vatEffect: 'Output VAT on the cost of the goods, at the rate the goods would bear, in the period the goods are '
      + 'given or taken, with no sale invoice.',
    accountingEffect: 'The VAT is charged to the account the person names: drawings, a director\'s loan, or gifts.',
    reportingEffect: 'T1 in the period of the gift or appropriation.',
    interpretationNote: `${ENFORCED} Goods sent to another Member State (s.19(1)(h)) take their own taxable amount `
      + '(s.42(2)) and are not recorded this way.',
  },
  {
    citation: '2010 Act 31 s.42', sectionNumber: '42', ruleKey: DEEMED_SUPPLY_TAXABLE_AMOUNT_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'The taxable amount of goods given away or taken is their cost excluding tax (s.42(1)(a))',
    statementExcerpt: 'shall be the cost\n(excluding tax) of the goods to the person supplying or\nacquiring the goods or '
      + 'the cost (excluding tax) of supplying\nthe services, as the case may be.',
    conditions: [],
    exceptions: [
      { condition: 'the goods are immovable (s.42(1)(c))', effect: 'the cost includes the taxable amount of the last supply of them to the person' },
    ],
    crossReferences: ['VATCA 2010 s.19(1)(e)(ii), (f), (g)', 'VATCA 2010 s.27(1)(a), (b)'],
    vatEffect: 'A deemed supply of goods is taxed on what the goods cost the business, excluding VAT, not on their '
      + 'selling price.',
    accountingEffect: null,
    reportingEffect: 'T1 in the period of the deemed supply.',
    interpretationNote: `${ENFORCED} A deemed supply of immovable goods by appropriation (s.42(1)(c)) is not recorded `
      + 'this way.',
  },
  {
    citation: '2010 Act 31 s.27', sectionNumber: '27', ruleKey: IMMOVABLE_PRIVATE_USE_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Private use of business property acquired before 2011 is a supply of services for 20 years (s.27(2), (3))',
    statementExcerpt: 'does not apply in the case of immovable goods that are acquired or developed by an\naccountable '
      + 'person on or after 1 January 2011.',
    conditions: [],
    exceptions: [
      { condition: 'the property was acquired or developed on or after 1 January 2011 (s.27(3))', effect: 'not a supply under s.27(2)' },
      { condition: 'the use is more than 20 years after the acquisition or development (s.27(2)(i))', effect: 'not a supply' },
      { condition: 'the property was not treated as a business asset when acquired or developed (s.27(2)(ii))', effect: 'not a supply' },
    ],
    crossReferences: ['VATCA 2010 s.44 (taxable amount)', 'S.I. 639/2010 reg.7 (private use proportion)'],
    vatEffect: 'Output VAT for each taxable period the property is used privately or for a non-business purpose, '
      + 'on the amount s.44 sets, at the standard rate.',
    accountingEffect: null,
    reportingEffect: 'T1 in the period of the use.',
    interpretationNote: `${ENFORCED} Supplies of services deemed by regulations under s.27(1), such as free catering `
      + 'for staff (S.I. 639/2010 reg.8), are not recorded this way.',
  },
  {
    citation: '2010 Act 31 s.44', sectionNumber: '44', ruleKey: IMMOVABLE_PRIVATE_USE_AMOUNT_RULE_KEY,
    ruleType: 'other', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Private use of property is taxed each period on one sixth of one twentieth of its cost, by the use (s.44(1))',
    statementExcerpt: 'an amount equal to one sixth of one\ntwentieth of the cost of the immovable goods used to provide\n'
      + 'those services, being—',
    conditions: [],
    exceptions: [],
    crossReferences: ['VATCA 2010 s.27(2)', 'S.I. 639/2010 reg.7 (C x D / (20 x 6), D the private floor area over the total)'],
    vatEffect: 'Each taxable period: the taxable amount on the acquisition or development x private floor area / total '
      + 'floor area / 120, at the standard rate (reg.7(4)).',
    accountingEffect: null,
    reportingEffect: 'T1 in the period of the use.',
    interpretationNote: `${ENFORCED} Where s.20(2)(c) applied to the acquisition, C is the amount that would have been `
      + 'chargeable but for it (s.44(1)(b)); the person states that amount.',
  },
];

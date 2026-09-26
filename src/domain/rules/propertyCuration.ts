/**
 * VAT on property (issue #208 part 2): the letting option to tax (VATCA s.97)
 * and supplies of immovable goods (s.94).
 *
 * Only one of these decides: rent from a landlord whose invoice charges VAT.
 * That invoice is itself the notification that tax is chargeable on the
 * letting (s.97(1)(c)(ii)), so the letting is taxed at the standard rate. A
 * residential letting cannot be opted (s.97(4)); VAT charged on one is flagged.
 *
 * Whether a sale of property is taxable turns on facts no invoice states: when
 * the building was completed and last developed, whether it has been occupied
 * for 24 months since a taxable supply between unconnected persons (s.94(2)),
 * whether a joint option for taxation was signed (s.94(5)), and, for property
 * held or developed before 1 July 2008, the transitional rules of ss.93, 95
 * and 96. Those supplies are flagged with the questions to answer.
 */
import type { IrishRuleCondition } from '@/db/schema';
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';
const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });
const is = (field: string, value: string): IrishRuleCondition => ({ field, operator: 'equals', value });
const vatCharged: IrishRuleCondition = { field: 'vatChargedMinor', operator: 'gt', value: '0' };

/** Rent, as the exempt-letting rule (Sch.1 para 11) reads it. */
const RENT = '\\b(rent|letting)\\b|\\brental of (office|premises|unit|shop|warehouse|property)\\b|\\blease (payment|rent)\\b';
const RESIDENTIAL = '\\b(residential|apartment|house|dwelling|flat|student accommodation)\\b';
const PROPERTY_SALE = '\\b((sale|purchase|disposal|acquisition) of (the )?(property|premises|land|site|building|unit|freehold|'
  + 'leasehold)|conveyance|completion statement|stamp duty|sale price of property|freehold interest|assignment of lease)\\b';

export const LETTING_OPTION_RULE_KEY = 'vat.letting_option_to_tax_exercised';
export const LETTING_OPTION_RESIDENTIAL_RULE_KEY = 'vat.letting_option_to_tax_residential';
export const LETTING_OPTION_LANDLORD_RULE_KEY = 'vat.letting_option_to_tax_landlord';
export const PROPERTY_SUPPLY_RULE_KEY = 'vat.supply_of_immovable_goods';
export const JOINT_OPTION_RULE_KEY = 'vat.joint_option_for_taxation';
export const CAPITAL_GOODS_RULE_KEY = 'vat.capital_goods_scheme';

type Rule = Omit<CuratedVatScopeRule, 'ruleType' | 'topic' | 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'effectiveFrom' | 'treatment' | 'exceptions'>
  & Partial<Pick<CuratedVatScopeRule, 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'exceptions'>>;
const rule = (r: Rule): CuratedVatScopeRule => ({
  ruleType: 'other', topic: 'vat_scope', crossReferences: [], accountingEffect: null, reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT, treatment: null, exceptions: [], ...r,
});
const S97 = { citation: 'VATCA 2010 s.97', sectionNumber: '97' } as const;
const S94 = { citation: 'VATCA 2010 s.94', sectionNumber: '94' } as const;

export const PROPERTY_CURATED_RULES: CuratedVatScopeRule[] = [
  rule({
    ...S97, ruleKey: LETTING_OPTION_RULE_KEY,
    name: 'Rent invoiced with VAT: the landlord has opted to tax the letting (s.97(1)(c)(ii))',
    statementExcerpt: 'landlord of a document to the tenant giving notification that tax is chargeable on\nthe letting.',
    conditions: [is('direction', 'purchase'), desc(RENT), vatCharged],
    exceptions: [
      { condition: 'the letting is residential (s.97(4))', effect: 'the option cannot apply; VAT was charged in error' },
      { condition: 'landlord and tenant are connected (s.97(2)(a)(i))', effect: 'the option cannot apply unless the tenant deducts at least 90% (s.97(2)(b))' },
    ],
    crossReferences: ['VATCA 2010 Sch.1 para 11 (the exemption this displaces)'],
    vatEffect: 'The letting is taxable at the standard rate; the tenant deducts the VAT to the extent it uses the '
      + 'property for taxable supplies.',
    interpretationNote: 'Read from the invoice: VAT charged on rent is the landlord\'s notification that tax is '
      + 'chargeable. Always confirmed by a person.',
  }),
  rule({
    ...S97, ruleKey: LETTING_OPTION_RESIDENTIAL_RULE_KEY,
    name: 'VAT charged on the rent of a residential letting: the option to tax cannot apply (s.97(4))',
    statementExcerpt: 'option to tax may not be exercised in respect of all or part of a house or apartment',
    conditions: [is('direction', 'purchase'), desc(RENT), desc(RESIDENTIAL), vatCharged],
    vatEffect: 'A residential letting is exempt; VAT charged on it is not VAT properly chargeable and cannot be deducted.',
    interpretationNote: 'Residential use is read from the invoice wording.',
  }),
  rule({
    ...S97, ruleKey: LETTING_OPTION_LANDLORD_RULE_KEY,
    name: 'Rent received: exempt unless the company has opted to tax the letting (s.97(1)(a))',
    statementExcerpt: 'section referred to as a “landlord”) opts to make that letting so\nchargeable.',
    conditions: [is('direction', 'sale'), desc(RENT)],
    vatEffect: 'Exempt (Sch.1 para 11) unless the company exercised the option, by a term in the lease or a notice to '
      + 'the tenant (s.97(1)(c)); then VAT at the standard rate.',
    interpretationNote: 'Whether the company opted is not recorded: the line is flagged.',
  }),
  rule({
    ...S94, ruleKey: PROPERTY_SUPPLY_RULE_KEY,
    name: 'Supply of immovable goods: taxable or exempt by its history (s.94(2))',
    statementExcerpt: ', tax is not chargeable on the supply of immovable\ngoods—',
    conditions: [desc(PROPERTY_SALE)],
    exceptions: [
      { condition: 'the building was completed within the last 5 years, or developed in that time', effect: 'taxable (s.94(2)(b))' },
      { condition: 'a joint option for taxation is signed by the 15th of the next month (s.94(5))', effect: 'taxable; the purchaser accounts for the VAT' },
      { condition: 'the property was held or developed before 1 July 2008', effect: 'the transitional rules of ss.93, 95 and 96 apply' },
    ],
    crossReferences: ['VATCA 2010 s.93', 'VATCA 2010 s.95', 'VATCA 2010 s.96', 'VATCA 2010 s.98 (valuation)', 'VATCA 2010 ss.63-64 (capital goods scheme)'],
    vatEffect: 'Exempt when the property is old (s.94(2)); taxable when new or recently developed, or under a joint option.',
    interpretationNote: 'The dates of completion and development, and any option, are not on the invoice: flagged.',
  }),
  rule({
    ...S94, ruleKey: JOINT_OPTION_RULE_KEY,
    name: 'Joint option for taxation: the purchaser accounts for the VAT (s.94(5), (6))',
    statementExcerpt: 'and shall be liable to pay the tax chargeable on that supply as if that person\nsupplied those goods',
    conditions: [is('direction', 'purchase'), desc('\\b(joint option|option (for|to) tax(ation)?)\\b')],
    vatEffect: 'The purchaser accounts for the VAT and, where deductible, reclaims it in the same return.',
    interpretationNote: 'No treatment is configured for this reverse charge; RC_CONSTRUCTION has the same VAT3 effect.',
  }),
  rule({
    citation: 'VATCA 2010 s.64', sectionNumber: '64', ruleKey: CAPITAL_GOODS_RULE_KEY,
    name: 'Property acquired, developed or refurbished: a capital good, adjusted over 20 (or 10) intervals (ss.63-64)',
    statementExcerpt: 'refurbishment, 10 intervals,',
    conditions: [is('direction', 'purchase'), desc(`${PROPERTY_SALE}|\\b(refurbishment|development of (the )?(property|premises|site|building))\\b`)],
    crossReferences: ['VATCA 2010 s.63 (definitions)'],
    vatEffect: 'The VAT deducted is reviewed at the end of the initial interval and each later interval against the '
      + 'use of the property for taxable supplies; a change gives VAT payable or deductible (s.64(2)-(4)).',
    interpretationNote: 'Advisory: register the capital good from its invoices (Capital goods), and record its use '
      + 'at the end of each interval.',
  }),
];

/** Advisory: the capital goods record the purchase calls for. */
export const CAPITAL_GOODS_REASON = 'If this is the acquisition, development or refurbishment of a property, it is a '
  + 'capital good (VATCA ss.63-64): register it from its invoices, and record its use at the end of each interval.';

export const PROPERTY_GAPS: Record<string, string> = {
  [LETTING_OPTION_RESIDENTIAL_RULE_KEY]: 'VAT is charged on the rent of what looks like a residential letting. A '
    + 'landlord cannot opt to tax a residential letting (s.97(4)), so this VAT was not properly chargeable and cannot '
    + 'be claimed. Ask the landlord for a corrected invoice.',
  [PROPERTY_SUPPLY_RULE_KEY]: 'Whether a sale of property is taxable turns on its history: completed or developed '
    + 'in the last 5 years (taxable), occupied 24 months after a taxable sale between unconnected persons (exempt), '
    + 'a joint option for taxation (taxable, the purchaser accounts, s.94(5)), or held before 1 July 2008 (ss.93, 95, '
    + '96). Attach the contract and confirm; a capital goods scheme record may be needed (ss.63-64).',
  [JOINT_OPTION_RULE_KEY]: 'Under a joint option for taxation the purchaser accounts for the VAT (s.94(6)). No '
    + 'treatment is configured for it; RC_CONSTRUCTION has the same VAT3 effect (T1 and T2). Attach the option agreement.',
};

/** Advisory: flags and blocks pre-selection, never decides. */
export const LETTING_LANDLORD_REASON = 'Rent received is exempt unless the company has opted to tax the letting (s.97): '
  + 'a term in the lease that VAT is chargeable, or a notice to the tenant. If it has, charge VAT at the standard rate.';

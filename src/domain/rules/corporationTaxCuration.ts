/**
 * Corporation tax rules (issue #211), curated from Revenue's Notes for
 * Guidance on the TCA 1997, Finance Act 2025 edition
 * (docs/statutes/tca-1997-nfg/). There is no LRC revised TCA, so the Notes
 * are the current consolidated statement of each section; they are Revenue
 * guidance, ranked below the Act, and every rule here says so.
 *
 * Each `statementExcerpt` is verbatim from the section's note (a test checks
 * it). These rules carry no transaction conditions: they are not matched
 * against bank lines. The corporation tax computation cites them, and reads
 * its rates from them, rather than from seeded configuration.
 */
import type { IrishRuleType } from '@/db/schema';

type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedCorporationTaxRule {
  /** The Notes for Guidance part file, e.g. "part04". */
  part: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  name: string;
  statementExcerpt: string;
  numericValue: number | null;
  unit: IrishRuleUnit | null;
  taxEffect: string;
  effectiveFrom: string;
  interpretationNote: string;
}

export const NFG_CITATION_PREFIX = 'Revenue NfG TCA 1997 (FA 2025 ed.)';
/** "part04" → "Revenue NfG TCA 1997 (FA 2025 ed.) Part 4"; "part41a" → "… Part 41A". */
export const nfgCitation = (part: string) => `${NFG_CITATION_PREFIX} Part ${part.replace(/^part0?/, '').toUpperCase()}`;

/**
 * The sections ingested from each part: those issue #211 needs, curated now
 * or later. A section's note is ingested as a provision only when listed.
 */
export const NFG_SECTIONS: Record<string, string[]> = {
  part02: ['21', '21A'],
  part04: ['76', '81'],
  part09: ['284', '285A', '288', '291', '291A', '292'],
  part12: ['396', '396A', '396B'],
  part13: ['430', '440', '441'],
  part36: ['840'],
  part41a: ['959I', '959AR', '959AS'],
};

/** Commencement of the TCA 1997 itself, for sections in force throughout. */
const TCA_COMMENCED = '1997-04-06';

export const CT_RATE_TRADING_RULE_KEY = 'ct.rate_standard';
export const CT_RATE_HIGHER_RULE_KEY = 'ct.rate_higher_passive';

export const CORPORATION_TAX_CURATED_RULES: CuratedCorporationTaxRule[] = [
  {
    part: 'part02', sectionNumber: '21', ruleKey: CT_RATE_TRADING_RULE_KEY, ruleType: 'rate',
    name: 'Corporation tax: standard rate 12.5%',
    statementExcerpt: '12½ per cent for the financial year 2003 and each subsequent year.',
    numericValue: 1250, unit: 'basis_points',
    taxEffect: 'Profits of a company, other than those s.21A charges at the higher rate, are charged at 12.5%.',
    effectiveFrom: '2003-01-01',
    interpretationNote: 'TCA s.21(1) as summarised in the Notes for Guidance. Applies to trading income '
      + '(Schedule D Case I and II).',
  },
  {
    part: 'part02', sectionNumber: '21A', ruleKey: CT_RATE_HIGHER_RULE_KEY, ruleType: 'rate',
    name: 'Corporation tax: higher rate 25% on Case III, IV and V income and excepted trades',
    statementExcerpt: 'Corporation tax is charged at the rate of 25 per cent for the financial year 2000 and',
    numericValue: 2500, unit: 'basis_points',
    taxEffect: 'Income chargeable under Case III (e.g. deposit interest), Case IV (e.g. royalties, miscellaneous '
      + 'income) or Case V (Irish rents), and the income of an excepted trade (dealing in or developing land, '
      + 'minerals, petroleum), is charged at 25%.',
    effectiveFrom: '2000-01-01',
    interpretationNote: 'TCA s.21A(3)(a). Foreign dividends that s.21B brings within the 12.5% rate are an '
      + 'exception; which income is non-trading is a judgement the computation flags.',
  },
  {
    part: 'part04', sectionNumber: '76', ruleKey: 'ct.income_tax_principles', ruleType: 'definition',
    name: 'Corporation tax: income computed on income tax principles',
    statementExcerpt: 'Income tax principles apply in determining for corporation tax purposes what is or is',
    numericValue: null, unit: null,
    taxEffect: 'Each source of income is computed under its Schedule and Case, and the results aggregated.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.76(1) and (3).',
  },
  {
    part: 'part04', sectionNumber: '81', ruleKey: 'ct.deduction_only_if_authorised', ruleType: 'deductibility',
    name: 'Corporation tax: no deduction unless the Tax Acts allow it (depreciation added back)',
    statementExcerpt: 'Tax chargeable under Cases I and II of Schedule D is charged without deduction,',
    numericValue: null, unit: null,
    taxEffect: 'Depreciation charged in the accounts is not a deduction the Acts allow; capital allowances take '
      + 'its place.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.81(1).',
  },
  {
    part: 'part04', sectionNumber: '81', ruleKey: 'ct.not_wholly_and_exclusively', ruleType: 'deductibility',
    name: 'Corporation tax: expense not wholly and exclusively for the trade is not deductible',
    statementExcerpt: 'any sum not wholly and exclusively laid out for the purposes of a trade or',
    numericValue: null, unit: null,
    taxEffect: 'Added back in computing trading income.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.81(2)(a).',
  },
  {
    part: 'part04', sectionNumber: '81', ruleKey: 'ct.private_or_domestic', ruleType: 'deductibility',
    name: 'Corporation tax: private or domestic expense is not deductible',
    statementExcerpt: 'any sum expended for a private or domestic purpose,',
    numericValue: null, unit: null,
    taxEffect: 'Added back in computing trading income.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.81(2)(b).',
  },
  {
    part: 'part04', sectionNumber: '81', ruleKey: 'ct.capital_expenditure_not_deductible', ruleType: 'deductibility',
    name: 'Corporation tax: capital expenditure is not deductible',
    statementExcerpt: 'any capital withdrawn from, or any sum used or intended to be used as capital',
    numericValue: null, unit: null,
    taxEffect: 'Capital expenditure (and a loss on disposing of a capital asset) is added back; relief, if any, '
      + 'comes through capital allowances.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.81(2)(f), with (2)(g) for improvements to premises.',
  },
  {
    part: 'part04', sectionNumber: '81', ruleKey: 'ct.taxes_on_income_not_deductible', ruleType: 'deductibility',
    name: 'Corporation tax: taxes on income are not deductible',
    statementExcerpt: 'any taxes on income.',
    numericValue: null, unit: null,
    taxEffect: 'A corporation tax charge in the accounts is added back.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.81(2)(p).',
  },
  {
    part: 'part36', sectionNumber: '840', ruleKey: 'ct.business_entertainment_not_deductible', ruleType: 'deductibility',
    name: 'Corporation tax: business entertainment and gifts are not deductible',
    statementExcerpt: 'business entertainment expenditure incurred is not deductible in determining the profits',
    numericValue: null, unit: null,
    taxEffect: 'Hospitality (accommodation, food, drink) given to anyone but genuine staff, and gifts, are added '
      + 'back; no capital allowances on assets used to entertain.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.840(2), (3) and (5).',
  },
  {
    part: 'part36', sectionNumber: '840', ruleKey: 'ct.staff_entertainment_deductible', ruleType: 'deductibility',
    name: 'Corporation tax: entertainment provided for genuine staff is deductible',
    statementExcerpt: 'for genuine members of staff (for example, Christmas party). This exclusion for staff',
    numericValue: null, unit: null,
    taxEffect: 'Staff entertainment stays deductible unless it is incidental to entertaining others.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.840(1), definition of "business entertainment".',
  },

  // ---- Capital allowances (Part 9) ----
  {
    part: 'part09', sectionNumber: '284', ruleKey: 'ct.wear_and_tear_rate', ruleType: 'rate',
    name: 'Wear and tear: 12.5% a year straight line over 8 years',
    statementExcerpt: 'Where expenditure is incurred on or after 4 December 2002, wear and tear allowances are',
    numericValue: 1250, unit: 'basis_points',
    taxEffect: 'Machinery or plant (including road vehicles, other than taxis and short-term hire cars) bought on or '
      + 'after 4 December 2002: 12.5% of actual cost each year for 8 years.',
    effectiveFrom: '2002-12-04',
    interpretationNote: 'TCA s.284(2)(ad), as the Notes for Guidance summarise it.',
  },
  {
    part: 'part09', sectionNumber: '284', ruleKey: 'ct.wear_and_tear_in_use_at_period_end', ruleType: 'other',
    name: 'Wear and tear: due for a period at whose end the asset belongs to the company and is in use',
    statementExcerpt: 'It should be noted that the allowance is available even if the machinery or plant is acquired',
    numericValue: null, unit: null,
    taxEffect: 'A full year\'s allowance for the period an asset is bought in, however late; none for the period it is '
      + 'disposed of in.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.284(1).',
  },
  {
    part: 'part09', sectionNumber: '284', ruleKey: 'ct.wear_and_tear_short_period', ruleType: 'other',
    name: 'Wear and tear: reduced proportionately for a period shorter than a year',
    statementExcerpt: 'subsection (2)(b) which restricts the allowance where the chargeable period or its basis period',
    numericValue: null, unit: null,
    taxEffect: 'For an accounting period of less than 12 months, the allowance is scaled by the period\'s length.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.284(2)(b).',
  },
  {
    part: 'part09', sectionNumber: '284', ruleKey: 'ct.allowances_not_exceed_cost', ruleType: 'threshold',
    name: 'Wear and tear: total allowances never exceed the actual cost',
    statementExcerpt: 'The total wear and tear allowances and initial allowances (section 283) made to a person in',
    numericValue: null, unit: null,
    taxEffect: 'Allowances stop once they add up to the asset\'s cost.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.284(4).',
  },
  {
    part: 'part09', sectionNumber: '285A', ruleKey: 'ct.accelerated_energy_efficient', ruleType: 'relief',
    name: 'Accelerated allowances: 100% in the first year for energy-efficient equipment on the SEAI list',
    statementExcerpt: '100% of the capital expenditure incurred can be claimed in the year in which the equipment is first',
    numericValue: 10000, unit: 'basis_points',
    taxEffect: 'New equipment in a Schedule 4A class, named on the SEAI list, bought for the trade by 31 December 2030.',
    effectiveFrom: '2008-10-09',
    interpretationNote: 'TCA s.285A. Whether an item is on the SEAI list is for the person claiming to confirm.',
  },
  {
    part: 'part09', sectionNumber: '288', ruleKey: 'ct.balancing_allowance', ruleType: 'relief',
    name: 'Balancing allowance: unallowed expenditure exceeds the proceeds',
    statementExcerpt: 'balancing allowance is made. The amount of the allowance is an amount equal to the amount',
    numericValue: null, unit: null,
    taxEffect: 'On a sale or other balancing event, the unallowed cost less the proceeds is allowed.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.288(2).',
  },
  {
    part: 'part09', sectionNumber: '288', ruleKey: 'ct.balancing_charge', ruleType: 'other',
    name: 'Balancing charge: proceeds exceed the unallowed expenditure',
    statementExcerpt: 'machinery or plant exceed the unallowed expenditure, if any, a balancing charge is made.',
    numericValue: null, unit: null,
    taxEffect: 'The excess of the proceeds over the unallowed cost is charged.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.288(3).',
  },
  {
    part: 'part09', sectionNumber: '288', ruleKey: 'ct.balancing_charge_small_proceeds', ruleType: 'threshold',
    name: 'Balancing charge: none where the proceeds are under €2,000 (not to a connected person)',
    statementExcerpt: 'No balancing charge where “sale proceeds” less than €2,000',
    numericValue: 200_000, unit: 'eur_minor',
    taxEffect: 'Proceeds under €2,000 give no balancing charge, unless the buyer is connected (s.10).',
    effectiveFrom: '2002-01-01',
    interpretationNote: 'TCA s.288(3B).',
  },
  {
    part: 'part09', sectionNumber: '288', ruleKey: 'ct.balancing_charge_limit', ruleType: 'threshold',
    name: 'Balancing charge: limited to the allowances made',
    statementExcerpt: 'A balancing charge to be made on a person cannot exceed the aggregate of the amounts of',
    numericValue: null, unit: null,
    taxEffect: 'The charge claws back at most what was allowed.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.288(4).',
  },
  {
    part: 'part09', sectionNumber: '292', ruleKey: 'ct.amount_still_unallowed', ruleType: 'definition',
    name: 'Amount still unallowed: cost less the allowances made',
    statementExcerpt: 'One of the factors in determining the amount of a balancing allowance or a balancing charge',
    numericValue: null, unit: null,
    taxEffect: 'The tax written-down value a balancing adjustment is measured from.',
    effectiveFrom: TCA_COMMENCED,
    interpretationNote: 'TCA s.292.',
  },
  {
    part: 'part09', sectionNumber: '291', ruleKey: 'ct.computer_software_plant', ruleType: 'definition',
    name: 'Computer software for use in the business is plant (8 years)',
    statementExcerpt: 'off over 8 years, while the software acquired for commercial exploitation will qualify for',
    numericValue: null, unit: null,
    taxEffect: 'Software bought for use in the trade gets wear and tear like other plant; software acquired to exploit '
      + 'commercially falls under s.291A.',
    effectiveFrom: '2010-05-07',
    interpretationNote: 'TCA s.291.',
  },
  {
    part: 'part09', sectionNumber: '291A', ruleKey: 'ct.intangible_assets_scheme', ruleType: 'relief',
    name: 'Intangible assets: a separate scheme of allowances (s.291A)',
    statementExcerpt: 'The Finance Act 2009 introduced a new scheme of tax relief for expenditure incurred by a company on',
    numericValue: null, unit: null,
    taxEffect: 'Specified intangible assets are relieved under s.291A, not by wear and tear.',
    effectiveFrom: '2009-05-07',
    interpretationNote: 'TCA s.291A. Not computed here: the claim follows the accounts or a 15-year write-off by election.',
  },
];

/** The rate a rule states, in basis points; the computation reads its rates here. */
export function corporationTaxRateBasisPoints(ruleKey: typeof CT_RATE_TRADING_RULE_KEY | typeof CT_RATE_HIGHER_RULE_KEY): number {
  return CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey)!.numericValue!;
}

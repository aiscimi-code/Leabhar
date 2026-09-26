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
  part09: ['284', '285A', '288', '291A', '292'],
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
];

/** The rate a rule states, in basis points; the computation reads its rates here. */
export function corporationTaxRateBasisPoints(ruleKey: typeof CT_RATE_TRADING_RULE_KEY | typeof CT_RATE_HIGHER_RULE_KEY): number {
  return CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey)!.numericValue!;
}

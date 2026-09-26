/**
 * Income tax, USC and PRSI Class S rules for sole traders and partners
 * (issue #212; PAYE is out of scope). Each figure is quoted verbatim from the
 * Act that sets it, and dated from the year that Act says it applies to: a
 * later Act's figure is a new version of the same rule, superseding the
 * earlier one, never an edit of it.
 *
 * Sources: Finance Act 2024 ss.2-3 (2025 bands and credits), Finance Act
 * 2025 s.2 (2026 USC bands), the LRC revised Social Welfare Consolidation Act
 * 2005 s.21 (PRSI Class S), and Revenue's Notes for Guidance on TCA Part 18D
 * (the USC exemption threshold and the surcharge on non-PAYE income).
 */
import type { IrishRuleType } from '@/db/schema';

type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedIncomeTaxRule {
  /** The knowledge source's citation, e.g. "2024 Act 43". */
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  name: string;
  statementExcerpt: string;
  numericValue: number | null;
  unit: IrishRuleUnit | null;
  /** The rate the band is charged at, where the rule is a band. */
  rateBasisPoints?: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  interpretationNote: string;
}

const FA2024 = '2024 Act 43';
const FA2025 = '2025 Act 18';
export const SWCA_S21_CITATION = 'SWCA 2005 s.21';
const NFG_18D = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 18D';
const NFG_1 = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 1';
const NFG_2 = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 2';
const NFG_4 = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 4';
const NFG_15 = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 15';
const NFG_41A = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 41A';
const NFG_43 = 'Revenue NfG TCA 1997 (FA 2025 ed.) Part 43';

export const INCOME_TAX_CURATED_RULES: CuratedIncomeTaxRule[] = [
  // ---- Income tax: rates and bands (TCA s.15, as substituted by FA 2024 s.3) ----
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.band_single', ruleType: 'threshold',
    name: 'Income tax: standard rate band, single person (Table Part 1)',
    statementExcerpt: 'PART 1\n\nPart of taxable income Rate of tax Description of rate\n(1) (2) (3)\nThe first €44,000 20 per cent the standard rate',
    numericValue: 4_400_000, unit: 'eur_minor', rateBasisPoints: 2000,
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.15 Table Part 1: single, widowed without children, or assessed as single. For 2025 and later years; Finance Act 2025 did not change it.',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.band_single_parent', ruleType: 'threshold',
    name: 'Income tax: standard rate band, single person child carer (Table Part 2)',
    statementExcerpt: 'PART 2\n\nPart of taxable income Rate of tax Description of rate\n(1) (2) (3)\nThe first €48,000 20 per cent the standard rate',
    numericValue: 4_800_000, unit: 'eur_minor', rateBasisPoints: 2000,
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.15 Table Part 2: those who qualify for the single person child carer credit.',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.band_married', ruleType: 'threshold',
    name: 'Income tax: standard rate band, married couple or civil partners, one income (Table Part 3)',
    statementExcerpt: 'PART 3\n\nPart of taxable income Rate of tax Description of rate\n(1) (2) (3)\nThe first €53,000 20 per cent the standard rate',
    numericValue: 5_300_000, unit: 'eur_minor', rateBasisPoints: 2000,
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.15 Table Part 3, jointly assessed. A second income can raise it by up to €35,000 (s.15(3)).',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.rate_higher', ruleType: 'rate',
    name: 'Income tax: higher rate 40% on the remainder',
    statementExcerpt: 'The remainder 40 per cent the higher rate',
    numericValue: 4000, unit: 'basis_points',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.15 Table, column (2).',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.personal_credit_single', ruleType: 'relief',
    name: 'Income tax: single person tax credit €2,000',
    statementExcerpt: '(iii) in paragraph (c), by the substitution of “€2,000” for “€1,875”,',
    numericValue: 200_000, unit: 'eur_minor',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.461(c), the personal tax credit in any case other than a married couple or a widowed person.',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.personal_credit_married', ruleType: 'relief',
    name: 'Income tax: married or civil partners tax credit €4,000',
    statementExcerpt: '(i) in paragraph (a), by the substitution of “€4,000” for “€3,750”,',
    numericValue: 400_000, unit: 'eur_minor',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.461(a), a married couple or civil partners assessed jointly.',
  },
  {
    citation: FA2024, sectionNumber: '3', ruleKey: 'income_tax.earned_income_credit', ruleType: 'relief',
    name: 'Income tax: earned income tax credit €2,000 (self-employed)',
    statementExcerpt: '(i) in subsection (2), by the substitution of “€2,000” for “€1,875” in each place',
    numericValue: 200_000, unit: 'eur_minor',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.472AB(2): the lower of €2,000 and 20% of earned income (s.472AB), reduced by any employee (PAYE) credit claimed.',
  },

  // ---- USC (TCA s.531AN Table Part 1) ----
  {
    citation: FA2024, sectionNumber: '2', ruleKey: 'usc.band_05pct', ruleType: 'threshold',
    name: 'USC: the first €12,012 at 0.5%',
    statementExcerpt: 'The first €12,012 0.5 per cent', numericValue: 1_201_200, unit: 'eur_minor', rateBasisPoints: 50,
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.531AN Table Part 1; unchanged by Finance Act 2025.',
  },
  {
    citation: FA2024, sectionNumber: '2', ruleKey: 'usc.band_2pct', ruleType: 'threshold',
    name: 'USC: the next €15,370 at 2% (2025)',
    statementExcerpt: 'The next €15,370 2 per cent', numericValue: 1_537_000, unit: 'eur_minor', rateBasisPoints: 200,
    effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01',
    interpretationNote: 'FA 2024 s.2(2): for 2025 and later years, until FA 2025 s.2 replaced it for 2026.',
  },
  {
    citation: FA2025, sectionNumber: '2', ruleKey: 'usc.band_2pct', ruleType: 'threshold',
    name: 'USC: the next €16,688 at 2% (2026)',
    statementExcerpt: 'The next €16,688 2 per cent', numericValue: 1_668_800, unit: 'eur_minor', rateBasisPoints: 200,
    effectiveFrom: '2026-01-01', effectiveTo: null,
    interpretationNote: 'FA 2025 s.2(2): for 2026 and later years.',
  },
  {
    citation: FA2024, sectionNumber: '2', ruleKey: 'usc.band_3pct', ruleType: 'threshold',
    name: 'USC: the next €42,662 at 3% (2025)',
    statementExcerpt: 'The next €42,662 3 per cent', numericValue: 4_266_200, unit: 'eur_minor', rateBasisPoints: 300,
    effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01',
    interpretationNote: 'FA 2024 s.2(2).',
  },
  {
    citation: FA2025, sectionNumber: '2', ruleKey: 'usc.band_3pct', ruleType: 'threshold',
    name: 'USC: the next €41,344 at 3% (2026)',
    statementExcerpt: 'The next €41,344 3 per cent', numericValue: 4_134_400, unit: 'eur_minor', rateBasisPoints: 300,
    effectiveFrom: '2026-01-01', effectiveTo: null,
    interpretationNote: 'FA 2025 s.2(2).',
  },
  {
    citation: FA2024, sectionNumber: '2', ruleKey: 'usc.rate_top', ruleType: 'rate',
    name: 'USC: the remainder at 8%',
    statementExcerpt: 'The remainder 8 per cent', numericValue: 800, unit: 'basis_points',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.531AN Table Part 1; unchanged by Finance Act 2025.',
  },
  {
    citation: NFG_18D, sectionNumber: '531AM', ruleKey: 'usc.exemption_threshold', ruleType: 'threshold',
    name: 'USC: not chargeable where income does not exceed €13,000',
    statementExcerpt: 'income must exceed a threshold of €13,000.', numericValue: 1_300_000, unit: 'eur_minor',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.531AM, as Revenue\'s Notes for Guidance state it. Above it, all income is chargeable.',
  },
  {
    citation: NFG_18D, sectionNumber: '531AN', ruleKey: 'usc.surcharge_non_paye', ruleType: 'rate',
    name: 'USC: 3% surcharge on non-PAYE income over €100,000',
    statementExcerpt: 'A 3% surcharge applies where an individual has relevant income (i.e. essentially non-',
    numericValue: 300, unit: 'basis_points',
    effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.531AN(2): relevant income over €100,000 is charged at 11% (8% + 3%) on the excess.',
  },

  // ---- PRSI Class S (SWCA 2005 s.21) ----
  {
    citation: SWCA_S21_CITATION, sectionNumber: '21', ruleKey: 'prsi.class_s_rate', ruleType: 'rate',
    name: 'PRSI Class S: 4.2% of reckonable income, at least €650',
    statementExcerpt: 'greater of an amount equal to\n4.2\nper cent\nof the reckonable income or\nthe amount of\n\n€\n650',
    numericValue: 420, unit: 'basis_points',
    effectiveFrom: '2026-09-25', effectiveTo: null,
    interpretationNote: 'SWCA 2005 s.21(1)(a) as revised on the date it was retrieved (2026-09-25), which is all the '
      + 'window rests on: the revised text does not say when 4.2% took effect, and no earlier rate is recorded. '
      + 'The computation flags any year the rate may have differed in.',
  },
  // ---- Basis of assessment, credits, partnerships, payment (Revenue NfG, FA 2025 edition) ----
  {
    citation: NFG_4, sectionNumber: '65', ruleKey: 'income_tax.basis_accounting_period', ruleType: 'procedure',
    name: 'Case I: the 12-month account ending in the year of assessment is its basis',
    statementExcerpt: 'Where a person makes up accounts for a trade or profession and there is only one',
    numericValue: null, unit: null, effectiveFrom: '2002-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.65(2): one 12-month account ending in the year; otherwise the 12 months to the last account date in it.',
  },
  {
    citation: NFG_4, sectionNumber: '66', ruleKey: 'income_tax.basis_first_year', ruleType: 'procedure',
    name: 'Commencement: the first year is taxed on profits from commencement to 31 December',
    statementExcerpt: 'In a start-up situation the Case I or II assessment for the first year of assessment is',
    numericValue: null, unit: null, effectiveFrom: '2002-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.66(1).',
  },
  {
    citation: NFG_4, sectionNumber: '66', ruleKey: 'income_tax.basis_second_year', ruleType: 'procedure',
    name: 'Commencement: the second year depends on the accounts ending in it',
    statementExcerpt: 'If there is only one set of accounts for a period ending in the second year of',
    numericValue: null, unit: null, effectiveFrom: '2002-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.66(2): one 12-month account, or 12 months to the end of a longer one; otherwise the actual year.',
  },
  {
    citation: NFG_4, sectionNumber: '66', ruleKey: 'income_tax.third_year_excess_relief', ruleType: 'relief',
    name: 'Commencement: the second year\'s excess over its actual profits reduces the third year, on election',
    statementExcerpt: 'A taxpayer may elect to have the assessment for the third year of assessment reduced by any excess',
    numericValue: null, unit: null, effectiveFrom: '2002-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.66(3).',
  },
  {
    citation: NFG_4, sectionNumber: '67', ruleKey: 'income_tax.basis_cessation', ruleType: 'procedure',
    name: 'Cessation: the final year is taxed on profits from 1 January to cessation; the penultimate year may be revised up',
    statementExcerpt: 'profession is permanently discontinued are those of the period from 1 January in the',
    numericValue: null, unit: null, effectiveFrom: '2002-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.67(1)(a).',
  },
  {
    citation: NFG_15, sectionNumber: '472AB', ruleKey: 'income_tax.earned_income_credit_percentage', ruleType: 'rate',
    name: 'Earned income credit: the lower of €2,000 and 20% of qualifying earned income',
    statementExcerpt: 'The amount of the tax credit is €2,000 or 20 per cent',
    numericValue: 2000, unit: 'basis_points', effectiveFrom: '2025-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.472AB(2)(a): 20% is "the appropriate percentage", the standard rate.',
  },
  {
    citation: NFG_43, sectionNumber: '1008', ruleKey: 'income_tax.partnership_profit_apportioned', ruleType: 'procedure',
    name: 'Partnership: tax-adjusted profits apportioned by the partnership agreement',
    statementExcerpt: 'apportioned in accordance with the terms of the partnership agreement relating to the',
    numericValue: null, unit: null, effectiveFrom: '1997-04-06', effectiveTo: null,
    interpretationNote: 'TCA s.1008(2)(a)(i).',
  },
  {
    citation: NFG_43, sectionNumber: '1008', ruleKey: 'income_tax.partner_several_trade', ruleType: 'procedure',
    name: 'Partnership: each partner is taxed as if carrying on a separate trade',
    statementExcerpt: 'charged, and losses sustained by the partner in the trade are to be relieved, as if they were',
    numericValue: null, unit: null, effectiveFrom: '1997-04-06', effectiveTo: null,
    interpretationNote: 'TCA s.1008(1): commencement and cessation rules apply to each partner\'s share.',
  },
  {
    citation: NFG_43, sectionNumber: '1007', ruleKey: 'income_tax.precedent_partner', ruleType: 'definition',
    name: 'Partnership: the precedent partner',
    statementExcerpt: 'The definition of “precedent partner” is framed to secure that, in relation to a case in',
    numericValue: null, unit: null, effectiveFrom: '1997-04-06', effectiveTo: null,
    interpretationNote: 'TCA s.1007. The precedent partner makes the partnership return.',
  },
  {
    citation: NFG_41A, sectionNumber: '959AO', ruleKey: 'income_tax.preliminary_tax_date', ruleType: 'procedure',
    name: 'Income tax: preliminary tax due 31 October in the tax year',
    statementExcerpt: 'This section sets out the due dates for the payment of income tax. Preliminary tax is due by 31',
    numericValue: null, unit: null, effectiveFrom: '2012-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.959AO.',
  },
  {
    citation: NFG_41A, sectionNumber: '959AO', ruleKey: 'income_tax.preliminary_tax_current_year', ruleType: 'threshold',
    name: 'Income tax: enough preliminary tax is 90% of this year\'s liability',
    statementExcerpt: '90% of current year liability', numericValue: 9000, unit: 'basis_points',
    effectiveFrom: '2012-01-01', effectiveTo: null, interpretationNote: 'TCA s.959AO: or the least of the three tests.',
  },
  {
    citation: NFG_41A, sectionNumber: '959AO', ruleKey: 'income_tax.preliminary_tax_prior_year', ruleType: 'threshold',
    name: 'Income tax: or 100% of the prior year\'s liability',
    statementExcerpt: '100% of prior year liability', numericValue: 10000, unit: 'basis_points',
    effectiveFrom: '2012-01-01', effectiveTo: null, interpretationNote: 'TCA s.959AO.',
  },
  {
    citation: NFG_41A, sectionNumber: '959AO', ruleKey: 'income_tax.preliminary_tax_pre_preceding_year', ruleType: 'threshold',
    name: 'Income tax: or 105% of the pre-preceding year\'s liability, by direct debit',
    statementExcerpt: '105% of the pre-preceding year liability when paying by Direct Debit under', numericValue: 10500,
    unit: 'basis_points', effectiveFrom: '2012-01-01', effectiveTo: null, interpretationNote: 'TCA s.959AO, s.959AP.',
  },
  {
    citation: NFG_41A, sectionNumber: '959AO', ruleKey: 'income_tax.return_date', ruleType: 'procedure',
    name: 'Income tax: return and balance due 31 October in the following year',
    statementExcerpt: 'fined in section 959A as the 31 October in the tax year following the year).',
    numericValue: null, unit: null, effectiveFrom: '2012-01-01', effectiveTo: null,
    interpretationNote: 'TCA s.959A and s.959AO. ROS filing can extend it by Revenue announcement each year, which is not recorded here.',
  },
  {
    citation: NFG_2, sectionNumber: '18', ruleKey: 'income_tax.schedule_d_trade', ruleType: 'definition',
    name: 'Schedule D: the profits of a trade or profession of a person resident in the State',
    statementExcerpt: 'to any person residing in the State from any trade, profession or employment,',
    numericValue: null, unit: null, effectiveFrom: '1997-04-06', effectiveTo: null,
    interpretationNote: 'TCA s.18(1): trading profits are charged under Case I, a profession\'s under Case II.',
  },
  {
    citation: NFG_1, sectionNumber: '3', ruleKey: 'income_tax.earned_income_trade', ruleType: 'definition',
    name: 'Earned income includes income from a trade or profession',
    statementExcerpt: 'income from a trade or profession,',
    numericValue: null, unit: null, effectiveFrom: '1997-04-06', effectiveTo: null,
    interpretationNote: 'TCA s.3(2): so the earned income credit (s.472AB) applies to a sole trader\'s or active partner\'s profits; '
      + 'a sleeping partner\'s share is not earned income (s.1008(5)).',
  },
];

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
];

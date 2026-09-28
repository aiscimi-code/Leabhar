/**
 * S.I. No. 301 of 2024 (issue #555): the company size figures before it, and
 * the election it inserted as CA 2014 s.280I.
 *
 * The current turnover and balance sheet thresholds are curated from the
 * LRC-revised sections (`companiesAct2014Curation.ts`). The figures they
 * replaced are quoted here from the Regulations' own substitution text (regs
 * 4, 6 and 7), each as a separate `_pre_2024` rule key so the two sets never
 * compete for one key: which set a financial year uses is not a matter of
 * date but of s.280I, which lets the company elect to apply the new figures to
 * each financial year beginning on or after 1 January 2024, or on or after
 * 1 January 2023. `src/domain/reports/companySize.ts` applies the election.
 *
 * The earlier figures date from the Companies (Accounting) Act 2017's
 * insertion of ss.280A, 280D and 280F, in operation 9 June 2017 per the LRC
 * annotation on each section (S.I. No. 246 of 2017, subject to its art. 4
 * transitional provision, which is not captured here). The employee limbs
 * were not amended by S.I. 301/2024 and keep their 2017 date.
 */
import type { CuratedIncomeTaxRule } from './incomeTaxCuration';
import type { SlicedSource } from './slicedSourceIngestion';

export const SI_301_2024_CITATION = 'S.I. 301/2024';
/** Chapter 1A of Part 6 (ss.280A–280H) inserted by the Companies (Accounting) Act 2017, in operation 9 June 2017. */
export const CAA_2017_INSERTION = '2017-06-09';
/** S.I. 301/2024 reg. 2: "These Regulations come into operation on 1 July 2024." */
export const SI_301_2024_IN_OPERATION = '2024-07-01';

export const SIZE_CRITERIA_SOURCES: SlicedSource[] = [{
  path: 'docs/statutes/si-301-2024/2024-si-301.md',
  effectiveFrom: SI_301_2024_IN_OPERATION,
  sourceNote: 'As made; in operation on 1 July 2024 (reg. 2). Plain text of the irishstatutebook.ie print page; the '
    + 'official PDF is beside it, with its hash in the front matter.',
  provisions: [
    { sectionNumber: '2', heading: 'Commencement', category: 'procedure',
      start: '2. These Regulations come into operation', end: '3. In these Regulations' },
    { sectionNumber: '4', heading: 'Amendment of section 280A(3) of the Principal Act', category: 'procedure',
      start: '4. Section 280A(3) of the Principal Act is amended', end: '5. Section 280B(4)' },
    { sectionNumber: '6', heading: 'Amendment of section 280D(3)(b) of the Principal Act', category: 'procedure',
      start: '6. Section 280D(3)(b) of the Principal Act is amended', end: '7. Section 280F(3)' },
    { sectionNumber: '7', heading: 'Amendment of section 280F(3) of the Principal Act', category: 'procedure',
      start: '7. Section 280F(3) of the Principal Act is amended', end: '8. Section 280G(4)' },
    { sectionNumber: '9', heading: 'Insertion of section 280I (treatment of qualifying conditions in respect of certain financial years)',
      category: 'procedure', start: '9. Chapter 1A of Part 6 of the Principal Act is amended', end: 'GIVEN under my Official Seal' },
  ],
}];

const PRIOR_NOTE = 'The figure before S.I. No. 301 of 2024 substituted it, quoted from the substitution. It applies to a '
  + 'financial year the substituted figure does not: under s.280I (inserted by reg. 9) the company elects whether the new '
  + 'figures apply to each financial year beginning on or after 1 January 2024, or on or after 1 January 2023. Dated from '
  + 'the Companies (Accounting) Act 2017 insertion of the section (9 June 2017).';

const prior = (reg: string, key: string, name: string, excerpt: string, value: number): CuratedIncomeTaxRule => ({
  citation: SI_301_2024_CITATION, sectionNumber: reg, ruleKey: `company.${key}_pre_2024`, ruleType: 'threshold',
  name, statementExcerpt: excerpt, numericValue: value, unit: 'eur_minor',
  effectiveFrom: CAA_2017_INSERTION, effectiveTo: SI_301_2024_IN_OPERATION, interpretationNote: PRIOR_NOTE,
});

export const SIZE_CRITERIA_CURATED_RULES: CuratedIncomeTaxRule[] = [
  prior('4', 'small_company_turnover_threshold', 'Small company turnover limit before S.I. 301/2024: €12 million',
    'by the substitution of “€15 million” for “€12 million”', 1_200_000_000),
  prior('4', 'small_company_balance_sheet_threshold', 'Small company balance sheet limit before S.I. 301/2024: €6 million',
    'by the substitution of “€7.5 million” for “€6 million”', 600_000_000),
  prior('6', 'micro_company_turnover_threshold', 'Micro company turnover limit before S.I. 301/2024: €700,000',
    'by the substitution of “€900,000” for “€700,000”', 70_000_000),
  prior('6', 'micro_company_balance_sheet_threshold', 'Micro company balance sheet limit before S.I. 301/2024: €350,000',
    'by the substitution of “€450,000” for “€350,000”', 35_000_000),
  prior('7', 'medium_company_turnover_threshold', 'Medium company turnover limit before S.I. 301/2024: €40 million',
    'by the substitution of “€50 million” for “€40 million”', 4_000_000_000),
  prior('7', 'medium_company_balance_sheet_threshold', 'Medium company balance sheet limit before S.I. 301/2024: €20 million',
    'by the substitution of “€25 million” for “€20 million”', 2_000_000_000),
  {
    citation: SI_301_2024_CITATION, sectionNumber: '9', ruleKey: 'company.size_criteria_financial_year_election',
    ruleType: 'procedure', name: 'Election: the new size figures apply from financial years beginning 1 January 2024, or 1 January 2023',
    statementExcerpt: 'treat all the amendments as applying either (as the company elects) to -',
    numericValue: null, unit: null, effectiveFrom: SI_301_2024_IN_OPERATION, effectiveTo: null,
    interpretationNote: 'CA 2014 s.280I (inserted by S.I. 301/2024 reg. 9): for the turnover and balance sheet limbs, the '
      + 'amended figures apply either to each financial year beginning on or after 1 January 2024, or (as the company elects) '
      + 'on or after 1 January 2023. The employee limbs were not amended. A person records the election; without one, a '
      + 'financial year beginning in 2023 is flagged.',
  },
];

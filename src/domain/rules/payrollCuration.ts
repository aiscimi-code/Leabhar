/**
 * Payroll rules (EPIC 20, issue #526): PRSI Class A, the National Training
 * Fund levy, and the PAYE and USC deduction procedures an employer follows.
 * Each figure is quoted verbatim from the instrument that sets it and dated
 * from the date that instrument says it applies from. A later figure is a
 * new version of the same rule, never an edit of the earlier one.
 *
 * Sources (docs/statutes/, fetched by scripts/extract_payroll_sources.py):
 * - SWCA 2005 s.13, LRC revised: the Class A thresholds and the PRSI credit.
 *   Their dates come from the LRC amendment notes kept in the .html beside
 *   the Markdown (F107: €352 from 1 January 2008; F108: the credit band from
 *   1 January 2016).
 * - Social Welfare (Miscellaneous Provisions) Act 2024 s.3 and its Table: the
 *   Class A rates, substituted on 1 October in each of 2024 to 2028.
 * - Social Welfare Act 2024 s.2 and Social Welfare and Automatic Enrolment
 *   Retirement Savings System (Amendment) Act 2025 s.2: the employer's
 *   weekly threshold, €527 from 1 January 2025 and €552 from 1 January 2026.
 * - National Training Fund Act 2000 s.4, LRC revised: the 1% levy (F3, from
 *   1 January 2020).
 * - Income Tax (Employments) Regulations 2018 (S.I. 345/2018) and Universal
 *   Social Charge Regulations 2018 (S.I. 510/2018): the deduction procedures,
 *   in operation from 1 January 2019.
 *
 * The income tax rate and band figures the emergency basis uses (s.15 Table
 * Part 1, the higher rate) and the USC rates (s.531AN) are the income tax
 * rules already curated in `incomeTaxCuration.ts`; they are not duplicated.
 */
import type { CuratedIncomeTaxRule } from './incomeTaxCuration';

export const SWCA_S13_CITATION = 'SWCA 2005 s.13';
export const SWMPA_2024_CITATION = '2024 Act 24 s.3';
export const SWA_2024_CITATION = '2024 Act 36 s.2';
export const SWAERSS_2025_CITATION = '2025 Act 19 s.2';
export const NTF_S4_CITATION = 'NTF Act 2000 s.4';
export const SI_345_2018_CITATION = 'S.I. 345/2018';
export const SI_510_2018_CITATION = 'S.I. 510/2018';
export const SI_1_2024_CITATION = 'S.I. 1/2024';
export const TDM_38_03_33_CITATION = 'Revenue TDM Part 38-03-33';
const FA2024 = '2024 Act 43';

/** One row of the Table to SWMPA 2024 s.3: a provision and its six successive texts. */
const tableRow = (provision: string, texts: string[]) =>
  `Section ${provision}\n\n${texts.map((t) => `“${t} per cent”`).join('\n\n')}`;

/** The dates the Table's columns (4) to (8) take effect (s.3(1)-(5)). */
const OCTOBERS = ['2024-10-01', '2025-10-01', '2026-10-01', '2027-10-01', '2028-10-01'];

/** One rule version per column of a Table row, chained by date. */
function scheduled(params: {
  ruleKey: string;
  provision: string;
  texts: string[];
  basisPoints: number[];
  name: (pct: string) => string;
  note: string;
}): CuratedIncomeTaxRule[] {
  const excerpt = tableRow(params.provision, params.texts);
  return OCTOBERS.map((from, i) => ({
    citation: SWMPA_2024_CITATION,
    sectionNumber: '3',
    ruleKey: params.ruleKey,
    ruleType: 'rate' as const,
    name: params.name(params.texts[i + 1]!),
    statementExcerpt: excerpt,
    numericValue: params.basisPoints[i]!,
    unit: 'basis_points' as const,
    effectiveFrom: from,
    effectiveTo: OCTOBERS[i + 1] ?? null,
    interpretationNote: `${params.note} Column (${i + 4}) of the Table, in force from ${from} (s.3(${i + 1})).`,
  }));
}

export const PAYROLL_CURATED_RULES: CuratedIncomeTaxRule[] = [
  // ---- PRSI Class A: employee (SWCA 2005 s.13(2)(a), (b), (db)) ----
  {
    citation: SWCA_S13_CITATION, sectionNumber: '13', ruleKey: 'prsi.class_a_employee_threshold', ruleType: 'threshold',
    name: 'PRSI Class A: no employee contribution on pay of not more than €352 a week',
    statementExcerpt: 'a payment of not more than\n\n€\n352\n\nper week',
    numericValue: 35_200, unit: 'eur_minor',
    effectiveFrom: '2008-01-01', effectiveTo: null,
    interpretationNote: 'SWCA 2005 s.13(2)(a): an employee pays no contribution in a week whose reckonable earnings '
      + 'are €352 or less. The employer\'s contribution is still due (s.13(2)(d)). Dated from LRC note F107.',
  },
  {
    citation: SWCA_S13_CITATION, sectionNumber: '13', ruleKey: 'prsi.class_a_credit_upper', ruleType: 'threshold',
    name: 'PRSI Class A: the PRSI credit applies to weekly pay over €352 and not over €424',
    statementExcerpt: 'more than\n€\n352 and not exceeding\n€\n424 is made',
    numericValue: 42_400, unit: 'eur_minor',
    effectiveFrom: '2016-01-01', effectiveTo: null,
    interpretationNote: 'SWCA 2005 s.13(2)(b): between €352.01 and €424 a week the employee contribution is reduced by '
      + 'the PRSI credit; above €424, s.13(2)(db) charges the full rate. Dated from LRC note F108.',
  },
  {
    citation: SWCA_S13_CITATION, sectionNumber: '13', ruleKey: 'prsi.class_a_credit_max', ruleType: 'relief',
    name: 'PRSI Class A: the credit is €12 less one-sixth of weekly pay over €352.01',
    statementExcerpt: 'difference between\n€\n12 and one-sixth of the difference between the\nreckonable earnings of that contributor and\n€\n352.01',
    numericValue: 1_200, unit: 'eur_minor',
    effectiveFrom: '2016-01-01', effectiveTo: null,
    interpretationNote: 'SWCA 2005 s.13(2)(b)(ii): the contribution at the full rate is reduced by €12 less one-sixth '
      + 'of the amount by which the week\'s reckonable earnings exceed €352.01. Dated from LRC note F108.',
  },
  ...scheduled({
    ruleKey: 'prsi.class_a_employee_rate', provision: '13(2)(db)(ii)',
    texts: ['4', '4.1', '4.2', '4.35', '4.5', '4.7'], basisPoints: [410, 420, 435, 450, 470],
    name: (pct) => `PRSI Class A: employee contribution ${pct}% of reckonable earnings`,
    note: 'SWCA 2005 s.13(2)(db)(ii), as substituted by SWMPA 2024 s.3 (Table, amendment 4); s.13(2)(b)(ii) '
      + '(amendment 1) is substituted with the same rate on the same dates.',
  }),

  // ---- PRSI Class A: employer (SWCA 2005 s.13(2)(d)) ----
  ...scheduled({
    ruleKey: 'prsi.class_a_employer_rate_lower', provision: '13(2)(d)(i)',
    texts: ['7.8', '7.9', '8', '8.15', '8.3', '8.5'], basisPoints: [790, 800, 815, 830, 850],
    name: (pct) => `PRSI Class A: employer contribution ${pct}% where weekly pay does not exceed the threshold`,
    note: 'SWCA 2005 s.13(2)(d)(i), as substituted by SWMPA 2024 s.3 (Table, amendment 2).',
  }),
  ...scheduled({
    ruleKey: 'prsi.class_a_employer_rate_higher', provision: '13(2)(d)(ii)',
    texts: ['10.05', '10.15', '10.25', '10.4', '10.55', '10.75'], basisPoints: [1015, 1025, 1040, 1055, 1075],
    name: (pct) => `PRSI Class A: employer contribution ${pct}% where weekly pay exceeds the threshold`,
    note: 'SWCA 2005 s.13(2)(d)(ii), as substituted by SWMPA 2024 s.3 (Table, amendment 3). The rate applies to '
      + 'the whole of the week\'s reckonable earnings, not only the part over the threshold.',
  }),
  {
    citation: SWA_2024_CITATION, sectionNumber: '2', ruleKey: 'prsi.class_a_employer_threshold', ruleType: 'threshold',
    name: 'PRSI Class A: the employer\'s lower rate applies to weekly pay of €527 or less (2025)',
    statementExcerpt: 'of “€527” for “€496”',
    numericValue: 52_700, unit: 'eur_minor',
    effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01',
    interpretationNote: 'SWCA 2005 s.13(2)(d), as amended by the Social Welfare Act 2024 s.2 from 1 January 2025 (s.2(2)). '
      + 'The earlier €496 is not dated in the sources collected, so no payroll before 2025 is computed.',
  },
  {
    citation: SWAERSS_2025_CITATION, sectionNumber: '2', ruleKey: 'prsi.class_a_employer_threshold', ruleType: 'threshold',
    name: 'PRSI Class A: the employer\'s lower rate applies to weekly pay of €552 or less (2026)',
    statementExcerpt: 'of “€552” for “€527”',
    numericValue: 55_200, unit: 'eur_minor',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    interpretationNote: 'SWCA 2005 s.13(2)(d), as amended by the Social Welfare and Automatic Enrolment Retirement '
      + 'Savings System (Amendment) Act 2025 s.2 from 1 January 2026 (s.2(2)).',
  },

  // ---- PRSI Class S on a director's emoluments (SWCA 2005 s.21(1)(c)) ----
  ...scheduled({
    ruleKey: 'prsi.class_s_emoluments_rate', provision: '21(1)(c)',
    texts: ['4', '4.1', '4.2', '4.35', '4.5', '4.7'], basisPoints: [410, 420, 435, 450, 470],
    name: (pct) => `PRSI Class S: ${pct}% of reckonable emoluments paid through payroll`,
    note: 'SWCA 2005 s.21(1)(c), as substituted by SWMPA 2024 s.3 (Table, amendment 10): a proprietary director on '
      + 'Class S pays the contribution on the emoluments the company pays them; there is no employer contribution. '
      + 'The €650 minimum is the greater-of test for the whole contribution year, settled on the director\'s return.',
  }),

  // ---- National Training Fund levy (NTF Act 2000 s.4) ----
  {
    citation: NTF_S4_CITATION, sectionNumber: '4', ruleKey: 'prsi.ntf_levy_rate', ruleType: 'rate',
    name: 'National Training Fund levy: 1.0% of reckonable earnings, paid by the employer',
    statementExcerpt: 'at the rate of 1.0 per cent of the amount of the reckonable earnings in\nthat week',
    numericValue: 100, unit: 'basis_points',
    effectiveFrom: '2020-01-01', effectiveTo: null,
    interpretationNote: 'NTF Act 2000 s.4(1): charged on every Class A employment\'s reckonable earnings and collected '
      + 'with the employer\'s PRSI (s.4(9)); the employer may not recover it from the employee (s.4(3)). '
      + 'Dated from LRC note F3.',
  },

  // ---- PAYE (S.I. 345/2018) ----
  {
    citation: SI_345_2018_CITATION, sectionNumber: '11', ruleKey: 'paye.cumulative_basis', ruleType: 'procedure',
    name: 'PAYE: tax on cumulative pay to the cumulative cut-off point, less cumulative credits',
    statementExcerpt: '(A x standard rate of tax) + (B x higher rate of tax)',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.11: the RPN\'s yearly cut-off point and credits × periods to date ÷ periods '
      + 'in the year (52, 26 or 12); the tax deducted is the cumulative tax less the tax already deducted, and a '
      + 'negative difference is repaid (reg.11(4)).',
  },
  {
    citation: SI_345_2018_CITATION, sectionNumber: '20', ruleKey: 'paye.week1_basis', ruleType: 'procedure',
    name: 'PAYE: on a non-cumulative basis, each period\'s pay is taxed on its own',
    statementExcerpt: 'shall be calculated by reference to the aggregate of the emoluments paid',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.20: the week 1 (or month 1) basis uses one period\'s share of the cut-off '
      + 'point and credits, ignoring pay and tax earlier in the year.',
  },
  {
    citation: SI_345_2018_CITATION, sectionNumber: '15', ruleKey: 'paye.week53', ruleType: 'procedure',
    name: 'PAYE: a weekly payment on 31 December (or 30 December in a leap year) is taxed as if paid on 1 January',
    statementExcerpt: 'the amount of tax which would have been deductible therefrom if the payment had been made on the preceding 1 January.',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.15: the 53rd weekly payment is taxed on a week 1 basis; S.I. 510/2018 reg.16 '
      + 'does the same for USC.',
  },
  {
    citation: SI_345_2018_CITATION, sectionNumber: '19', ruleKey: 'paye.emergency_no_ppsn', ruleType: 'procedure',
    name: 'PAYE emergency basis: without a PPSN, tax at the higher rate on all pay',
    statementExcerpt: 'who has not furnished an employer with his or her personal public service number, the employer shall deduct tax from such payment at the higher rate of tax.',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.19(2): until an RPN is available, and no PPSN has been given.',
  },
  {
    citation: SI_345_2018_CITATION, sectionNumber: '19', ruleKey: 'paye.emergency_ppsn', ruleType: 'procedure',
    name: 'PAYE emergency basis: with a PPSN, a single person\'s cut-off point for 4 weeks (or 1 month), then the higher rate',
    statementExcerpt: 'one fifty-second of the amount chargeable to tax at the standard rate specified in Part 1 of the Table to section',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.19(3): for the first 4 weeks (1 month if paid monthly) from the first payment, '
      + 'a weekly (monthly) cut-off point of 1/52 (1/12) of the s.15 Table Part 1 band, with no credits; after that, '
      + 'the higher rate on all pay. On an RPN arriving, the year\'s pay and tax to date are brought into the '
      + 'cumulative calculation (reg.19(4)).',
  },
  {
    citation: SI_345_2018_CITATION, sectionNumber: '31', ruleKey: 'paye.pension_deduction', ruleType: 'procedure',
    name: 'PAYE: an allowable pension contribution is deducted from pay before tax is calculated',
    statementExcerpt: 'reduced by the amount of the allowable contribution deductible from those emoluments.',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.31: occupational scheme (s.774, s.776), PRSA (s.787C) and RAC (s.787) '
      + 'contributions deducted by the employer reduce pay for income tax only. USC and PRSI are charged on pay '
      + 'before them. The age-related limits on relief are not checked here.',
  },

  // ---- USC (S.I. 510/2018) ----
  {
    citation: SI_510_2018_CITATION, sectionNumber: '14', ruleKey: 'usc.payroll_cumulative', ruleType: 'procedure',
    name: 'USC: charged on cumulative pay to the cumulative rate cut-off points',
    statementExcerpt: 'A = (B x F) + (C x G) + (D x H) + (E x I)',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 510/2018 reg.14: the RPN\'s yearly cut-off points × periods to date ÷ periods in the year; '
      + 'the USC deducted is the cumulative USC less the USC already deducted.',
  },
  {
    citation: SI_510_2018_CITATION, sectionNumber: '19', ruleKey: 'usc.payroll_emergency', ruleType: 'procedure',
    name: 'USC emergency basis: the highest rate on all pay until an RPN is available',
    statementExcerpt: 'deduct USC from all such payments at the highest rate specified in column (2) of Part 1 of the Table to section 531AN of the Act.',
    numericValue: null, unit: null, effectiveFrom: '2019-01-01', effectiveTo: null,
    interpretationNote: 'S.I. 510/2018 reg.19(1). The highest rate is usc.rate_top.',
  },

  // ---- Enhanced Reporting Requirements (TCA s.897C; S.I. 1/2024; EPIC 21, issue #532) ----
  {
    citation: SI_1_2024_CITATION, sectionNumber: '3', ruleKey: 'err.notification_particulars', ruleType: 'procedure',
    name: 'ERR: each reportable benefit is notified to Revenue on or before it is provided, with its particulars',
    statementExcerpt: 'On or before the provision of any reportable benefit to an employee, an employer shall send a notification containing the following particulars',
    numericValue: null, unit: null, effectiveFrom: '2024-01-04', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.10A, inserted by S.I. 1/2024 reg.3(c) (in operation when made, 4 January 2024): '
      + 'the date, name, PPSN (or address and date of birth), employer reference, employment identifier, amount, '
      + 'category and relevant particulars. TCA s.897C itself applies from 1 January 2024 (S.I. 635/2023).',
  },
  {
    citation: SI_1_2024_CITATION, sectionNumber: '3', ruleKey: 'err.travel_subsistence_subcategories', ruleType: 'definition',
    name: 'ERR: a travel and subsistence payment is reported by subcategory',
    statementExcerpt: '(b) in the case of a travel and subsistence payment, the amount of payment in respect of-',
    numericValue: null, unit: null, effectiveFrom: '2024-01-04', effectiveTo: null,
    interpretationNote: 'S.I. 345/2018 reg.2(1) "relevant particulars", inserted by S.I. 1/2024 reg.3(a): travel vouched, '
      + 'travel unvouched, subsistence vouched, subsistence unvouched, site-based employees (including country money), '
      + 'emergency travel, and eating on site. TDM 38-03-33 §5.3 adds an advance payment subcategory.',
  },
  {
    citation: TDM_38_03_33_CITATION, sectionNumber: '4', ruleKey: 'err.remote_working_daily_allowance', ruleType: 'threshold',
    name: 'ERR: a remote working daily allowance of up to €3.20 a day is paid without deducting tax',
    statementExcerpt: 'payments up to €3.20 to employees, for each day worked from home, subject to',
    numericValue: 320, unit: 'eur_minor', effectiveFrom: '2024-01-01', effectiveTo: null,
    interpretationNote: 'TDM 38-03-33 §4.1: a Revenue administrative practice, not a statutory figure. Any amount over '
      + '€3.20 a day is taxable through payroll (§7.1, example 3). The practice predates ERR; the rule is dated from '
      + 'ERR\'s commencement, when this book first needs it.',
  },
  {
    citation: FA2024, sectionNumber: '8', ruleKey: 'small_benefit.max_incentives', ruleType: 'threshold',
    name: 'Small benefit exemption: up to five qualifying incentives in a year',
    statementExcerpt: 'second, third, fourth or fifth relevant incentive given to an employee in',
    numericValue: 5, unit: 'count', effectiveFrom: '2025-01-01', effectiveTo: '2030-01-01',
    interpretationNote: 'TCA s.112B(1) "qualifying incentive", as substituted by FA 2024 s.8(1)(a) for 2025 and later '
      + 'years (s.8(2)); the section ceases for 2030 (s.112B(3)). A small benefit is a reportable benefit (s.897C).',
  },
  {
    citation: FA2024, sectionNumber: '8', ruleKey: 'small_benefit.cumulative_limit', ruleType: 'threshold',
    name: 'Small benefit exemption: the incentives in a year together do not exceed €1,500',
    statementExcerpt: 'first, second, third, fourth and fifth relevant incentives does not',
    numericValue: 150_000, unit: 'eur_minor', effectiveFrom: '2025-01-01', effectiveTo: '2030-01-01',
    interpretationNote: 'TCA s.112B(1), as substituted by FA 2024 s.8(1)(a): each incentive qualifies only if the '
      + 'cumulative value with the ones before it does not exceed €1,500. One that breaks the limit is taxable in '
      + 'full, not only the excess (TDM 38-03-33 §7.2, example 5).',
  },
];

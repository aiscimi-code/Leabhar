/**
 * The payroll sources (EPICs 20 and 21, issues #526, #532), and the derive
 * step for the curated payroll rules. Every source is a rules catalogue entry
 * (#556); the regulations and the ERR manual are sliced from their official
 * files where their statute copies were (`PAYROLL_SLICED_SOURCES`, #717).
 */
import type { AppDatabase } from '@/db';
import { deriveCuratedRuleFamilies, type IncomeTaxDeriveResult } from './incomeTaxIngestion';
import { PAYROLL_CURATED_RULES } from './payrollCuration';
import { sliceProvision, type CatalogueSlicedSource } from './slicedSourceIngestion';

export { sliceProvision };

/** Ported to the catalogue (#556). The knowledge base loads these entries. */
export const PAYROLL_CATALOGUE_ENTRIES = [
  'swca-2005/s13.json',
  'swmpa-2024/s3.json',
  'swa-2024/s2.json',
  'swaerss-2025/s2.json',
  'ntf-2000/s4.json',
  'si-345-2018/2018-si-345.json',
  'si-1-2024/2024-si-1.json',
  'si-510-2018/2018-si-510.json',
  'tdm-38-03-33/38-03-33.json',
] as const;

const PAYE = 'Payroll: the PAYE deduction procedure (S.I. 345/2018).';
const USC = 'Payroll: the USC deduction procedure (S.I. 510/2018).';
const AS_MADE_2019 = 'As made; in operation from 1 January 2019 for payments made on or after that date (reg.1(2)).';

/**
 * The payroll regulations and Revenue's ERR manual, sliced where their statute
 * copies were (#717): each provision runs from its opening words to the next
 * regulation's heading, which it does not include.
 */
export const PAYROLL_SLICED_SOURCES: CatalogueSlicedSource[] = [
  {
    entry: 'si-345-2018/2018-si-345', ext: 'html',
    title: 'Income Tax (Employments) Regulations 2018 (S.I. No. 345 of 2018)', citation: 'S.I. 345/2018',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2018/si/345/made/en/print', sourceType: 'legislation',
    publicationDate: '2018-09-11', effectiveFrom: '2019-01-01', note: AS_MADE_2019,
    provisions: [
      { sectionNumber: '11', heading: 'Calculation and making of deduction or repayment', category: 'procedure', locator: 'reg.11',
        relevanceReason: PAYE, start: '11. (1) On any payment of emoluments', end: 'Deduction of tax in respect of notional payments' },
      { sectionNumber: '15', heading: 'Deduction in special cases', category: 'procedure', locator: 'reg.15',
        relevanceReason: PAYE, start: '15. (1) This Regulation applies to', end: 'Arrears of pay' },
      { sectionNumber: '19', heading: 'Emergency basis of deduction', category: 'procedure', locator: 'reg.19',
        relevanceReason: PAYE, start: '19. (1) This Regulation applies where', end: 'Aggregation of emoluments in non-cumulative cases' },
      { sectionNumber: '20', heading: 'Aggregation of emoluments in non-cumulative cases', category: 'procedure', locator: 'reg.20',
        relevanceReason: PAYE, start: '20. Where under these Regulations', end: 'Tax-free emoluments' },
      { sectionNumber: '31', heading: 'Deduction or repayment by reference to superannuation contribution', category: 'procedure',
        locator: 'reg.31', relevanceReason: PAYE, start: '31. (1) In this Regulations', end: 'Revocation' },
    ],
  },
  {
    entry: 'si-1-2024/2024-si-1', ext: 'html',
    title: 'Income Tax (Employments) Regulations 2024 (S.I. No. 1 of 2024)', citation: 'S.I. 1/2024',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2024/si/1/made/en/print', sourceType: 'legislation',
    publicationDate: '2024-01-04', effectiveFrom: '2024-01-04',
    note: 'As made; in operation on the date of making, 4 January 2024 (reg.1(2)). Inserts reg.10A (ERR) into S.I. 345/2018.',
    provisions: [{
      sectionNumber: '3', heading: 'Amendment of the Income Tax (Employments) Regulations 2018 (reportable benefits)',
      category: 'procedure', locator: 'reg.3', relevanceReason: 'Payroll: the enhanced reporting particulars (S.I. 1/2024 reg.3).',
      start: '3. The Principal Regulations are amended', end: 'GIVEN under my hand',
    }],
  },
  {
    entry: 'si-510-2018/2018-si-510', ext: 'html',
    title: 'Universal Social Charge Regulations 2018 (S.I. No. 510 of 2018)', citation: 'S.I. 510/2018',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2018/si/510/made/en/print', sourceType: 'legislation',
    publicationDate: '2018-12-04', effectiveFrom: '2019-01-01', note: AS_MADE_2019,
    provisions: [
      { sectionNumber: '14', heading: 'Calculation and making of deduction or repayment', category: 'usc', locator: 'reg.14',
        relevanceReason: USC, start: '14.  (1) On any payment of relevant emoluments', end: 'Deduction of USC in respect of notional payments' },
      { sectionNumber: '19', heading: 'Emergency basis of deduction', category: 'usc', locator: 'reg.19',
        relevanceReason: USC, start: '19.  (1) Until a revenue payroll notification', end: '20.  Where an employer makes a payment' },
    ],
  },
  {
    entry: 'tdm-38-03-33/38-03-33', ext: 'pdf',
    title: 'TDM Part 38-03-33 — Returns by Employers in Relation to Reportable Benefits (Enhanced Reporting Requirements)',
    citation: 'Revenue TDM Part 38-03-33',
    sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-38/38-03-33.pdf',
    sourceType: 'revenue_guidance', publicationDate: null, effectiveFrom: '2024-01-01',
    note: 'Revenue Tax and Duty Manual, reviewed September 2026: guidance on TCA s.897C, not law.',
    provisions: [
      { sectionNumber: '4', heading: 'Reportable Measures', category: 'procedure', locator: 'section 4',
        relevanceReason: 'Payroll: the remote working daily allowance Revenue pays without deducting tax (TDM 38-03-33 §4).',
        start: '4.1. €3.20 remote working daily allowance\nRevenue operates', end: '5. Reporting Requirements\nThe legislation' },
      { sectionNumber: '5', heading: 'Reporting Requirements', category: 'procedure', locator: 'section 5',
        relevanceReason: 'Payroll: the ERR reporting subcategories (TDM 38-03-33 §5).',
        start: '5. Reporting Requirements\nThe legislation', end: '6. Reporting Mechanisms\nThere are three' },
    ],
  },
];

/** Derive the curated payroll rules, one dated version per row, chained by `supersedesRuleId`. */
export function derivePayrollRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  return deriveCuratedRuleFamilies(db, { companyId: params.companyId, rules: PAYROLL_CURATED_RULES, label: 'payroll' });
}

/**
 * The emissions-based limits on capital allowances for cars (TCA Part 11C,
 * ss.380K–380P; issue #466). Part 11C replaced Part 11's cost limits for
 * expenditure incurred on or after 1 July 2008. Cars fall into three groups
 * by their CO2 emissions:
 * - group 1 is allowed the specified amount (€24,000) whatever the car cost;
 * - group 2 the lesser of half that and half the cost;
 * - group 3 nothing.
 *
 * The group boundaries moved twice:
 * - 1 July 2008 (FA 2008 s.31): group 1 up to 155g/km, group 2 up to 190g/km.
 *   Revenue's TDM 11-00-01 §6 states this; the Notes for Guidance no longer
 *   set it out.
 * - 1 January 2021 (FA 2019 s.19, FA 2020 s.14): categories A–B up to
 *   140g/km, and C up to 155g/km.
 * - 1 January 2027 (FA 2024 s.33): category A up to 120g/km, and B up to
 *   140g/km.
 *
 * The 2021 and 2027 schemes are quoted from the Notes for Guidance on Part
 * 11C (FA 2025 edition).
 */
import type { CuratedIncomeTaxRule } from './incomeTaxCuration';
import { nfgCitation } from './corporationTaxCuration';
import type { SlicedSource } from './slicedSourceIngestion';

const NFG_11C = nfgCitation('part11c');
export const TDM_11_00_01_CITATION = 'Revenue TDM Part 11-00-01';

export const CAR_EMISSIONS_SOURCES: SlicedSource[] = [{
  path: 'docs/statutes/tdm-11-00-01/11-00-01.md',
  sourceType: 'revenue_guidance',
  effectiveFrom: '2008-07-01',
  sourceNote: 'Revenue Tax and Duty Manual, last reviewed November 2019, as retrieved on 2026-09-27: the CO2 regime for '
    + 'car expenditure from 1 July 2008 to 31 December 2020. Guidance, not law. Converted from the PDF whose SHA-256 is in '
    + 'the front matter.',
  provisions: [{
    sectionNumber: '6', heading: 'New CO2 emissions regime (post 1 July 2008)', category: 'capital_allowances',
    start: '6. New CO2 emissions regime (post 1 July 2008)\nThe new CO2', end: '8. Renewals/Replacement Allowance\nWhere',
  }],
}];

const REGIME_2008 = { from: '2008-07-01', to: '2021-01-01' };
const REGIME_2021 = { from: '2021-01-01', to: '2027-01-01' };
const REGIME_2027 = { from: '2027-01-01', to: null };

export const CAR_EMISSIONS_CURATED_RULES: CuratedIncomeTaxRule[] = [
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.specified_amount', ruleType: 'threshold',
    name: 'Cars (Part 11C): the specified amount is €24,000',
    statementExcerpt: 'The “specified amount” is defined as €24,000 for an accounting period or basis period',
    numericValue: 2_400_000, unit: 'eur_minor', effectiveFrom: REGIME_2008.from, effectiveTo: null,
    interpretationNote: 'TCA s.380K(4): the specified amount for an accounting or basis period ending on or after 1 January 2007, '
      + 'used for all Part 11C expenditure (from 1 July 2008).',
  },
  // ---- Group 1: allowed the specified amount, whatever the car cost ----
  {
    citation: TDM_11_00_01_CITATION, sectionNumber: '6', ruleKey: 'car.co2_group1_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, 2008 scheme): categories A to C, up to 155g/km, are allowed the specified amount',
    statementExcerpt: 'Group 1 contains categories A, B and C with CO2 emissions up to and including\n155g/km.',
    numericValue: 155, unit: 'count', effectiveFrom: REGIME_2008.from, effectiveTo: REGIME_2008.to,
    interpretationNote: 'TDM 11-00-01 §6: for expenditure from 1 July 2008 to 31 December 2020 (FA 2008 s.31), whose scheme '
      + 'the Notes for Guidance say continues to apply to it. The figure is grams of CO2 per km.',
  },
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.co2_group1_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, from 2021): categories A and B, up to 140g/km, are allowed the specified amount',
    statementExcerpt: 'Category B more than 120g/km up to and including 140g/km,',
    numericValue: 140, unit: 'count', effectiveFrom: REGIME_2021.from, effectiveTo: REGIME_2021.to,
    interpretationNote: 'TCA s.380K(2) categories as amended by FA 2020 s.14, and s.380L(3): cars in category A or B are allowed '
      + '€24,000, for expenditure from 1 January 2021 until the FA 2024 change on 1 January 2027.',
  },
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.co2_group1_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, from 2027): category A, up to 120g/km, is allowed the specified amount',
    statementExcerpt: 'Category A up to and including 120g/km,',
    numericValue: 120, unit: 'count', effectiveFrom: REGIME_2027.from, effectiveTo: REGIME_2027.to,
    interpretationNote: 'TCA s.380L(3) as amended by FA 2024 s.33, for expenditure from 1 January 2027: only category A is allowed €24,000.',
  },
  // ---- Group 2: the lesser of half the specified amount and half the cost ----
  {
    citation: TDM_11_00_01_CITATION, sectionNumber: '6', ruleKey: 'car.co2_group2_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, 2008 scheme): categories D and E, up to 190g/km, are allowed half',
    statementExcerpt: 'and including 190g/km. The allowable expenditure for these cars is the lower',
    numericValue: 190, unit: 'count', effectiveFrom: REGIME_2008.from, effectiveTo: REGIME_2008.to,
    interpretationNote: 'TDM 11-00-01 §6: group 2, 156 to 190g/km; above 190g/km (categories F and G) nothing is allowed.',
  },
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.co2_group2_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, from 2021): category C, up to 155g/km, is allowed half',
    statementExcerpt: 'Category C more than 140g/km up to and including 155g/km,',
    numericValue: 155, unit: 'count', effectiveFrom: REGIME_2021.from, effectiveTo: REGIME_2021.to,
    interpretationNote: 'TCA s.380L(3) as amended by FA 2019 and FA 2020: category C gets the lesser of €12,000 or half the cost; '
      + 'categories D, E and F (over 155g/km) nothing.',
  },
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.co2_group2_max', ruleType: 'threshold',
    name: 'Cars (Part 11C, from 2027): category B, up to 140g/km, is allowed half',
    statementExcerpt: 'Category B more than 120g/km up to and including 140g/km,',
    numericValue: 140, unit: 'count', effectiveFrom: REGIME_2027.from, effectiveTo: REGIME_2027.to,
    interpretationNote: 'TCA s.380L(3) as amended by FA 2024 s.33: category B gets the lesser of €12,000 or half the cost; '
      + 'categories C to F (over 140g/km) nothing.',
  },
  {
    citation: TDM_11_00_01_CITATION, sectionNumber: '6', ruleKey: 'car.group2_fraction', ruleType: 'rate',
    name: 'Cars (Part 11C, 2008 scheme): group 2 is allowed the lower of 50% of the specified amount or 50% of cost',
    statementExcerpt: 'of 50% of the relevant specified limit or 50% of the actual cost of the car.',
    numericValue: 5000, unit: 'basis_points', effectiveFrom: REGIME_2008.from, effectiveTo: REGIME_2008.to,
    interpretationNote: 'TDM 11-00-01 §6, §7: the same half applies to balancing allowances and charges.',
  },
  {
    citation: NFG_11C, sectionNumber: '380L', ruleKey: 'car.group2_fraction', ruleType: 'rate',
    name: 'Cars (Part 11C, from 2021): category C is allowed the lesser of €12,000 or half the cost',
    statementExcerpt: 'cars in category C, the lesser of €12,000 or half the cost of the car, and',
    numericValue: 5000, unit: 'basis_points', effectiveFrom: REGIME_2021.from, effectiveTo: REGIME_2021.to,
    interpretationNote: 'TCA s.380L(3): balancing adjustments are reduced by 50% for a car costing less than €24,000, or in the '
      + 'proportion €12,000 bears to the cost for one costing more.',
  },
  {
    citation: NFG_11C, sectionNumber: '380L', ruleKey: 'car.group2_fraction', ruleType: 'rate',
    name: 'Cars (Part 11C, from 2027): category B is allowed the lesser of €12,000 or half the cost',
    statementExcerpt: 'cars in category B, the lesser of €12,000 or half the cost of the car, and',
    numericValue: 5000, unit: 'basis_points', effectiveFrom: REGIME_2027.from, effectiveTo: REGIME_2027.to,
    interpretationNote: 'TCA s.380L(3) as amended by FA 2024 s.33.',
  },
  {
    citation: NFG_11C, sectionNumber: '380K', ruleKey: 'car.no_documentation_nil', ruleType: 'procedure',
    name: 'Cars (Part 11C): without satisfactory documentation of its emissions, a car is in the category allowed nothing',
    statementExcerpt: 'documentation or where there is no documentation, then the vehicle is deemed to be in',
    numericValue: null, unit: null, effectiveFrom: REGIME_2008.from, effectiveTo: null,
    interpretationNote: 'TCA s.380K(3): deemed category F (category G under the 2008 scheme, TDM 11-00-01 §6.1). The emissions '
      + 'come from the car\'s registration certificate; the register records them as the person\'s entry.',
  },
];

/**
 * Curated rules for capital allowances, from TCA 1997 s.284 (wear and tear
 * allowances) as enacted — the first non-RCT, non-VAT TCA 1997 curation in
 * this KB, using the generic `tca1997Ingestion.ts` pipeline built for it.
 *
 * **Deliberately NOT curated: the allowance percentage.** s.284(2)(a) as
 * enacted in 1997 states 15% (general plant/machinery) and 20% (certain
 * vehicles) — this file's own front matter carries the same standing
 * warning every tca-1997/*.md file does: "No LRC revised TCA. Later Finance
 * Acts may have substituted this section." Ireland's wear-and-tear regime
 * has in fact been amended since 1997 (most plant/machinery capital
 * allowances write off over 8 years, i.e. 12.5% per annum straight-line,
 * not the enacted 15%/20% reducing figures) — curating either enacted
 * percentage as if current would repeat exactly the stale-VAT-rate mistake
 * `vatcaRevisedCuration.ts` exists to fix, with no fresher source yet
 * ingested to fix it the same way. So only the *qualification* test below
 * is curated — whether a wear-and-tear allowance is available at all, a
 * structural rule unlikely to have been rewritten even where the rate has
 * — never the rate itself.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export interface CuratedCapitalAllowanceRule {
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  taxEffect: string;
  accountingEffect: string | null;
  reportingEffect: string | null;
  effectiveFrom: string;
  interpretationNote: string;
}

export const CAPITAL_ALLOWANCES_CURATED_RULES: CuratedCapitalAllowanceRule[] = [
  {
    citation: '1997 Act 39 s.284',
    sectionNumber: '284',
    ruleKey: 'income_tax.wear_and_tear_allowance_qualifies',
    ruleType: 'deductibility',
    topic: 'capital_allowances',
    name: 'Wear and tear allowance: capital expenditure on machinery/plant wholly and exclusively for the trade',
    statementExcerpt: 'where a person carrying on a trade in any chargeable period has incurred capital '
      + 'expenditure on the provision of machinery or plant for the purposes of the trade, an allowance (in this '
      + 'Chapter referred to as a “wear and tear allowance”) shall be made to such person',
    conditions: [
      { field: 'isCapitalExpenditure', operator: 'equals', value: 'true' },
      { field: 'description', operator: 'matches', value: '\\b(machinery|plant|equipment|vehicle|computer|furniture)\\b' },
      { field: 'businessUsePercent', operator: 'equals', value: 100 },
    ],
    exceptions: [
      {
        condition: 'the expenditure is on a building or structure that is or is deemed to be an industrial '
          + 'building or structure under section 268',
        effect: 'no wear and tear allowance under this section — a different capital allowances regime applies instead',
      },
      {
        condition: 'accumulated wear-and-tear and initial allowances would exceed the asset\'s actual cost',
        effect: 'no further wear and tear allowance is made once that cap is reached (s.284(4))',
      },
    ],
    taxEffect: 'Capital expenditure on machinery or plant, in use wholly and exclusively for the trade at the end '
      + 'of the chargeable period, qualifies for a wear-and-tear allowance against trading income — a capital '
      + 'allowance, not a same-year revenue deduction. The applicable percentage is NOT determined by this rule: '
      + 's.284(2)\'s own enacted rates (15%/20%) are very likely superseded by later Finance Acts not yet '
      + 'ingested into this KB (Irish capital allowances for most plant/machinery are commonly 12.5% straight-line '
      + 'today) — treat this as confirming eligibility only, and get the current rate from Revenue guidance before '
      + 'computing the allowance amount.',
    accountingEffect: 'Capitalise the asset; do not expense the full cost through the P&L in the year of purchase. '
      + 'The wear-and-tear allowance is a tax computation adjustment (capital allowances), separate from any '
      + 'accounting depreciation charge.',
    reportingEffect: null,
    effectiveFrom: '1997-01-01',
    interpretationNote: '"wholly and exclusively so used" is mapped onto `businessUsePercent = 100`, the same '
      + 'imperfect-proxy pattern used throughout this KB for that phrase (e.g. vat.input_deduction_general) — a '
      + 'reasonable but not literal restatement (partial business use may still attract an apportioned allowance '
      + 'under general principles, which this simple equality condition does not evaluate). `isCapitalExpenditure` '
      + 'and the machinery/plant keyword match are both proxies for "capital expenditure on...machinery or plant", '
      + 'not a reading of the actual asset purchased. `effectiveFrom` is a year-level placeholder (the Act\'s own '
      + 'citation year), not a verified exact commencement date — same caveat as rctIngestion.ts\'s TCA 1997 s.530 date.',
  },
];

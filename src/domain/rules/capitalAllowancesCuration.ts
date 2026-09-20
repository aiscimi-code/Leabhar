/**
 * Curated rules for capital allowances, from TCA 1997 s.284 (wear and tear
 * allowances) as enacted, and Finance Act 2003 s.23 (the current rate) —
 * the first non-RCT, non-VAT TCA 1997 curation in this KB, using the
 * generic `tca1997Ingestion.ts` pipeline built for it.
 *
 * **The allowance percentage (issue #132).** s.284(2)(a) as enacted in 1997
 * states 15% (general plant/machinery) and 20% (certain vehicles) — this
 * file's own front matter carries the same standing warning every
 * tca-1997/*.md file does: "No LRC revised TCA. Later Finance Acts may have
 * substituted this section." There is no LRC-revised TCA 1997 corpus to
 * fetch the current text from the way `vatcaRevisedCuration.ts` does for
 * VATCA s.46, so the VATCA-s.46 pattern doesn't directly apply — instead,
 * Finance Act 2003 s.23 (the amending Act that actually inserted the
 * current 12.5% figure, confirmed by reading FA 2001 s.53 first — that Act
 * inserted a 20% rate from 1 January 2001, itself superseded by FA 2003
 * s.23's insertion of TCA 1997 s.284(2)(ad): 12.5% of actual cost, for
 * capital expenditure incurred on or after 4 December 2002) is ingested and
 * curated as its own source, the same way Finance Act 2024 s.78 and
 * S.I. 69/2025 reg.8 supplied current figures elsewhere in this KB.
 * `docs/statutes/finance-act-2001/s53.md` (the superseded 20% insertion)
 * exists verbatim on disk for the trail but is not itself ingested — no
 * rule in this KB needs to state a historical, no-longer-applicable rate.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/** Matches the `irish_tax_rules.unit` column's enum (src/db/schema/irishRules.ts); not separately exported there. */
type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedCapitalAllowanceRule {
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  numericValue: number | null;
  unit: IrishRuleUnit | null;
  qualifier: string | null;
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
    numericValue: null,
    unit: null,
    qualifier: null,
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
      + 'allowance, not a same-year revenue deduction. This rule confirms eligibility only, not the applicable '
      + 'percentage — see income_tax.wear_and_tear_rate_current (Finance Act 2003 s.23) for the actual rate.',
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
  {
    citation: '2003 Act 3 s.23',
    sectionNumber: '23',
    ruleKey: 'income_tax.wear_and_tear_rate_current',
    ruleType: 'rate',
    topic: 'capital_allowances',
    name: 'Wear and tear allowance rate: 12.5% straight-line (current, TCA 1997 s.284(2)(ad))',
    statementExcerpt: 'where capital expenditure is incurred on or after 4 December 2002 on the provision of '
      + 'machinery or plant, the amount of the wear and tear allowance to be made shall be an amount equal to '
      + '12.5 per cent of the actual cost of the machinery or plant',
    numericValue: 12.5,
    unit: 'percent',
    qualifier: 'applies to capital expenditure on machinery/plant incurred on or after 4 December 2002 — '
      + 'excludes machinery/plant to which s.284(3A) relates (fishing vessels), a car within the meaning of '
      + 's.286 used for qualifying purposes, and machinery/plant under a binding written contract evidenced in '
      + 'writing before 4 December 2002 with expenditure incurred on or before 31 January 2003 (a transitional '
      + 'carve-out, itself now decades in the past). Accelerated-allowance sections (285A/285C/285D/286) '
      + 'override this rate for the specific asset classes they name.',
    conditions: [
      { field: 'isCapitalExpenditure', operator: 'equals', value: 'true' },
      { field: 'description', operator: 'matches', value: '\\b(machinery|plant|equipment|vehicle|computer|furniture)\\b' },
      { field: 'businessUsePercent', operator: 'equals', value: 100 },
    ],
    exceptions: [
      {
        condition: 'the machinery/plant is one to which s.284(3A) relates (fishing vessels), or a car within '
          + 'the meaning of s.286 used for qualifying purposes',
        effect: 'the 12.5% rate does not apply — a different provision sets the rate instead',
      },
      {
        condition: 'the expenditure predates 4 December 2002',
        effect: 'the superseded 15%/20% enacted rates (or the 20% rate Finance Act 2001 s.53 inserted from '
          + '1 January 2001) may apply instead, depending on when the expenditure was actually incurred — not '
          + 'curated as a rule here, since no capital expenditure incurred that long ago should still be within '
          + 'its wear-and-tear write-off period today',
      },
      {
        condition: 'an accelerated-allowance section (285A/285C/285D/286) applies to the specific asset class',
        effect: 'that section\'s own rate/timing overrides this one',
      },
    ],
    taxEffect: 'The wear-and-tear allowance for qualifying machinery/plant capital expenditure incurred on or '
      + 'after 4 December 2002 is 12.5% of actual cost per annum, straight-line (an 8-year write-off) — not the '
      + '15%/20% reducing-balance figures TCA 1997 s.284(2)(a) states as enacted in 1997, which this rate '
      + 'supersedes for all but the narrow carve-outs above. See income_tax.wear_and_tear_allowance_qualifies '
      + 'for the underlying eligibility test this rate applies to.',
    accountingEffect: 'The wear-and-tear allowance is a tax computation adjustment, not the accounting '
      + 'depreciation charge — the two commonly differ and both must be tracked separately.',
    reportingEffect: null,
    effectiveFrom: '2002-12-04',
    interpretationNote: 'Same conditions as income_tax.wear_and_tear_allowance_qualifies — this rule states the '
      + 'rate for expenditure this KB has already flagged as eligible, not a separate eligibility test of its '
      + 'own. Confirmed (issue #132) by reading Finance Act 2001 s.53 first (which inserted a 20% rate from '
      + '1 January 2001) and finding it itself superseded by this section for expenditure from 4 December 2002 '
      + 'onward — FA 2001 s.53 is not ingested as a source since no rule needs to state that superseded figure. '
      + 'Companion source: Revenue TDM Part 04-08-12 states "The current rate for these allowances is 12.5% of '
      + 'the cost per year, for a maximum of eight years" (for the Case V furnished-lettings context specifically '
      + '— not itself curated into a rule here, since it restates the same 12.5% figure this rule already states '
      + 'from the statute, which sourceHierarchy.ts already ranks above it).',
  },
];

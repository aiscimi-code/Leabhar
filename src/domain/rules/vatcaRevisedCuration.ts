/**
 * Curated rules for the CURRENT VAT rates, from VATCA 2010 s.46 in its
 * LRC-revised form (docs/statutes/vatca-2010-revised/s046.md) —
 * deliberately never from the as-enacted text `vatcaCuration.ts` reads.
 *
 * `vatcaCuration.ts`'s own header explains why s.46 was left uncurated
 * there: the as-enacted text states 21%/13.5%/4.8%/0% as they stood in
 * 2010, and the standard rate has since changed (23% today) by later
 * Finance Acts not ingested — "curating that figure as a live rule would
 * let a current transaction resolve against a stale rate with no signal
 * that it is wrong". This file exists because that reasoning no longer
 * applies: the LRC-revised text is the *current* wording, kept up to date
 * by the Law Reform Commission itself, not a frozen 2010 snapshot. Ingesting
 * it (`vatcaRevisedIngestion.ts`) as its own source — never merged with the
 * as-enacted text — is what makes curating s.46 safe now.
 *
 * Most of these rules carry a real `numericValue`/`unit: 'percent'`: the
 * rate is a plain fact stated in the text, not a legal test (that
 * categorisation work is what `vatcaScheduleCuration.ts`'s Schedule 2/3
 * rules already do). Three of them — `vat.rate_standard_current`,
 * `vat.rate_reduced_current` and (until issue #136 bug 1's fix)
 * `vat.rate_livestock_current` — deliberately carry NO `conditions`, for
 * the same reason `vat.charge_general` (s.3) has none in `vatcaCuration.ts`:
 * they state that a rate exists, not a condition to test against a
 * transaction. `transactionLookup.ts` is responsible for never presenting
 * more than one of these "headline rate" facts as if it were *the*
 * determined treatment for a given transaction — see its own
 * "VAT rate exclusivity" section: when any rate rule WITH real conditions
 * matches (Schedule 2/3 items, `vat.rate_livestock_current` below, or the
 * hospitality-gap rule below), every empty-condition rate rule is dropped;
 * otherwise only `VAT_STANDARD_RATE_FALLBACK_RULE_KEY` survives among them.
 * Before that exclusivity logic existed, all matching empty-condition rate
 * rules were listed side by side — issue #136 bug 1 ("solicitor invoice and
 * US SaaS both attach 23% + 13.5% + 4.8%").
 *
 * `effectiveFrom` for the standard-rate rule (2021-03-01) is not a guess:
 * s.46(1A)'s own text states a temporary substitution of "21 per cent" for
 * "23 per cent" running only "from 1 September 2020 to 28 February 2021" —
 * which is itself proof, straight from the statute's own words, that 23%
 * applies immediately outside that window, including from 1 March 2021.
 * The 13.5% rule carries no comparable textual evidence of an exact
 * commencement date, so its `effectiveFrom` is the date this KB last
 * confirmed it against the (continuously-updated) LRC text, not a claim
 * about how long it has actually been in force — see its own
 * `interpretationNote`.
 *
 * `vat.rate_livestock_current` now carries a real condition (a keyword
 * match against VATCA s.2(1)'s own "livestock" definition — cattle, sheep,
 * goats, pigs, deer, and horses normally intended for use in the
 * preparation of foodstuffs or in agricultural production) instead of the
 * empty condition list it had before issue #136 bug 1's fix, so it no
 * longer matches every VAT-topic transaction regardless of what was
 * actually supplied.
 *
 * The temporary/narrow 9% sub-rates in paragraphs (ca)/(caa)/(cab)/(cac)/(cb)
 * remain deliberately NOT curated as their own rate figures — modelling
 * five separate date-boxed rates correctly needs the same care as the
 * headline rates and is left for a future pass (tracked as issue #129).
 * `vat.rate_restaurant_catering_reduced_current` and
 * `vat.rate_hospitality_9pct_not_modelled` below give the one sub-category
 * named in issue #136 bug 8 (restaurant/catering, moving from 13.5% to a
 * temporary 9% under Finance Act 2025 ss.70-71 from 1 July 2026 per
 * docs/statutes/vat-rates/schedule-moves-2025-2026.md — Revenue's own
 * administrative rates table, not yet independently verified against FA
 * 2025's enacted text, which this KB does not ingest) an explicit,
 * date-bounded, keyword-conditioned pair of rules: 13.5% up to 30 June
 * 2026, then an explicit "not modelled" gap flag from 1 July 2026 — rather
 * than silently keeping the 13.5% blanket fact live past the date this KB
 * already knows, from that same reference table, it stops being correct.
 */
import type { IrishRuleCondition, IrishRuleType } from '@/db/schema';

export interface CuratedVatcaRevisedRule {
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  extractedFact: string;
  numericValue: number | null;
  unit: 'percent' | null;
  qualifier: string | null;
  conditions: IrishRuleCondition[];
  vatEffect: string | null;
  effectiveFrom: string;
  /** Null means still in force. Set only when this KB itself knows, from a
   *  dated reference, that the stated rate stops applying to this category
   *  from this date — never a guess. */
  effectiveTo: string | null;
  interpretationNote: string;
}

/** The one empty-condition VAT rate rule `transactionLookup.ts`'s exclusivity
 *  logic keeps as the last-resort fallback when no rate rule with real
 *  conditions matched — see this file's own header. */
export const VAT_STANDARD_RATE_FALLBACK_RULE_KEY = 'vat.rate_standard_current';

export const VATCA_REVISED_CURATED_RULES: CuratedVatcaRevisedRule[] = [
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_standard_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current standard VAT rate: 23%',
    statementExcerpt: '23 per\ncent\nof the amount on which tax is\nchargeable',
    extractedFact: '23 per cent',
    numericValue: 23, // plain percent number, matching factExtractor.ts's own convention (not basis points)
    unit: 'percent',
    qualifier: 'the rate under paragraph (a), the default rate outside the zero/reduced/livestock cases in the other paragraphs',
    conditions: [],
    vatEffect: 'The standard VAT rate is 23%, chargeable on a supply of goods or services, an intra-Community '
      + 'acquisition, or an importation, unless a zero rate (Schedule 2), reduced rate (Schedule 3), one of the '
      + 'narrower temporary 9% carve-outs, or the 4.8% livestock rate applies instead.',
    effectiveFrom: '2021-03-01',
    effectiveTo: null,
    interpretationNote: 'Supersedes VATCA_CURATED_RULES\' deliberate non-curation of the as-enacted s.46 (2010: '
      + '21%). This rule has no `conditions`: it is the fallback rate, not a test — a transaction only reaches it '
      + 'when no zero-rate (Schedule 2), reduced-rate (Schedule 3), or other specific-rate rule already matched. '
      + '`transactionLookup.ts`\'s exclusivity logic enforces that by ruleKey (see '
      + 'VAT_STANDARD_RATE_FALLBACK_RULE_KEY), not by inference — issue #136 bug 1.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_reduced_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current reduced VAT rate: 13.5%',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'the general reduced rate under paragraph (c), for goods/services of a kind specified in Schedule 3 '
      + '(subject to the narrower 9% carve-outs in the same subsection for specific Schedule 3 items)',
    conditions: [],
    vatEffect: 'The general reduced VAT rate is 13.5%, applying to goods/services of a kind specified in Schedule 3 '
      + '(see vatcaScheduleCuration.ts for which specific paragraphs are curated), except where one of the '
      + 'narrower temporary 9% carve-outs applies instead.',
    effectiveFrom: '2010-11-01',
    effectiveTo: null,
    interpretationNote: 'No comparable textual evidence exists (unlike the standard rate\'s s.46(1A)) pinning an '
      + 'exact commencement date for 13.5% distinct from the Act\'s own 2010 enactment; the source text as '
      + 'currently retrieved states 13.5% with no stated historical change, so the Act\'s own commencement date '
      + 'is used pending closer verification, not asserted as independently confirmed. This rule has no '
      + '`conditions`: like the standard rate above, it is only kept in `applicableRules` by '
      + '`transactionLookup.ts`\'s exclusivity logic when nothing more specific matched (issue #136 bug 1) — the '
      + 'named restaurant/catering category below is curated separately with a real condition and a dated '
      + 'cutoff, precisely because this blanket fact cannot know when a specific Schedule 3 category has moved '
      + 'to a different rate.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_livestock_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current livestock VAT rate: 4.8%',
    statementExcerpt: '4.8 per cent of\nthe amount on which tax is chargeable in relation to the supply of livestock',
    extractedFact: '4.8 per cent',
    numericValue: 4.8,
    unit: 'percent',
    qualifier: 'paragraph (d), the supply of livestock',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\b(livestock|cattle|sheep|goats?|pigs?|deer)\\b|\\bhorses\\b',
      },
    ],
    vatEffect: 'A special 4.8% VAT rate applies to the supply of livestock.',
    effectiveFrom: '2010-11-01',
    effectiveTo: null,
    interpretationNote: 'Same caveat as vat.rate_reduced_current on the commencement date: no textual evidence '
      + 'of a date distinct from the Act\'s own 2010 enactment is present in this section, so that date is used '
      + 'as a placeholder pending closer verification. Unlike the standard/reduced rates above, this rule DOES '
      + 'carry a real condition (issue #136 bug 1) — a keyword match against VATCA s.2(1)\'s own "livestock" '
      + 'definition ("live — (a) cattle, sheep, goats, pigs and deer, and (b) horses normally intended for use '
      + 'in the preparation of foodstuffs or in agricultural production"), which is why it no longer matches '
      + 'every VAT-topic transaction. The keyword match cannot itself confirm the s.2(1) "normally intended for" '
      + 'qualifier for horses specifically, so a horse-related match still needs human review before being '
      + 'treated as authoritative — requiresGuidance is always true regardless (see the derive function).',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_restaurant_catering_reduced_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: restaurant/catering/hot takeaway food, up to 30 June 2026',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'the general reduced rate under paragraph (c), for restaurant/catering/hot-takeaway-food supplies '
      + '(VATCA Schedule 3 paragraph 1(1)) specifically, up to 30 June 2026',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b',
      },
    ],
    vatEffect: 'Restaurant, catering and hot takeaway food supplies (VATCA Schedule 3 paragraph 1(1)) are '
      + 'chargeable at the 13.5% reduced rate up to 30 June 2026.',
    effectiveFrom: '2010-11-01',
    effectiveTo: '2026-07-01',
    interpretationNote: 'Curated separately from the blanket vat.rate_reduced_current fact above (issue #136 '
      + 'bug 8) precisely because this specific Schedule 3 category is known, from '
      + 'docs/statutes/vat-rates/schedule-moves-2025-2026.md (Revenue\'s own administrative rates table, citing '
      + 'Finance Act 2025 ss.70-71 — not yet independently verified against that Act\'s enacted text, which this '
      + 'KB does not ingest), to move to a temporary 9% rate from 1 July 2026. The keyword match is the same '
      + 'imperfect-proxy approach vat.deduction_exclusions_entertainment uses (e.g. it cannot distinguish '
      + 'alcohol/bottled-water/soft-drink sales the schedule-moves note itself excludes from the 9% category, '
      + 'still standard-rated) — requiresGuidance is always true regardless. `effectiveTo` is set to the date '
      + 'this KB itself already knows the 13.5% rate stops applying to this category, not a guess: see '
      + 'vat.rate_hospitality_9pct_not_modelled below for what applies from that date. `supplyType` is required '
      + 'to be \'services\' (issue #143 finding G) because restaurant/catering is a supply of services (VATCA '
      + 'Schedule 3 paragraph 1(1)) — a "takeaway coffee" sold as goods (e.g. a bag of beans) is not this '
      + 'category even though the description keywords alone would match it.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hospitality_9pct_not_modelled',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Restaurant/catering/hot takeaway food from 1 July 2026: temporary 9% rate not modelled in this KB',
    statementExcerpt: 'subject to\nparagraphs (ca)\n,\n\n(caa)\n\n,\n(cab)\n\n,\n\n(cac)\nand\n\n(cb)',
    extractedFact: 'not modelled',
    numericValue: null,
    unit: null,
    qualifier: 'one of the temporary 9% sub-rates in paragraphs (ca)-(cb) this KB does not curate individually — '
      + 'see this file\'s own header and issue #129',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b',
      },
    ],
    vatEffect: null,
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    interpretationNote: 'Deliberately asserts no rate (`vatEffect: null`): from 1 July 2026, restaurant/catering/'
      + 'hot-takeaway-food supplies (VATCA Schedule 3 paragraph 1(1)) move to one of the temporary 9% sub-rates '
      + 's.46(1)(c) itself subjects paragraph (c) to (see the quoted cross-reference above), per '
      + 'docs/statutes/vat-rates/schedule-moves-2025-2026.md (Finance Act 2025 ss.70-71 — not yet ingested '
      + 'verbatim into this KB, so the exact sub-paragraph and its own conditions are not curated; issue #129). '
      + 'Rather than let vat.rate_reduced_current\'s blanket 13.5% fact keep matching a category this KB already '
      + 'knows, from that same reference table, has moved on — or worse, let it silently disappear leaving only '
      + 'the 23% standard-rate fallback — this rule exists purely to surface the gap: '
      + '`transactionLookup.ts`\'s exclusivity logic treats it as a real-condition rate match (issue #136 bug 8), '
      + 'so it suppresses every blanket rate fact for a matching transaction on or after this date, leaving only '
      + 'this explicit "not modelled, needs review" entry — never a guessed rate.',
  },
];

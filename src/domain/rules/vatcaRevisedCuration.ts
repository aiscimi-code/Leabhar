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
    name: 'Reduced rate: restaurant/catering/hot takeaway food, 1 Sept 2023 to 30 June 2026',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'the general reduced rate under paragraph (c), for restaurant/catering/hot-takeaway-food supplies '
      + '(VATCA Schedule 3 paragraph 3(1)/(3)) specifically, from 1 September 2023 (the day after the s.46(1)(cb) '
      + '9% window below expired) to 30 June 2026',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b',
      },
    ],
    vatEffect: 'Restaurant, catering and hot takeaway food supplies (VATCA Schedule 3 paragraph 3(1)/(3)) are '
      + 'chargeable at the 13.5% reduced rate from 1 September 2023 to 30 June 2026.',
    effectiveFrom: '2023-09-01',
    effectiveTo: '2026-07-01',
    interpretationNote: 'Curated separately from the blanket vat.rate_reduced_current fact above (issue #136 '
      + 'bug 8) precisely because this specific Schedule 3 category is known, from '
      + 'docs/statutes/vat-rates/schedule-moves-2025-2026.md (Revenue\'s own administrative rates table, citing '
      + 'Finance Act 2025 ss.70-71 — not yet independently verified against that Act\'s enacted text, which this '
      + 'KB does not ingest), to move to a temporary 9% rate from 1 July 2026. **`effectiveFrom` corrected by '
      + 'issue #129**: this rule originally ran from 2010-11-01 with no carve-out for s.46(1)(cb) below, which '
      + 'verbatim-states this exact category (Schedule 3 paragraphs 3(1)/3(3), among others) at 9% — not 13.5% — '
      + 'from 1 November 2020 to 31 August 2023. Left uncorrected, both rules would have matched the same '
      + 'restaurant/catering transaction in that window with two different rates and no way to tell which '
      + 'applied. Now split into three non-overlapping periods: '
      + 'vat.rate_restaurant_catering_reduced_pre_9pct_window (13.5%, to 2020-10-31), '
      + 'vat.rate_restaurant_catering_9pct_2020_2023 (9%, the verified s.46(1)(cb) window), and this rule '
      + '(13.5% again, from 2023-09-01). The keyword match is the same imperfect-proxy approach '
      + 'vat.deduction_exclusions_entertainment uses (e.g. it cannot distinguish alcohol/bottled-water/soft-'
      + 'drink sales the schedule-moves note itself excludes from the 9% category, still standard-rated) — '
      + 'requiresGuidance is always true regardless. `effectiveTo` is set to the date this KB itself already '
      + 'knows the 13.5% rate stops applying to this category, not a guess: see '
      + 'vat.rate_hospitality_9pct_not_modelled below for what applies from that date. `supplyType` is required '
      + 'to be \'services\' (issue #143 finding G) because restaurant/catering is a supply of services (VATCA '
      + 'Schedule 3 paragraph 3(1)) — a "takeaway coffee" sold as goods (e.g. a bag of beans) is not this '
      + 'category even though the description keywords alone would match it.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_restaurant_catering_reduced_pre_9pct_window',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: restaurant/catering/hot takeaway food, before 1 Nov 2020',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'the general reduced rate under paragraph (c), for restaurant/catering/hot-takeaway-food supplies '
      + '(VATCA Schedule 3 paragraph 3(1)/(3)) specifically, before the s.46(1)(cb) 9% window began',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b',
      },
    ],
    vatEffect: 'Restaurant, catering and hot takeaway food supplies (VATCA Schedule 3 paragraph 3(1)/(3)) were '
      + 'chargeable at the 13.5% reduced rate before 1 November 2020.',
    effectiveFrom: '2010-11-01',
    effectiveTo: '2020-11-01',
    interpretationNote: 'Added by issue #129 to close the gap the correction to '
      + 'vat.rate_restaurant_catering_reduced_current left behind: narrowing that rule\'s own start date to '
      + '2023-09-01 (to make room for the verified 9% window, s.46(1)(cb)) would otherwise have left every '
      + 'restaurant/catering transaction before 1 November 2020 with no matching category-specific rule at all — '
      + 'falling through to the exclusivity fallback, which resolves to the 23% STANDARD rate, not 13.5%, once '
      + 'no real-condition rate rule matches (see vatcaRevisedCuration.ts\'s own header, "VAT rate exclusivity"). '
      + 'Same keyword caveats as the current-period rule above.',
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
      + 'this explicit "not modelled, needs review" entry — never a guessed rate. **Confirmed by issue #129**\'s '
      + 'own pass: the actual s.46(1)(ca)-(cb) text (all five curated below) contains no reference to a 1 July '
      + '2026 date or to restaurant/catering (Schedule 3 paragraph 3) at all — the schedule-moves reference '
      + 'table describes an amendment this KB\'s ingested LRC-revised text does not yet reflect, so this rule\'s '
      + '"not modelled" stance remains correct, not merely pending.',
  },

  // --- s.46(1)(ca)-(cb): the five date-boxed 9% second-reduced-rate carve-outs (issue #129) ---
  //
  // Unlike the headline rates above, each of these five lettered paragraphs
  // bundles multiple, legally distinct Schedule 3 categories under one
  // sentence (e.g. (ca) covers periodicals, sporting facilities AND heat
  // pumps together). Rather than one rule per paragraph with a single
  // grab-bag keyword condition — which would blur which Schedule 3 category
  // actually matched a given transaction — this curates one rule per
  // distinct SUBJECT, reusing the same paragraph's statementExcerpt across
  // its sibling rules where it bundles more than one (the same pattern
  // `vat.rate_restaurant_catering_reduced_current` and
  // `vat.rate_reduced_current` already share one s.46(1)(c) excerpt above).
  //
  // (ca) has no stated commencement date of its own in the fetched text —
  // unlike (caa)/(cab)/(cac)/(cb), which each state an explicit "during the
  // period from X to Y". Rather than guess when it was inserted, its three
  // rules below use the date this KB confirmed the text (2026-09-20) as
  // `effectiveFrom`, the same "confirmed accurate as of ingest, not a
  // historical commencement claim" convention `vatcaRevisedIngestion.ts`
  // already uses at the source level.
  //
  // `effectiveTo` boundaries below deliberately hold the first day the NEXT
  // period applies, not the last day of THIS one, even though the statute's
  // own prose says "to 31 August 2023" etc. — `lookupTaxRule`'s own window
  // test is `effectiveFrom <= asOf && (!effectiveTo || effectiveTo > asOf)`,
  // a strict `>`, so a window meant to cover 31 August 2023 inclusive needs
  // `effectiveTo: '2023-09-01'`, matching the same convention the
  // pre-existing vat.rate_restaurant_catering_reduced_current/
  // vat.rate_hospitality_9pct_not_modelled pair already used (their shared
  // 2026-07-01 boundary). `deriveVatcaRevisedRules`'s own supersede step
  // confirms it: a superseded row's `effectiveTo` is set to the literal
  // `rule.effectiveFrom` of its replacement, not a day earlier.
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_periodicals_9pct_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: periodicals (print and electronic)',
    statementExcerpt: '9 per cent in relation to goods\nor services of a kind specified in\n\nparagraphs 7(a), 7A, 12\n\nand\n12A\nof\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (ca), for goods/services of a kind specified in Schedule 3 paragraphs 7(a) (printed '
      + 'periodicals) and 7A (electronic supply of periodicals and several other printed-matter categories)',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\bperiodical(s)?\\b|\\be-?(magazine|journal)\\b',
      },
    ],
    vatEffect: 'Printed periodicals (Schedule 3 paragraph 7(a)) and the electronic supply of periodicals and '
      + 'related printed matter (Schedule 3 paragraph 7A) are chargeable at 9%, not the general 13.5% reduced '
      + 'rate Schedule 3 goods/services otherwise carry.',
    effectiveFrom: '2026-09-20',
    effectiveTo: null,
    interpretationNote: 'Schedule 3 paragraph 7A actually covers six categories (periodicals, brochures/'
      + 'leaflets/programmes, catalogues, maps/charts, children\'s picture books, printed music) when supplied '
      + 'ELECTRONICALLY, all at 9% — but only the PRINT sub-item 7(a) (periodicals specifically) qualifies at '
      + '9% for a physical copy; print brochures/catalogues/maps (Schedule 3 paragraph 7(b)-(e)) stay at the '
      + 'general 13.5% rate. A keyword match on "periodical" alone cannot distinguish print from electronic, '
      + 'and cannot catch a print or electronic brochure/catalogue/map/children\'s-book transaction correctly '
      + 'described in other words — requiresGuidance is always true regardless. No `supplyType` condition: '
      + 'a periodical can genuinely be sold as either goods (print) or services (electronic access), and this '
      + 'rule intentionally doesn\'t assume one.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_sporting_facilities_9pct_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: sporting facilities (incl. golf)',
    statementExcerpt: '9 per cent in relation to goods\nor services of a kind specified in\n\nparagraphs 7(a), 7A, 12\n\nand\n12A\nof\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (ca), for services of a kind specified in Schedule 3 paragraph 12 (facilities for '
      + 'sporting activities including golf, and physical education activities)',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\bgolf\\b|sporting facilit|\\bgym\\b|physical education',
      },
    ],
    vatEffect: 'The provision of facilities for sporting activities (including golf) or physical education is '
      + 'chargeable at 9%, not the general 13.5% reduced rate Schedule 3 goods/services otherwise carry.',
    effectiveFrom: '2026-09-20',
    effectiveTo: null,
    interpretationNote: 'Schedule 3 paragraph 12(1A) excludes the State or a public body providing these '
      + 'facilities once their total annual turnover for doing so exceeds the VAT services threshold in the '
      + 'current or previous calendar year — a fact this KB has no field to test, so a matching public-body '
      + 'transaction still surfaces for human review rather than being silently excluded or silently matched. '
      + 'Paragraph 12(2)/(3) are genuine LRC deletions (rendered "…" in the fetched Schedule 3 text) and are not '
      + 'curated from.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_heat_pump_installation_9pct_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: low emissions heat pump heating systems',
    statementExcerpt: '9 per cent in relation to goods\nor services of a kind specified in\n\nparagraphs 7(a), 7A, 12\n\nand\n12A\nof\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (ca), for goods/services of a kind specified in Schedule 3 paragraph 12A (the supply '
      + 'and installation of low emissions heat pump heating systems)',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: 'heat pump',
      },
    ],
    vatEffect: 'The supply and installation of a low emissions heat pump heating system is chargeable at 9%, '
      + 'not the general 13.5% reduced rate Schedule 3 goods/services otherwise carry.',
    effectiveFrom: '2026-09-20',
    effectiveTo: null,
    interpretationNote: 'No `supplyType` condition: paragraph 12A states "supply and installation" as one '
      + 'combined transaction, so restricting this to \'goods\' or \'services\' alone would wrongly exclude '
      + 'half of what the paragraph actually covers. A keyword match on "heat pump" cannot itself confirm the '
      + 'system meets whatever "low emissions" technical standard the term requires — requiresGuidance is '
      + 'always true regardless.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_gas_electricity_9pct_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: electricity and heating gas, 1 May 2022 to 31 Dec 2030',
    statementExcerpt: 'during the\nperiod from 1 May 2022 to\n31\nDecember 2030\n, 9 per cent in\nrelation to goods of a kind specified in\nparagraph 17(2)\nand\n(3)\nof\n\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (caa), for goods of a kind specified in Schedule 3 paragraph 17(2) (electricity) and '
      + '17(3) (gas for domestic/industrial heating), from 1 May 2022 to 31 December 2030',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      {
        field: 'description', operator: 'matches',
        value: '\\belectricity\\b|\\bgas\\b',
      },
    ],
    vatEffect: 'The supply of electricity, and of gas for domestic or industrial heating, is chargeable at 9% '
      + 'from 1 May 2022 to 31 December 2030.',
    effectiveFrom: '2022-05-01',
    effectiveTo: '2031-01-01',
    interpretationNote: 'A bare "gas" keyword cannot distinguish domestic/industrial heating gas (this '
      + 'paragraph) from vehicle gas, LPG used as a propellant, welding/cutting gas, or gas sold as lighter '
      + 'fuel — Schedule 3 paragraph 17(3) itself excludes all four — or from gas oil (a different product '
      + 'entirely). requiresGuidance is always true regardless; a matching transaction still needs a human to '
      + 'confirm it is genuinely heating gas.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_social_housing_apartment_9pct_2025_narrow',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: social-policy apartment housing, 8 Oct 2025 to 25 Nov 2025',
    statementExcerpt: 'during the\nperiod from 8 October 2025 to 25 November 2025, 9 per cent in relation to goods of\na kind specified in\nparagraph 9A\nof\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cab), for goods of a kind specified in Schedule 3 paragraph 9A (the supply of an '
      + 'apartment, as part of a social policy, in an apartment block), a seven-week window immediately '
      + 'superseded by paragraph (cac) below',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      {
        field: 'description', operator: 'matches',
        value: 'apartment|social.{0,15}housing',
      },
    ],
    vatEffect: 'The supply of an apartment, as part of a social policy under Schedule 3 paragraph 9A, was '
      + 'chargeable at 9% from 8 October 2025 to 25 November 2025.',
    effectiveFrom: '2025-10-08',
    effectiveTo: '2025-11-26',
    interpretationNote: 'A narrow, now-expired transitional window — paragraph 9A was itself immediately '
      + 'replaced by paragraph 9B (see vat.rate_social_housing_apartment_9pct_current below), which restates '
      + 'the same relief in more detail rather than changing the rate. Curated for historical-transaction '
      + 'accuracy: a business reconciling an October/November 2025 apartment sale needs this window resolvable, '
      + 'not silently absorbed into whatever rule happens to apply today.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_social_housing_apartment_9pct_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: social-policy apartment housing, from 26 Nov 2025',
    statementExcerpt: 'during the\nperiod from 26 November 2025 to 31 December 2030, 9 per cent in relation to—\n\n(i) goods of a kind specified in\n\nsubparagraph (2)\nof\nparagraph 9B\nof\nSchedule 3\n, and\n\n(ii) services of a kind specified\nin\nsubparagraph (3)\nof\nparagraph 9B\nof\nSchedule 3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cac), for goods of a kind specified in Schedule 3 paragraph 9B(2) (the supply of an '
      + 'apartment or apartment block, as part of a social policy) and services of a kind specified in '
      + 'paragraph 9B(3) (developing such immovable goods until completed), from 26 November 2025 to '
      + '31 December 2030',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: 'apartment|social.{0,15}housing',
      },
    ],
    vatEffect: 'The supply of an apartment or apartment block, and services developing one, as part of a '
      + 'social policy under Schedule 3 paragraph 9B, are chargeable at 9% from 26 November 2025 to '
      + '31 December 2030.',
    effectiveFrom: '2025-11-26',
    effectiveTo: '2031-01-01',
    interpretationNote: 'Covers both the goods limb (9B(2), the apartment/block itself) and the services limb '
      + '(9B(3), developing it) under one rule with no `supplyType` condition, since the statute states one 9% '
      + 'figure for both together. "Apartment block" is itself a defined term (a multi-storey building of at '
      + 'least 3 apartments with grouped/common access) this KB does not further verify — requiresGuidance is '
      + 'always true regardless. Supersedes vat.rate_social_housing_apartment_9pct_2025_narrow (paragraph 9A) '
      + 'above, which this paragraph replaced rather than merely followed.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_restaurant_catering_9pct_2020_2023',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: restaurant/catering/hot food, 1 Nov 2020 to 31 Aug 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb), for services of a kind specified in Schedule 3 paragraph 3(1) (restaurant/'
      + 'catering) and 3(3) (hot takeaway food), from 1 November 2020 to 31 August 2023',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b',
      },
    ],
    vatEffect: 'Restaurant, catering and hot takeaway food supplies (VATCA Schedule 3 paragraph 3(1)/(3)) were '
      + 'chargeable at 9% from 1 November 2020 to 31 August 2023 — the COVID-era hospitality relief window.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: '**This is why vat.rate_restaurant_catering_reduced_current and '
      + 'vat.rate_restaurant_catering_reduced_pre_9pct_window above both exclude this window** — it genuinely '
      + 'was 9%, not 13.5%, for this specific period (issue #129). Paragraph (cb) also names Schedule 3 '
      + 'paragraphs 7(b)-(e) (brochures/catalogues/maps/printed music), 8 (cinema/theatre/fairground/exhibition '
      + 'admission), 11 (hotel/guesthouse/holiday accommodation) and 13(3) (hairdressing) for the same window — '
      + 'each curated as its own sibling rule below rather than folded into this one, since they are unrelated '
      + 'subjects a shared keyword condition would blur.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_printed_matter_9pct_2020_2023',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: brochures, catalogues, maps and printed music, 1 Nov 2020 to 31 Aug 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb), for goods of a kind specified in Schedule 3 paragraph 7(b) to (e) (brochures/'
      + 'leaflets/programmes, catalogues/directories, maps/charts, printed music), from 1 November 2020 to '
      + '31 August 2023',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      {
        field: 'description', operator: 'matches',
        value: 'brochure|catalogue|\\bmap(s)?\\b|printed music',
      },
    ],
    vatEffect: 'Brochures, catalogues, maps/charts and printed music (Schedule 3 paragraph 7(b)-(e)) were '
      + 'chargeable at 9% from 1 November 2020 to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: 'Printed periodicals (paragraph 7(a)) are NOT part of this window — they are the '
      + 'separate, currently-standing vat.rate_periodicals_9pct_current above, which covers a different '
      + 'sub-item of the same paragraph 7. "Map" is a broad keyword that could false-match an unrelated '
      + 'transaction description — requiresGuidance is always true regardless.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_admission_9pct_2020_2023',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: cinema/theatre/fairground/exhibition admission, 1 Nov 2020 to 31 Aug 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb), for services of a kind specified in Schedule 3 paragraph 8 (cinema, theatre/'
      + 'musical performances, fairgrounds/amusement parks, museum/heritage exhibitions, open farms), from '
      + '1 November 2020 to 31 August 2023',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\bcinema\\b|\\bfilm screening\\b|theatre|fairground|amusement park|\\bexhibition\\b|open farm',
      },
    ],
    vatEffect: 'Admission to cinema showings, live theatrical/musical performances, fairgrounds/amusement '
      + 'parks, museum/heritage exhibitions, and open farms (Schedule 3 paragraph 8) was chargeable at 9% from '
      + '1 November 2020 to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: '**Known, deliberate overlap with `vat.reduced_rate_cinema_admission` (13.5%) in '
      + 'vatcaScheduleCuration.ts, left unresolved by this pass.** That rule\'s own ingestion pipeline '
      + '(vatcaScheduleIngestion.ts) hardcodes one open-ended `effectiveFrom` per rule with no per-rule '
      + '`effectiveTo` support at all — unlike this file\'s pipeline, which this rule uses — so it cannot '
      + 'currently express "13.5% except during this window" the way '
      + 'vat.rate_restaurant_catering_reduced_current was corrected to above. For a cinema-admission '
      + 'transaction dated in this window, both rules will match and both will surface (13.5% and 9% side by '
      + 'side) rather than one silently winning — the safer of two imperfect outcomes, but a genuine follow-up: '
      + 'vatcaScheduleIngestion.ts needs effectiveTo support before this can be resolved cleanly.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hotel_accommodation_9pct_2020_2023',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: hotel/guesthouse/holiday accommodation, 1 Nov 2020 to 31 Aug 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb), for services of a kind specified in Schedule 3 paragraph 11 (holiday/guest '
      + 'accommodation in a hotel, guesthouse, house, apartment or other establishment, including caravan '
      + 'parks/camping sites), from 1 November 2020 to 31 August 2023',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '\\bhotel\\b|guesthouse|holiday accommodation|caravan park|camping site',
      },
    ],
    vatEffect: 'Holiday/guest accommodation (hotel, guesthouse, house, apartment, caravan park or camping '
      + 'site — Schedule 3 paragraph 11) was chargeable at 9% from 1 November 2020 to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: 'A bare "hotel" keyword cannot distinguish a genuine holiday-accommodation letting '
      + '(this paragraph) from an unrelated hotel expense (e.g. a business-travel overnight stay, which is the '
      + 'CUSTOMER\'s side of the same transaction, not the accommodation supplier\'s output VAT) — '
      + 'requiresGuidance is always true regardless.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hairdressing_9pct_2020_2023',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Second reduced rate: hairdressing, 1 Nov 2020 to 31 Aug 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb), for services of a kind specified in Schedule 3 paragraph 13(3) (hairdressing '
      + 'services), from 1 November 2020 to 31 August 2023',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: 'hairdress',
      },
    ],
    vatEffect: 'Hairdressing services (Schedule 3 paragraph 13(3)) were chargeable at 9% from 1 November 2020 '
      + 'to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: 'Straightforward keyword match; still flagged for review rather than auto-applied, '
      + 'consistent with every other rule in this file — a transaction description is evidence, not proof, '
      + 'of what was actually supplied.',
  },
];

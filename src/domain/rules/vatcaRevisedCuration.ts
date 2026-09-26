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
 * Each rate is a family of dated versions under one ruleKey (issue #205),
 * each version's window taken from the statute text or from the LRC's
 * amendment footnotes (docs/statutes/vatca-2010-revised/s046.html, beside the
 * Markdown and with the SHA-256 its front matter records). Deriving chains
 * the versions by `supersedesRuleId`. The standard rate is 23% from 1 January
 * 2012 (F95), 21% for the s.46(1A) period, then 23% again from 1 March 2021.
 * The 13.5% and 4.8% figures carry no amendment footnote, so they date from
 * the Act's commencement.
 *
 * `vat.rate_livestock_current` now carries a real condition (a keyword
 * match against VATCA s.2(1)'s own "livestock" definition — cattle, sheep,
 * goats, pigs, deer, and horses normally intended for use in the
 * preparation of foodstuffs or in agricultural production) instead of the
 * empty condition list it had before issue #136 bug 1's fix, so it no
 * longer matches every VAT-topic transaction regardless of what was
 * actually supplied.
 *
 * The 9% clauses (ca)-(cb) are curated one rule per subject. Hospitality
 * (Sch.3 3(1), 3(3)) and hairdressing (13(3)) are families of three
 * versions: 9% under (cb) from November 2020 to August 2023; 13.5% from
 * January 2025 (when the (ca) list is first known); 9% from 1 July 2026 under
 * Finance Act 2025 s.71, read from its enacted text
 * (docs/statutes/finance-act-2025). A family's binding takes its rate from
 * `scheduleThreeRate`, and a test checks every version agrees with it.
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
    name: 'Standard VAT rate: 23%, 1 January 2012 to 31 August 2020',
    statementExcerpt: '23 per\ncent\nof the amount on which tax is\nchargeable',
    extractedFact: '23 per cent',
    numericValue: 23, // plain percent number, matching factExtractor.ts's own convention (not basis points)
    unit: 'percent',
    qualifier: 'the rate under paragraph (a), the default rate outside the zero/reduced/livestock cases in the other paragraphs',
    conditions: [],
    vatEffect: 'The standard VAT rate was 23% from 1 January 2012 to 31 August 2020.',
    effectiveFrom: '2012-01-01',
    effectiveTo: '2020-09-01',
    interpretationNote: 'Version 1 of 3. The LRC marks "23 per cent" in paragraph (a) as substituted on 1 January '
      + '2012 by Finance Act 2012 s.87 (footnote F95 in docs/statutes/vatca-2010-revised/s046.html), so 23% is '
      + 'supported from that date; what paragraph (a) said before is not in the repository. Ends where s.46(1A) '
      + 'substitutes 21%.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_standard_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Standard VAT rate: 21%, 1 September 2020 to 28 February 2021',
    statementExcerpt: 'During the period from 1\nSeptember 2020 to 28 February 2021,\nparagraph (a)\nof\nsubsection (1)\n\n'
      + 'shall have effect as if there were substituted "21 per cent" for "23 per\ncent".',
    extractedFact: '21 per cent',
    numericValue: 21,
    unit: 'percent',
    qualifier: 'subsection (1A): paragraph (a) read as 21% for the stated period',
    conditions: [],
    vatEffect: 'The standard VAT rate was 21% from 1 September 2020 to 28 February 2021.',
    effectiveFrom: '2020-09-01',
    effectiveTo: '2021-03-01',
    interpretationNote: 'Version 2 of 3, from s.46(1A) (inserted 1 August 2020, footnote F94). The period is '
      + 'stated in the text itself.',
  },
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
    interpretationNote: 'Version 3 of 3: 23% again from 1 March 2021, the day after s.46(1A)\'s 21% window. Supersedes VATCA_CURATED_RULES\' deliberate non-curation of the as-enacted s.46 (2010: '
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
    interpretationNote: 'The figure "13.5 per cent" in paragraph (c) carries no LRC amendment footnote '
      + '(docs/statutes/vatca-2010-revised/s046.html: F96 covers only the "subject to" words before it), so it '
      + 'has stood since the Act commenced on 1 November 2010. Which Schedule 3 paragraphs bear it on a date '
      + 'depends on the 9% clauses: see scheduleRates.ts. This rule has no `conditions`: '
      + '`transactionLookup.ts`\'s exclusivity logic keeps it only when nothing more specific matched (issue #136 bug 1).',
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
    interpretationNote: 'The figure "4.8 per cent" in paragraph (d) carries no LRC amendment footnote (F106 '
      + 'deletes only words after "livestock"), so it has stood since 1 November 2010. The condition is a keyword '
      + 'match on VATCA s.2(1)\'s "livestock" definition (cattle, sheep, goats, pigs, deer, and horses normally '
      + 'intended for food or agricultural production); it cannot confirm the "normally intended for" test for '
      + 'horses, so requiresGuidance stays true.',
  },

  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hospitality',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Food and drink, catering and hot food: 9%, 1 November 2020 to 31 August 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb) as it read for this period, for Schedule 3 paragraph 3(1) and 3(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b' }],
    vatEffect: 'Restaurant and catering services and hot food and drink (Schedule 3 paragraphs 3(1) and 3(3)) were chargeable at 9% from 1 November 2020 to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: 'Version 1 of 3. The period is stated in (cb) itself. Before it, what s.46(1)(ca) listed '
      + 'is not in the repository (it put hospitality at 9% for part of 2011-2018), so no earlier version is curated '
      + 'and an earlier line is flagged.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hospitality',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Food and drink, catering and hot food: 13.5%, 1 January 2025 to 30 June 2026',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'paragraph (c), the reduced rate, for Schedule 3 paragraph 3(1) and 3(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b' }],
    vatEffect: 'Restaurant and catering services and hot food and drink (Schedule 3 paragraphs 3(1) and 3(3)) were chargeable at 13.5% from 1 January 2025 to 30 June 2026.',
    effectiveFrom: '2025-01-01',
    effectiveTo: '2026-07-01',
    interpretationNote: 'Version 2 of 3. From 1 January 2025 the (ca) list is known ("paragraphs 7(a), 7A, 12 and '
      + '12A", footnote F101) and does not include this paragraph, so (c) applies. From 1 September 2023 to 31 '
      + 'December 2024 the (ca) list is not in the repository, so that period has no version and a line in it is '
      + 'flagged. Ends where Finance Act 2025 s.71 applies.',
  },
  {
    citation: '2025 Act 18',
    sectionNumber: '71',
    ruleKey: 'vat.rate_hospitality',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Food and drink, catering and hot food: 9% from 1 July 2026',
    statementExcerpt: '“(cb) 9 per cent in relation to goods or services of a kind specified in\nparagraphs 3(1), 3(3) and 13(3) of Schedule 3 on which tax would,\nbut for this paragraph, be chargeable in accordance with paragraph\n(c);”.',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb) as substituted by Finance Act 2025 s.71 with effect from 1 July 2026, for '
      + 'Schedule 3 paragraph 3(1) and 3(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(restaurant|catering|takeaway|take-away|take away|hot food)\\b' }],
    vatEffect: 'Restaurant and catering services and hot food and drink (Schedule 3 paragraphs 3(1) and 3(3)) are chargeable at 9% from 1 July 2026, with no end date.',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    interpretationNote: 'Version 3 of 3, from the enacted text of Finance Act 2025 s.71 '
      + '(docs/statutes/finance-act-2025). The LRC revised s.46 does not yet show this substitution.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hairdressing',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Hairdressing: 9%, 1 November 2020 to 31 August 2023',
    statementExcerpt: 'during the\nperiod from 1 November 2020 to\n31\nAugust 2023\n, 9 per cent in relation\nto goods or services of a kind specified in\nparagraphs 3(1)\n,\n3(3)\n,\n\n7(b)\nto\n(e)\n,\n8\n,\n11\nand\n13(3)\nof\nSchedule\n3',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb) as it read for this period, for Schedule 3 paragraph 13(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(hairdress\\w*|haircuts?|barbers?)\\b' }],
    vatEffect: 'Hairdressing services (Schedule 3 paragraph 13(3)) were chargeable at 9% from 1 November 2020 to 31 August 2023.',
    effectiveFrom: '2020-11-01',
    effectiveTo: '2023-09-01',
    interpretationNote: 'Version 1 of 3. The period is stated in (cb) itself. Before it, what s.46(1)(ca) listed '
      + 'is not in the repository (it put hospitality at 9% for part of 2011-2018), so no earlier version is curated '
      + 'and an earlier line is flagged.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_hairdressing',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Hairdressing: 13.5%, 1 January 2025 to 30 June 2026',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'paragraph (c), the reduced rate, for Schedule 3 paragraph 13(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(hairdress\\w*|haircuts?|barbers?)\\b' }],
    vatEffect: 'Hairdressing services (Schedule 3 paragraph 13(3)) were chargeable at 13.5% from 1 January 2025 to 30 June 2026.',
    effectiveFrom: '2025-01-01',
    effectiveTo: '2026-07-01',
    interpretationNote: 'Version 2 of 3. From 1 January 2025 the (ca) list is known ("paragraphs 7(a), 7A, 12 and '
      + '12A", footnote F101) and does not include this paragraph, so (c) applies. From 1 September 2023 to 31 '
      + 'December 2024 the (ca) list is not in the repository, so that period has no version and a line in it is '
      + 'flagged. Ends where Finance Act 2025 s.71 applies.',
  },
  {
    citation: '2025 Act 18',
    sectionNumber: '71',
    ruleKey: 'vat.rate_hairdressing',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Hairdressing: 9% from 1 July 2026',
    statementExcerpt: '“(cb) 9 per cent in relation to goods or services of a kind specified in\nparagraphs 3(1), 3(3) and 13(3) of Schedule 3 on which tax would,\nbut for this paragraph, be chargeable in accordance with paragraph\n(c);”.',
    extractedFact: '9 per cent',
    numericValue: 9,
    unit: 'percent',
    qualifier: 'paragraph (cb) as substituted by Finance Act 2025 s.71 with effect from 1 July 2026, for '
      + 'Schedule 3 paragraph 13(3)',
    conditions: [{ field: 'description', operator: 'matches', value: '\\b(hairdress\\w*|haircuts?|barbers?)\\b' }],
    vatEffect: 'Hairdressing services (Schedule 3 paragraph 13(3)) are chargeable at 9% from 1 July 2026, with no end date.',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    interpretationNote: 'Version 3 of 3, from the enacted text of Finance Act 2025 s.71 '
      + '(docs/statutes/finance-act-2025). The LRC revised s.46 does not yet show this substitution.',
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
  // its sibling rules where it bundles more than one (as the hospitality and
  // hairdressing families above share the (cb) and (c) excerpts).
  //
  // (ca) states no period. Its three rules below start on 1 January 2025,
  // when its list became "paragraphs 7(a), 7A, 12 and 12A" (F101); what it
  // listed before is not in the repository.
  //
  // `effectiveTo` boundaries below deliberately hold the first day the NEXT
  // period applies, not the last day of THIS one, even though the statute's
  // own prose says "to 31 August 2023" etc. — `lookupTaxRule`'s own window
  // test is `effectiveFrom <= asOf && (!effectiveTo || effectiveTo > asOf)`,
  // a strict `>`, so a window meant to cover 31 August 2023 inclusive needs
  // `effectiveTo: '2023-09-01'`, the same convention the family versions
  // above use (their shared 2026-07-01 boundary).
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
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
    interpretationNote: 'From 1 January 2025, when the (ca) list became "paragraphs 7(a), 7A, 12 and 12A" (footnote F101, Finance Act 2024 s.79(a)); what it listed before is not in the repository. '
      + 'Schedule 3 paragraph 7A actually covers six categories (periodicals, brochures/'
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
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
    interpretationNote: 'From 1 January 2025, when the (ca) list became "paragraphs 7(a), 7A, 12 and 12A" (footnote F101, Finance Act 2024 s.79(a)); what it listed before is not in the repository. '
      + 'Schedule 3 paragraph 12(1A) excludes the State or a public body providing these '
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
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
    interpretationNote: 'From 1 January 2025, when the (ca) list became "paragraphs 7(a), 7A, 12 and 12A" (footnote F101, Finance Act 2024 s.79(a)); what it listed before is not in the repository. '
      + 'No `supplyType` condition: paragraph 12A states "supply and installation" as one '
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
    interpretationNote: 'The Schedule 3 paragraph 8 rules (vatcaScheduleParagraphRules.ts) take their rate from '
      + 'scheduleRates.ts, which gives 9% for this same window, so the two agree (issue #205).',
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
];

/**
 * Rule keys earlier releases derived and this curation no longer does
 * (issue #205): their periods are now versions of `vat.rate_hospitality` and
 * `vat.rate_hairdressing`, and the "not modelled" gap is modelled from
 * Finance Act 2025 s.71. The 13.5% restaurant window from 2010 to 2020 is
 * dropped: s.46(1)(ca) put hospitality at 9% for part of it. Deriving
 * retires their rows (an empty window) rather than deleting them.
 */
export const RETIRED_S46_RULE_KEYS = [
  'vat.rate_restaurant_catering_reduced_current',
  'vat.rate_restaurant_catering_reduced_pre_9pct_window',
  'vat.rate_hospitality_9pct_not_modelled',
  'vat.rate_restaurant_catering_9pct_2020_2023',
  'vat.rate_hairdressing_9pct_2020_2023',
];

/**
 * The Schedule 3 sub-paragraph whose rate a multi-version s.46 family
 * states. Its binding takes the rate from `scheduleThreeRate`, and a test
 * checks every version agrees with it.
 */
export const S46_FAMILY_SCHEDULE_REF: Record<string, string> = {
  'vat.rate_hospitality': '3(1)',
  'vat.rate_hairdressing': '13(3)',
};

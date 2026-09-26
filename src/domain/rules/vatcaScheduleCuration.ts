/**
 * Curated rules for VATCA 2010 Schedules 2 (zero-rated goods and services)
 * and 3 (goods and services chargeable at the reduced rate), sourced from
 * the LRC-revised text ingested by `vatcaScheduleIngestion.ts` — never from
 * the paraphrased reference notes elsewhere in docs/statutes/, per this
 * knowledge base's verbatim-only policy (AGENTS.md invariant #8: a rule's
 * authority is the source's own words, never an invention).
 *
 * This file holds the first rules curated (cross-border goods, books,
 * children's clothing, dwellings, solid fuel, repairs, cinema);
 * `vatcaScheduleParagraphRules.ts` covers every remaining paragraph (issue
 * #205), and the #204 coverage matrix justifies the few with no rule. A
 * Schedule 3 rule states no rate: its `rateRefs` are looked up in s.46 by
 * date (`scheduleRates.ts`).
 *
 * Every `statementExcerpt` below is a verbatim substring of the relevant
 * paragraph's own `provisionText`, checked by `vatcaScheduleParser.test.ts`
 * against `vatcaScheduleParser.ts` output — never retyped from memory.
 * Every rule's `conditions` map the paragraph's legal test onto
 * `TransactionContext` fields as a *description keyword match*, the same
 * imperfect-proxy approach `vatcaCuration.ts`'s
 * `vat.deduction_exclusions_entertainment` rule uses and documents: a
 * transaction whose description happens to mention "coal" is a candidate for
 * review, not a determination, because matching words against what is
 * actually a legal list (a specific good, a specific class of service, with
 * its own exclusions) is exactly the kind of unassessable-by-keyword factor
 * AGENTS.md says must be excluded rather than scored — `requiresGuidance` is
 * therefore always true here, and every rule surfaces for human review
 * before any classification is treated as authoritative.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';
import { VATCA_SCHEDULE_PARAGRAPH_RULES } from './vatcaScheduleParagraphRules';

export interface CuratedVatcaScheduleRule {
  scheduleNumber: '2' | '3';
  /** The paragraph number, e.g. "1", "9", "20" — matched against ParsedScheduleParagraph.paragraphNumber. */
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  vatEffect: string | null;
  accountingEffect: string | null;
  reportingEffect: string | null;
  requiresGuidance: boolean;
  interpretationNote: string;
  /**
   * Schedule 3 only: the sub-paragraphs the rule covers ("8(1)", "17(2)").
   * The rate they bear on a date comes from s.46 (`scheduleThreeRate`), not
   * from the rule; every reference in one rule bears the same rate.
   */
  rateRefs?: string[];
}

export const VATCA_SCHEDULE_CURATED_RULES: CuratedVatcaScheduleRule[] = [
  // --- Schedule 2: zero-rated (0%) ---------------------------------------
  {
    scheduleNumber: '2',
    sectionNumber: '1',
    ruleKey: 'vat.zero_rate_intra_community_goods',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Zero-rate: intra-Community dispatch of goods to a VAT-registered EU customer',
    statementExcerpt: 'The supply of goods dispatched or transported from the State to a person registered\n'
      + 'for value-added tax in another Member State, provided that the supplier of the goods\n'
      + 'has complied with',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      { field: 'customerVatRegisteredEu', operator: 'equals', value: 'true' },
      { field: 'customerCountry', operator: 'not_equals', value: 'IE' },
    ],
    exceptions: [
      {
        condition: 'the supplier has not complied with the section 82 invoicing/reporting requirements '
          + 'and has not otherwise justified that failure to the Revenue Commissioners',
        effect: 'the zero rate does not apply; the supply is chargeable at the normal domestic rate instead',
      },
    ],
    vatEffect: 'Zero-rated (0%): no VAT is charged on the sale, and the supplier remains entitled to deduct '
      + 'input VAT on costs of making the supply (an exemption WITH deductibility, not a plain exemption).',
    accountingEffect: null,
    reportingEffect: 'Reported in VAT3 as a zero-rated intra-EU supply and in the associated VIES statement, '
      + 'not as a normal domestic sale.',
    requiresGuidance: true,
    interpretationNote: '`customerVatRegisteredEu` and `customerCountry` are sales-side fields not yet part of '
      + 'the documented `TransactionContext` shape (which is written from a purchase/expense-classification '
      + 'viewpoint) — they are accepted via that interface\'s open index signature and simply appear as '
      + '`unresolvedFields` until a sales-transaction caller supplies them, per transactionLookup.ts\'s own '
      + 'design ("a rule that depends on a field the caller did not supply becomes an unresolved condition, '
      + 'not a false no"). The section 82 compliance test (an invoicing/evidence requirement, not a fact about '
      + 'the transaction itself) is not evaluated at all — always requires guidance.',
  },
  {
    scheduleNumber: '2',
    sectionNumber: '3',
    ruleKey: 'vat.zero_rate_export_outside_community',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Zero-rate: export of goods outside the Community',
    statementExcerpt: 'A supply of goods that are to be transported directly by or on behalf of the\n'
      + 'person making the supply outside the Community.',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      { field: 'goodsExportedOutsideEu', operator: 'equals', value: 'true' },
    ],
    exceptions: [
      {
        condition: 'the goods are a traveller\'s qualifying goods that the traveller (not the supplier) '
          + 'exports themself',
        effect: 'paragraph 3(1) does not apply to that export; it is instead treated as a supply of '
          + 'traveller\'s qualifying goods under a different paragraph',
      },
    ],
    vatEffect: 'Zero-rated (0%): no VAT is charged on the export, and the supplier remains entitled to deduct '
      + 'input VAT on costs of making the supply.',
    accountingEffect: null,
    reportingEffect: 'Reported in VAT3 as a zero-rated export, not as a normal domestic sale.',
    requiresGuidance: true,
    interpretationNote: '`goodsExportedOutsideEu` is a new sales-side field (see the same note on '
      + 'vat.zero_rate_intra_community_goods); it stands in for "transported directly by or on behalf of the '
      + 'person making the supply", which also carries an evidentiary requirement (proof of export) this rule '
      + 'does not evaluate. The traveller\'s-qualifying-goods exception is stated but not evaluated.',
  },
  {
    scheduleNumber: '2',
    sectionNumber: '9',
    ruleKey: 'vat.zero_rate_printed_books',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Zero-rate: printed books, booklets, newspapers and audiobooks',
    statementExcerpt: 'The supply of printed\nbooks and booklets, including',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(book|booklet|atlas|newspaper|audiobook)s?\\b',
      },
    ],
    exceptions: [
      {
        condition: 'a newspaper wholly or predominantly devoted to advertising, or a periodical, brochure, '
          + 'catalogue, directory, programme, stationery book, cheque book, diary, organiser, yearbook, '
          + 'planner, album, or book of stamps/tickets/coupons',
        effect: 'the zero rate does not apply; the item falls outside paragraph 9\'s exclusions',
      },
    ],
    vatEffect: 'Zero-rated (0%) unless one of the stated exclusions applies.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'The condition is a keyword match on the transaction description, not a reading of '
      + 'the actual item — "newspaper" alone cannot distinguish an ordinary newspaper (zero-rated) from one '
      + '"wholly or predominantly devoted to advertising" (excluded), and several of the excluded items '
      + '(diaries, organisers, albums) are themselves commonly described using words that overlap with '
      + 'ordinary stationery. Flags a candidate for review; never classifies outright.',
  },
  {
    scheduleNumber: '2',
    sectionNumber: '10',
    ruleKey: 'vat.zero_rate_childrens_clothing_footwear',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Zero-rate: children\'s personal clothing and footwear',
    statementExcerpt: 'The supply of articles of children’s personal clothing of sizes that do not exceed the sizes of those articles appropriate\n'
      + 'to children of average build of 10 years of age, but excluding',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      {
        field: 'description', operator: 'matches',
        value: '\\bchild(ren)?\\W?s?\\b.{0,20}\\b(clothing|clothes|footwear|shoes)\\b',
      },
    ],
    exceptions: [
      {
        condition: 'clothing made wholly or partly of fur skin (beyond minor trim), or clothing/footwear '
          + 'not described, labelled, marked or marketed on the basis of age or size, or sized above the '
          + 'average 10-year-old',
        effect: 'the zero rate does not apply; the item is chargeable at the normal rate instead',
      },
    ],
    vatEffect: 'Zero-rated (0%) for children\'s clothing/footwear within the paragraph 10 size test, unless a '
      + 'stated exclusion applies.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'The size test ("does not exceed the sizes... appropriate to children of average '
      + 'build of 10 years of age") and the age/size-labelling exclusion are not evaluable from a '
      + 'transaction description at all — this rule only flags plausible candidates by keyword; the actual '
      + 'determination needs the item\'s stated size/label, which is why requiresGuidance is always true.',
  },

  // --- Schedule 3: reduced rate (13.5%) -----------------------------------
  {
    scheduleNumber: '3',
    sectionNumber: '9',
    ruleKey: 'vat.reduced_rate_dwelling_services',
    rateRefs: ['9(1)', '9(2)'],
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: construction/repair work and routine cleaning of private dwellings',
    statementExcerpt: 'Services consisting of the routine cleaning of private dwellings.',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      {
        field: 'description', operator: 'matches',
        value: '(private dwelling|\\bhouse\\b|renovat|extension|refurbish|\\bclean(ing)?\\b.{0,20}dwelling)',
      },
    ],
    exceptions: [
      {
        condition: 'the supply and installation of solar panels (Schedule 2 para.14) or of a low-emissions '
          + 'heat pump heating system (paragraph 12A), or a service where movable goods supplied under the '
          + 'agreement exceed two-thirds of the total taxable amount',
        effect: 'a different paragraph/rate applies instead of the general dwelling-services reduced rate',
      },
    ],
    vatEffect: 'Reduced rate (13.5%) for development/repair work on a private dwelling (subject to the '
      + 'two-thirds movable-goods test) and for routine cleaning of a private dwelling.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Paragraph 9 has two distinct limbs — construction/repair work (9(1), with its own '
      + 'movable-goods value test and carve-outs for solar panels and heat pumps) and routine cleaning '
      + '(9(2)) — collapsed here into one rule with a broad description match because both share the same '
      + 'rate and the same "private dwelling" subject matter. The verbatim statementExcerpt is drawn from '
      + '9(2) only (a short, self-contained sentence); 9(1)\'s own wording is longer and more conditional, '
      + 'and is not independently quoted here. requiresGuidance is always true: none of the value test, the '
      + 'solar-panel/heat-pump carve-outs, or "private dwelling" itself is evaluable from a description alone.',
  },
  {
    scheduleNumber: '3',
    sectionNumber: '17',
    ruleKey: 'vat.reduced_rate_solid_fuel',
    rateRefs: ['17(1)'],
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: coal, peat and other solid fuel',
    statementExcerpt: 'The supply of coal, peat and other solid substances offered for sale solely\nas fuel.',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
      { field: 'description', operator: 'matches', value: '\\b(coal|peat|turf|briquette|solid fuel)s?\\b' },
    ],
    exceptions: [],
    vatEffect: 'Reduced rate (13.5%) for coal, peat and other solid substances sold solely as fuel.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: '"offered for sale solely as fuel" is the actual test (excludes the same material sold '
      + 'for a non-fuel purpose); a description mentioning "coal" or "turf" does not establish that, so this '
      + 'remains a candidate flag, not a determination.',
  },
  {
    scheduleNumber: '3',
    sectionNumber: '20',
    ruleKey: 'vat.reduced_rate_repair_movable_goods',
    rateRefs: ['20'],
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: repairing or maintaining movable goods',
    statementExcerpt: 'repairing or maintaining movable goods',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'description', operator: 'matches', value: '\\b(repair|maintain|maintenance|servicing)\\b' },
    ],
    exceptions: [
      {
        condition: 'the supply, in the course of such repair/maintenance/modification, of accessories, '
          + 'attachments, batteries, tyres, tyre cases, interchangeable tyre treads, inner tubes or tyre '
          + 'flaps; or a service specified in paragraph 20(2) (work-on-movable-goods-for-export, or repair '
          + 'of sea-going vessels/aircraft or their equipment, already zero-rated under Schedule 2)',
        effect: 'the reduced rate does not apply to that excluded part of the supply',
      },
    ],
    vatEffect: 'Reduced rate (13.5%) for repairing or maintaining movable goods (and modifying used movable '
      + 'goods), subject to the stated exclusions.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'A general "repair/maintenance" description match cannot distinguish ordinary movable-'
      + 'goods repair from the excluded parts-and-consumables supplies, or from a repair that is actually '
      + 'zero-rated under Schedule 2 paragraph 4 (sea-going vessels/aircraft) — those need the full transaction '
      + 'detail, not a keyword.',
  },
  {
    scheduleNumber: '3',
    sectionNumber: '8',
    ruleKey: 'vat.reduced_rate_cinema_admission',
    rateRefs: ['8(1)'],
    ruleType: 'rate',
    topic: 'vat',
    name: 'Reduced rate: cinema admission',
    statementExcerpt: 'Promotion of, and admission to, showings of cinematographic films.',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'description', operator: 'matches', value: '\\bcinema\\b|\\bfilm screening\\b' },
    ],
    exceptions: [],
    vatEffect: 'Reduced rate (13.5%) for the promotion of, and admission to, cinema film showings.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Straightforward keyword match; still flagged for review rather than auto-applied, '
      + 'consistent with every other rule in this file — a transaction description is evidence, not proof, '
      + 'of what was actually supplied.',
  },
  // Every remaining paragraph (issue #205 part 3).
  ...VATCA_SCHEDULE_PARAGRAPH_RULES,
];

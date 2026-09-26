/**
 * Rules for the remaining paragraphs of VATCA 2010 Schedules 2 and 3
 * (issue #205 part 3), completing what `vatcaScheduleCuration.ts` began.
 *
 * Same policy as that file: each `statementExcerpt` is verbatim from the
 * LRC revised text (checked by `vatcaScheduleParser.test.ts`); `conditions`
 * are a keyword match on the invoice line's description (with the supplier's
 * name and the invoice's VAT legends), so a match is a candidate, never a
 * determination; each paragraph's exclusions are stated as `exceptions`;
 * `requiresGuidance` is always true.
 *
 * No condition here tests `supplyType`: an invoice line only carries one
 * when the counterparty has a default treatment, and the goods/services
 * distinction is already in the words matched.
 *
 * A Schedule 3 rule names the sub-paragraphs it covers (`rateRefs`); the
 * rate those bear on the line's date comes from s.46 (`scheduleRates.ts`),
 * never from the rule. A rule only groups sub-paragraphs that bear the same
 * rate on every date.
 *
 * Paragraphs with no rule here are justified `not_applicable` in the #204
 * coverage matrix: definitions (Sch.3 paras 1, 2), a deleted paragraph
 * (Sch.3 para 5A), and zero-ratings that turn on who the customer is rather
 * than on what was supplied (Sch.2 paras 5 and 6) — a line for one of those
 * matches only the standard-rate fallback and is flagged `undetermined`.
 */
import type { IrishRuleCondition, IrishRuleException } from '@/db/schema';
import type { CuratedVatcaScheduleRule } from './vatcaScheduleCuration';

const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });

function rule(r: {
  scheduleNumber: '2' | '3';
  sectionNumber: string;
  ruleKey: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions?: IrishRuleException[];
  vatEffect: string;
  interpretationNote: string;
  rateRefs?: string[];
}): CuratedVatcaScheduleRule {
  return {
    ruleType: 'rate', topic: 'vat', accountingEffect: null, reportingEffect: null, requiresGuidance: true,
    exceptions: [], ...r,
  };
}

const ZERO = 'Zero-rated (0%) under s.46(1)(b); the supplier keeps its right to deduct input VAT.';
const SCH3 = 'Chargeable at the rate s.46 gives this Schedule 3 paragraph on the supply date: the reduced rate '
  + 'under s.46(1)(c), or the second reduced rate where a clause of s.46(1) (ca)–(cac) or Finance Act 2025 s.71 '
  + 'covers it (scheduleRates.ts). The rule itself states no rate.';

export const VATCA_SCHEDULE_PARAGRAPH_RULES: CuratedVatcaScheduleRule[] = [
  // ---- Schedule 2 ----
  rule({
    scheduleNumber: '2', sectionNumber: '2', ruleKey: 'vat.zero_rate_import_transport',
    name: 'Zero-rate: transport services relating to imported goods',
    statementExcerpt: 'The supply of transport services relating to the importation of goods where the value of the '
      + 'services is included in the taxable amount in accordance with',
    conditions: [desc('\\bimport(s|ed|ation|ing)?\\b'), desc('\\b(freight|haulage|carriage|shipping|transport|courier)\\b')],
    exceptions: [{
      condition: 'the value of the transport is not included in the taxable amount of the import under s.53(1)',
      effect: 'the zero rate does not apply to the transport service',
    }],
    vatEffect: ZERO,
    interpretationNote: 'Covers 2(2) only. 2(1) (goods consigned onward to another Member State) and 2(3) (imports '
      + 'under the Import One-Stop Shop) are customs-declaration matters: import VAT is not charged on a supplier\'s '
      + 'invoice line. Whether the transport cost was included in the customs value is not on the line.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '3', ruleKey: 'vat.zero_rate_export_transport',
    name: 'Zero-rate: carriage of goods in the State for export',
    statementExcerpt: 'The carriage of goods in the State by or on behalf of a person in performing a contract to '
      + 'transfer the goods to a place outside the Community.',
    conditions: [desc('\\bexport(s|ed|ing)?\\b'), desc('\\b(freight|haulage|carriage|shipping|transport|courier)\\b')],
    vatEffect: ZERO,
    interpretationNote: 'Covers 3(2); 3(1) is vat.zero_rate_export_outside_community. That the destination is '
      + 'outside the Community, and that export evidence is held, is not on the line.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '4', ruleKey: 'vat.zero_rate_vessels_aircraft',
    name: 'Zero-rate: sea-going vessels and international aircraft — supply, repair, hire, fuelling',
    statementExcerpt: 'The supply, modification, repair, maintenance, chartering and hiring of',
    conditions: [desc('\\b(sea-?going|vessels?|trawlers?|ferr(y|ies)|aircraft|airliners?)\\b')],
    exceptions: [
      {
        condition: 'a vessel of 15 tons gross or less, or not used for carrying passengers for reward, sea fishing, '
          + 'other commercial or industrial purposes, or rescue at sea; or an aircraft not used by a transport '
          + 'undertaking operating for reward chiefly on international routes',
        effect: 'paragraph 4 does not apply; the normal rate (or Sch.3 para 20 for repairs) applies',
      },
      {
        condition: 'goods supplied on board to passengers to be taken off the vessel or aircraft',
        effect: 'excluded from 4(5); not zero-rated',
      },
    ],
    vatEffect: ZERO,
    interpretationNote: 'Covers 4(2)–(5). The tonnage and use tests are facts about the vessel or aircraft, not the '
      + 'line; a match only says the line concerns a vessel or aircraft.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '7', ruleKey: 'vat.zero_rate_s56_authorised_person',
    name: 'Zero-rate: supplies to a person authorised under section 56',
    statementExcerpt: 'Subject to section 56 , the supply of qualifying goods and qualifying services to',
    conditions: [desc('\\b(section|s\\.?)\\s?56\\b')],
    exceptions: [{
      condition: 'a supply within s.19(1)(f) or (g), or the customer\'s s.56 authorisation is not current',
      effect: 'the zero rate does not apply',
    }],
    vatEffect: ZERO,
    interpretationNote: 'Covers 7(7). The match is on the invoice citing section 56 (the supplier must quote the '
      + 'authorisation); that the authorisation is valid on the date, and the goods or services qualify, is not '
      + 'on the line. 7(1)–(6) (free ports, the customs-free airport, travellers\' goods, tax-free shops, on-board '
      + 'sales) turn on where and to whom the goods are sold; those lines fall to the standard-rate fallback and are '
      + 'flagged.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '8', ruleKey: 'vat.zero_rate_food_and_drink',
    name: 'Zero-rate: food and drink for human consumption (Table 1 exclusions aside)',
    statementExcerpt: 'A supply of food and drink of a kind used for human consumption, other than',
    conditions: [desc('^(?!.*\\b(alcohol\\w*|beers?|wines?|spirits|ciders?|lagers?|whiske?y|vodka|gin|crisps|popcorn|'
      + 'nuts|sweets|chocolates?|confectioner\\w*|ice ?creams?|biscuits?|cakes?|soft drinks?|minerals|juices?|water|'
      + 'coffee|tea|hot|take-?aways?|meals?|catering|restaurant)\\b).*\\b(groceries|grocery|milk|bread|butter|cheese|'
      + 'eggs?|flour|fruit|vegetables?|potato(es)?|meat|beef|chicken|pork|lamb|fish|rice|pasta|cereals?|porridge|'
      + 'oats|yoghurts?)\\b')],
    exceptions: [{
      condition: 'Table 1 Parts A–D and column (1) of Parts E–F: alcohol, drinks in drinkable form, soft drinks, '
        + 'juices and water, ice cream, savoury snacks, crisps, popcorn, salted nuts, confectionery and bakery '
        + 'products other than bread; food heated or catering (Sch.3 para 3); school and hospital catering (Sch.1 para 5(1))',
      effect: 'not zero-rated: standard rate, or the Schedule 3 rate for catering, hot food and bakery products',
    }],
    vatEffect: ZERO,
    interpretationNote: 'A line naming an excluded item does not match at all, so it falls to the fallback and is '
      + 'flagged rather than zero-rated. Tea and coffee in non-drinkable form are zero-rated (Part E column (2)) '
      + 'but are excluded from the match because the line rarely says which form.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '9A', ruleKey: 'vat.zero_rate_electronic_books',
    name: 'Zero-rate: electronically supplied books, newspapers and audiobooks',
    statementExcerpt: 'The electronic supply of books, newspapers and audiobooks',
    conditions: [desc('\\b(e-?books?|digital (editions?|newspapers?|books?)|(digital|downloadable) audiobooks?|audiobook downloads?)\\b')],
    exceptions: [{
      condition: 'material wholly or predominantly advertising, video or audible music; stationery, diaries, albums '
        + 'or stamp books (para 9(b)–(e)); periodicals and the other items of Sch.3 para 7A',
      effect: 'not zero-rated: 9% under Sch.3 para 7A, or the standard rate',
    }],
    vatEffect: ZERO,
    interpretationNote: 'An electronic periodical is 7A (9%), not 9A; the two are told apart by what the publication '
      + 'is, which the words "digital edition" do not settle.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '11', ruleKey: 'vat.zero_rate_oral_medicine',
    name: 'Zero-rate: oral medicine for people, and oral animal medicine (not for pets)',
    statementExcerpt: 'The supply of medicine of a kind used for',
    conditions: [desc('^(?!.*\\b(dogs?|cats?|pets?|cage birds?|creams?|ointments?|gels?|sprays?|lotions?|injections?|'
      + 'drops|shampoos?)\\b).*\\b(tablets?|capsules?|medicines?|medication|syrups?|paracetamol|ibuprofen|'
      + 'antibiotics?|lozenges?)\\b')],
    exceptions: [
      {
        condition: 'medicine for non-oral use, other than for hormone or nicotine replacement therapy',
        effect: 'not zero-rated; the standard rate applies',
      },
      {
        condition: 'animal medicine packaged, sold or designated for dogs, cats, cage birds or domestic pets',
        effect: 'not zero-rated; the standard rate applies',
      },
    ],
    vatEffect: ZERO,
    interpretationNote: 'Covers 11(1) and (2). Non-oral forms and pet products are excluded from the match, so they '
      + 'are flagged rather than zero-rated; HRT and NRT products in non-oral form are zero-rated but will be '
      + 'flagged for the same reason. The Covid-19 items in 11(4) (to 30 June 2022) and 11(5) are not matched.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '11', ruleKey: 'vat.zero_rate_medical_appliances',
    name: 'Zero-rate: invalid carriages, orthopaedic appliances, hearing aids, artificial limbs, walking aids, AEDs',
    statementExcerpt: 'The supply of medical equipment and appliances, being',
    conditions: [desc('^(?!.*\\b(artificial teeth|dentures?|spectacles|glasses|contact lens(es)?)\\b).*\\b(wheelchairs?|'
      + 'invalid carriages?|crutch(es)?|walking frames?|zimmer frames?|hearing aids?|deaf aids?|orthopaedic|orthopedic|'
      + 'prosthe(sis|ses|tic)|artificial limbs?|surgical belts?|trusses|defibrillators?)\\b')],
    exceptions: [{
      condition: 'artificial teeth, corrective spectacles and contact lenses; mechanically propelled road vehicles',
      effect: 'excluded from 11(3); not zero-rated',
    }],
    vatEffect: ZERO,
    interpretationNote: 'Covers 11(3). "Orthopaedic" can describe ordinary goods (a mattress, a pillow) that are not '
      + 'orthopaedic appliances; the match is a candidate only.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '12', ruleKey: 'vat.zero_rate_fertiliser_feed_seed',
    name: 'Zero-rate: fertiliser (10 kg+), animal feed (not for pets), seed for food production',
    statementExcerpt: 'Animal feeding stuff, excluding feeding stuff which is packaged, sold or otherwise designated '
      + 'for the use of dogs, cats, cage birds or domestic pets.',
    conditions: [desc('^(?!.*\\b(dogs?|cats?|pets?|cage birds?|greyhounds?|bird ?seed)\\b).*\\b(fertili[sz]ers?|'
      + 'animal feed|cattle feed|calf nuts|dairy nuts|sheep nuts|feeding stuffs?|silage|seed potatoes|'
      + 'seed (grain|barley|wheat|oats))\\b')],
    exceptions: [
      {
        condition: 'fertiliser in units under 10 kilograms, or whose sale or manufacture is prohibited',
        effect: 'not zero-rated under 12(2)',
      },
      {
        condition: 'feed packaged, sold or designated for dogs, cats, cage birds or pets; greyhound feed (Sch.3 para 4(1))',
        effect: 'not zero-rated; standard rate, or the Schedule 3 rate for greyhound feed',
      },
      {
        condition: 'seeds, plants or bulbs not of a kind used for sowing to produce food',
        effect: 'not zero-rated; see Sch.3 para 22',
      },
    ],
    vatEffect: ZERO,
    interpretationNote: 'Covers 12(2)–(4). The 10 kg unit size is not on most lines.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '13', ruleKey: 'vat.zero_rate_menstrual_products',
    name: 'Zero-rate: sanitary towels, tampons, menstrual cups, pants and sponges',
    statementExcerpt: 'The supply of sanitary towels, sanitary tampons, menstrual cups, menstrual pants and menstrual sponges.',
    conditions: [desc('\\b(sanitary (towels?|pads?)|tampons?|menstrual (cups?|pants|sponges?)|period pants)\\b')],
    vatEffect: ZERO,
    interpretationNote: 'Covers 13(3).',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '13', ruleKey: 'vat.zero_rate_irish_lights_rnli',
    name: 'Zero-rate: Commissioners of Irish Lights navigational aids; RNLI life-saving services',
    statementExcerpt: 'Services provided by the Commissioners of Irish Lights in connection with the operation of '
      + 'lightships, lighthouses or other navigational aids.',
    conditions: [desc('\\b(Irish Lights|RNLI|Royal National Lifeboat)\\b')],
    exceptions: [{
      condition: 'a supply by these bodies that is not the navigational-aid or life-saving service itself',
      effect: 'paragraph 13(1)–(2) does not apply',
    }],
    vatEffect: ZERO,
    interpretationNote: 'Covers 13(1) and (2), which turn on who the supplier is; the match reads the supplier\'s '
      + 'name, which the line\'s description includes.',
  }),
  rule({
    scheduleNumber: '2', sectionNumber: '14', ruleKey: 'vat.zero_rate_solar_panels',
    name: 'Zero-rate: supply and installation of solar panels on dwellings and schools',
    statementExcerpt: 'The supply and installation of solar panels on or adjacent to immovable goods, being private dwellings',
    conditions: [desc('\\b(solar (panels?|pv|photovoltaic)|photovoltaic|pv (panels?|arrays?|systems?|installation))\\b')],
    exceptions: [{
      condition: 'panels not on or adjacent to a private dwelling or a recognised primary or post-primary school',
      effect: 'not zero-rated; the standard rate, or the Sch.3 construction rate, applies',
    }],
    vatEffect: ZERO,
    interpretationNote: 'Where the panels are installed is not on most lines.',
  }),

  // ---- Schedule 3 ----
  rule({
    scheduleNumber: '3', sectionNumber: '3', ruleKey: 'vat.reduced_rate_restaurant_catering', rateRefs: ['3(1)'],
    name: 'Reduced rate: restaurant and catering services',
    statementExcerpt: 'The supply of restaurant or catering services, excluding',
    conditions: [desc('^(?!.*\\b(wines?|beers?|spirits|alcohol\\w*|cocktails?|lagers?|ciders?|prosecco|champagne|'
      + 'soft drinks?|minerals)\\b).*\\b(restaurant|catering|caterers?|meals?|lunch(eon)?|dinner|breakfast|buffet|'
      + 'banquet|canap[eé]s?)\\b')],
    exceptions: [{
      condition: 'alcoholic drinks (Table 1 Part A), soft drinks and juices (Part E column (1)), and catering '
        + 'exempted by Sch.1 para 5(1)',
      effect: 'excluded from 3(1): the standard rate, or exempt',
    }],
    vatEffect: SCH3,
    interpretationNote: 'A line that names alcohol or soft drinks does not match and is flagged. On the purchase '
      + 'side, input VAT on meals is usually not deductible (s.60(2)); that is a separate rule.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '3', ruleKey: 'vat.reduced_rate_hot_food', rateRefs: ['3(3)'],
    name: 'Reduced rate: hot food and drink',
    statementExcerpt: 'The supply of food and drink that consists of or includes food and drink',
    conditions: [desc('\\b(hot food|hot (chicken|sandwich(es)?|rolls?|meals?|dogs?|drinks?)|take-?aways?|toasted|'
      + 'toasties?|hot deli)\\b')],
    exceptions: [{
      condition: 'bread (Table 1 Part F column (2)); food not above ambient temperature when provided',
      effect: 'excluded from 3(3)',
    }],
    vatEffect: SCH3,
    interpretationNote: 'The temperature test is not on the line.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '3', ruleKey: 'vat.reduced_rate_bakery_products', rateRefs: ['3(5)'],
    name: 'Reduced rate: flour or egg based bakery products (cakes, crackers, wafers, biscuits)',
    statementExcerpt: 'being flour or egg based bakery products (including cakes, crackers, wafers and biscuits)',
    conditions: [desc('^(?!.*\\b(choc(olate)?s?|sweets|confectionery|ice ?creams?)\\b).*\\b(cakes?|cupcakes?|muffins?|'
      + 'scones?|croissants?|pastr(y|ies)|tarts?|crackers?|wafers?|biscuits?|doughnuts?|donuts?|brownies?)\\b')],
    exceptions: [{
      condition: 'wafers and biscuits covered or decorated with chocolate; chocolates, sweets and confectionery; '
        + 'Table 1 Part C items',
      effect: 'excluded from 3(5): the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Any line mentioning chocolate is excluded from the match and flagged, because only '
      + 'chocolate-covered biscuits and wafers are excluded by the paragraph (a chocolate cake is not).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '3A', ruleKey: 'vat.reduced_rate_food_supplements', rateRefs: ['3A'],
    name: 'Reduced rate: food supplements for human oral consumption',
    statementExcerpt: 'The supply of food supplements of a kind used for human oral consumption.',
    conditions: [desc('^(?!.*\\b(dogs?|cats?|pets?|horses?|equine)\\b).*\\b(food supplements?|dietary supplements?|'
      + 'vitamins?|multivitamins?|protein (powder|shakes?)|omega-?3|probiotics?|fish oil)\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Whether a product is a food supplement or a medicine (Sch.2 para 11) is a classification '
      + 'the line does not settle.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '4', ruleKey: 'vat.reduced_rate_greyhound_feed_live_poultry', rateRefs: ['4(1)', '4(2)'],
    name: 'Reduced rate: greyhound feed (10 kg+) and live poultry and ostriches',
    statementExcerpt: 'Live poultry and live ostriches.',
    conditions: [desc('\\b(greyhound (feed|food|meal|nuts)|live (poultry|chickens?|hens?|ducks?|turkeys?|geese|'
      + 'ostrich(es)?)|day-old chicks)\\b')],
    exceptions: [{
      condition: 'greyhound feed not held out solely as such, or in units under 10 kilograms',
      effect: 'excluded from 4(1)',
    }],
    vatEffect: SCH3,
    interpretationNote: 'The unit size is not on most lines.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '5', ruleKey: 'vat.reduced_rate_non_oral_contraceptives', rateRefs: ['5'],
    name: 'Reduced rate: non-oral contraceptive products',
    statementExcerpt: 'Non-oral contraceptive products.',
    conditions: [desc('\\b(condoms?|contraceptive (patch(es)?|rings?|implants?|injections?|coils?)|IUDs?|'
      + 'intrauterine|non-oral contracepti\\w*)\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Oral contraceptives are medicine under Sch.2 para 11 (zero-rated).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '6', ruleKey: 'vat.reduced_rate_child_car_seats', rateRefs: ['6'],
    name: 'Reduced rate: children\'s car safety seats',
    statementExcerpt: 'Children’s car safety seats.',
    conditions: [desc('\\b(child(ren)?\\W?s?|kids?|baby|infant|toddler)\\b.{0,20}\\bcar (safety )?seats?\\b|'
      + '\\bbooster seats?\\b|\\bisofix\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Accessories sold separately are not car safety seats.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '7', ruleKey: 'vat.reduced_rate_printed_periodicals', rateRefs: ['7(a)'],
    name: 'Reduced rate: printed periodicals',
    statementExcerpt: 'Printed matter consisting of',
    conditions: [desc('^(?!.*\\b(advert\\w*|e-?magazines?|digital|online)\\b).*\\b(periodicals?|magazines?)\\b')],
    exceptions: [{
      condition: 'printed matter wholly or substantially devoted to advertising',
      effect: 'excluded from paragraph 7: the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 7(a). Electronic periodicals are 7A (the same 9% rate from 2025).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '7', ruleKey: 'vat.reduced_rate_brochures_catalogues_maps',
    rateRefs: ['7(b)', '7(c)', '7(d)', '7(e)'],
    name: 'Reduced rate: printed brochures, leaflets, programmes, catalogues, directories, maps, printed music',
    statementExcerpt: 'brochures, leaflets and programmes',
    conditions: [desc('^(?!.*\\b(advert\\w*|promotional|promo|marketing|digital|online|e-?brochures?)\\b).*\\b('
      + 'brochures?|leaflets?|(printed|event|match|theatre) programmes?|catalogues?|directories|maps?|hydrographic|'
      + 'nautical charts?|sheet music|printed music)\\b')],
    exceptions: [{
      condition: 'printed matter wholly or substantially devoted to advertising; the items in Sch.2 para 9(b)–(e); '
        + 'any other printed matter',
      effect: 'excluded from paragraph 7: the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 7(b)–(e). Most leaflets and brochures a business buys advertise it, which excludes '
      + 'them; a line that says so does not match, but one that does not say so will.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '7A', ruleKey: 'vat.reduced_rate_electronic_periodicals', rateRefs: ['7A'],
    name: 'Reduced rate: electronically supplied periodicals, brochures, catalogues, maps, children\'s books, music',
    statementExcerpt: 'The electronic supply of — ( a ) periodicals,',
    conditions: [desc('\\b(e-?magazines?|(digital|online) (magazines?|periodicals?|brochures?|catalogues?|maps?)|'
      + 'e-?brochures?|e-?catalogues?|digital sheet music)\\b')],
    exceptions: [{
      condition: 'material wholly or predominantly devoted to advertising, or consisting wholly or predominantly '
        + 'of audible music or video',
      effect: 'excluded from 7A: the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Electronic books and newspapers are Sch.2 para 9A (zero-rated), not 7A.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '8', ruleKey: 'vat.reduced_rate_admissions', rateRefs: ['8(2)', '8(3)', '8(4)', '8(5)'],
    name: 'Reduced rate: admission to theatre and concerts, fairgrounds, museums and heritage sites, open farms',
    statementExcerpt: 'Promotion of, and admission to, live theatrical or musical performances, but excluding',
    conditions: [
      desc('\\b(admissions?|admittance|tickets?|entry|entrance)\\b'),
      desc('^(?!.*\\b(dances?|disco|nightclub)\\b).*\\b(theatre|concerts?|gigs?|musicals?|opera|pantomime|'
        + 'fairground|amusement park|funfair|museums?|galler(y|ies)|heritage|exhibitions?|open farm|pet farm)\\b'),
    ],
    exceptions: [
      {
        condition: 'dances, and performances exempted by Sch.1 para 5(2)',
        effect: 'excluded from 8(2)',
      },
      {
        condition: 'any part of the fee that relates to goods or services other than admission',
        effect: 'that part is not within 8(3)–(5)',
      },
    ],
    vatEffect: SCH3,
    interpretationNote: 'Covers 8(2)–(5); 8(1) is vat.reduced_rate_cinema_admission. A trade-show stand or '
      + 'exhibition space is not admission, but a line that mentions an exhibition and an entry fee will match.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '9A', ruleKey: 'vat.reduced_rate_social_housing_apartment', rateRefs: ['9A'],
    name: 'Reduced rate: apartments supplied as part of a social policy (8–25 Nov 2025 at 9%)',
    statementExcerpt: 'The supply of housing, as part of a social policy, being the supply of an apartment',
    conditions: [desc('\\bapartments?\\b')],
    exceptions: [{
      condition: 'an apartment not in an apartment block within s.31E of the Stamp Duties Consolidation Act 1999, '
        + 'or not used or to be used for residential purposes',
      effect: 'paragraph 9A does not apply (paragraph 14 may)',
    }],
    vatEffect: SCH3,
    interpretationNote: 'From 26 November 2025 paragraph 9B(2) covers apartments at 9% and is preferred.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '9B', ruleKey: 'vat.reduced_rate_apartment_development', rateRefs: ['9B(2)', '9B(3)'],
    name: 'Reduced rate: apartments and apartment blocks, and their development (9% to 2030)',
    statementExcerpt: 'The supply of immovable goods, as part of a social policy, which are or, when completed, will be',
    conditions: [desc('\\bapartments?\\b|\\bapartment blocks?\\b')],
    exceptions: [{
      condition: 'a building with fewer than 3 apartments with grouped or common access, or any part not used or to '
        + 'be used for residential purposes',
      effect: 'paragraph 9B does not apply to it',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 9B(2) (the apartments) and 9B(3) (their development until completed).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '10', ruleKey: 'vat.reduced_rate_agricultural_services', rateRefs: ['10'],
    name: 'Reduced rate: agricultural contracting, farm relief and advisory, insemination, livestock semen',
    statementExcerpt: 'Agricultural services consisting of any of the following:',
    conditions: [desc('^(?!.*\\b(accountan\\w*|farm management|horses?|greyhounds?|equine|mares?|stallions?)\\b).*\\b('
      + 'reaping|mowing|threshing|baling|harvesting|sowing|ploughing|silage cutting|crop spraying|stock-?minding|'
      + 'stock-?rearing|farm relief|farm advisory|ensilage|lopping|tree felling|forestry services|insemination|'
      + 'livestock semen)\\b')],
    exceptions: [{
      condition: 'farm accountancy or farm management services; insemination of horses or greyhounds (Sch.3 para 13B)',
      effect: 'excluded from paragraph 10',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 10(1)–(3).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '11', ruleKey: 'vat.reduced_rate_holiday_accommodation', rateRefs: ['11'],
    name: 'Reduced rate: holiday and guest accommodation (hotels, guesthouses, lets, caravan and camping sites)',
    statementExcerpt: 'the letting of immovable goods where the letting consists of the provision of holiday or guest accommodation in',
    conditions: [desc('\\b(hotel|guest ?house|B&B|bed and breakfast|accommodation|room nights?|caravan park|camping|'
      + 'camp ?site|holiday (lets?|homes?|cottages?|rentals?))\\b')],
    exceptions: [{
      condition: 'a letting outside the regulations on holiday or guest accommodation; meeting rooms and other '
        + 'services on the same bill',
      effect: 'not within paragraph 11',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Input VAT on accommodation is generally not deductible (s.60(2)); that is a separate rule.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '12', ruleKey: 'vat.reduced_rate_sporting_facilities', rateRefs: ['12'],
    name: 'Reduced rate: facilities for taking part in sport (including golf)',
    statementExcerpt: 'The provision of facilities for taking part in sporting activities including golf or physical '
      + 'education activities',
    conditions: [desc('\\b(gym|golf|green fees?|leisure centre|swimming pool|sports? (halls?|pitch(es)?|facilit(y|ies)|'
      + 'centres?)|pitch hire|court hire|tennis|squash|fitness (class(es)?|centre))\\b')],
    exceptions: [{
      condition: 'facilities provided by a non-profit organisation, or by the State or a public body whose turnover '
        + 'from them is within the services threshold; pitch and putt is not golf (para 2(2))',
      effect: 'not within paragraph 12 (typically exempt)',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Who provides the facility is not on the line.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '12A', ruleKey: 'vat.reduced_rate_heat_pumps', rateRefs: ['12A'],
    name: 'Reduced rate: supply and installation of low-emissions heat pump heating systems',
    statementExcerpt: 'The supply and installation of low emissions heat pump heating systems.',
    conditions: [desc('\\bheat pumps?\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Whether the system is a low-emissions heat pump heating system is not on every line.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '13', ruleKey: 'vat.reduced_rate_waste_disposal', rateRefs: ['13(1)'],
    name: 'Reduced rate: acceptance of waste for disposal',
    statementExcerpt: 'Services consisting of the acceptance for disposal of waste material.',
    conditions: [desc('\\b(waste|refuse|bin (collections?|lifts?|charges?)|skip hire|recycling|landfill|gate fees?)\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Covers 13(1).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '13', ruleKey: 'vat.reduced_rate_minor_repairs', rateRefs: ['13(2)'],
    name: 'Reduced rate: minor repairs to bicycles, shoes, leather goods, clothing and household linen',
    statementExcerpt: 'Carrying out minor repairs or modifications to bicycles, shoes or leather goods, clothing or '
      + 'household linen.',
    conditions: [
      desc('\\b(repairs?|alterations?|modifications?|mend(ing)?)\\b'),
      desc('\\b(bicycles?|bikes?|shoes?|leather|clothing|clothes|garments?|household linen|trousers|jackets?)\\b'),
    ],
    vatEffect: SCH3,
    interpretationNote: 'Covers 13(2). Whether a repair is "minor" is not on the line; other repairs of movable goods '
      + 'are paragraph 20 (same rate).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '13', ruleKey: 'vat.reduced_rate_hairdressing', rateRefs: ['13(3)'],
    name: 'Reduced rate: hairdressing services',
    statementExcerpt: 'Hairdressing services.',
    conditions: [desc('\\b(hairdress\\w*|haircuts?|barbers?|hair salon|blow-?dry|hair colou?r(ing)?)\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Covers 13(3).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '13A', ruleKey: 'vat.reduced_rate_district_heating', rateRefs: ['13A'],
    name: 'Reduced rate: district heating',
    statementExcerpt: 'The supply of district heating.',
    conditions: [desc('\\bdistrict heat(ing)?\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Straight keyword match.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '13B', ruleKey: 'vat.reduced_rate_horses_greyhounds', rateRefs: ['13B'],
    name: 'Reduced rate: horses (not for food or farming), horse hire, greyhounds, their insemination and horse semen',
    statementExcerpt: 'The supply of live greyhounds.',
    conditions: [desc('^(?!.*\\b(feed|food|nuts)\\b).*\\b(horses?|ponies|pony|foals?|mares?|stallions?|yearlings?|'
      + 'greyhounds?|equine|stud fees?|livery)\\b')],
    exceptions: [{
      condition: 'horses normally intended for the preparation of foodstuffs or for agricultural production',
      effect: 'excluded from 13B(1), (5) and (6): the livestock rate may apply instead',
    }],
    vatEffect: SCH3,
    interpretationNote: 'What a horse is normally intended for is not on the line.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '14', ruleKey: 'vat.reduced_rate_residential_property', rateRefs: ['14'],
    name: 'Reduced rate: supply of residential property',
    statementExcerpt: 'The supply of immovable goods used or to be used for residential purposes, other than immovable '
      + 'goods to which',
    conditions: [desc('\\b(sale of|purchase of|transfer of|deposit on|stage payment)\\b.{0,40}\\b(houses?|dwellings?|'
      + 'homes?|residential)\\b')],
    exceptions: [{
      condition: 'an apartment within paragraph 9A or 9B(2); a supply exempt under the property rules (s.94, Sch.1)',
      effect: 'paragraph 14 does not apply',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Whether the property sale is taxable at all (new or substantially developed) is a s.94 '
      + 'question the line does not settle.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '15', ruleKey: 'vat.reduced_rate_non_residential_property', rateRefs: ['15(1)'],
    name: 'Reduced rate: supply of non-residential property',
    statementExcerpt: 'The supply of immovable goods, other than immovable goods used or to be used for residential purposes.',
    conditions: [desc('\\b(sale of|purchase of|transfer of)\\b.{0,40}\\b(commercial (property|premises|units?|buildings?)|'
      + 'office (buildings?|premises|units?)|warehouses?|industrial units?|retail units?)\\b')],
    exceptions: [{
      condition: 'a supply exempt under the property rules (s.94, Sch.1)',
      effect: 'paragraph 15(1) does not apply',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 15(1). Undeveloped land is not matched.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '15', ruleKey: 'vat.reduced_rate_construction_services', rateRefs: ['15(2)'],
    name: 'Reduced rate: construction and development work on buildings (not dwellings)',
    statementExcerpt: 'Services consisting of the development of immovable goods',
    conditions: [desc('\\b(construction|building works?|fit-?out|refurbishment|renovation|plumbing|electrical '
      + '(works?|installation)|plastering|roofing|carpentry|joinery|tiling|painting and decorating|groundworks|civil works)\\b')],
    exceptions: [
      {
        condition: 'movable goods supplied under the agreement worth more than two-thirds of the total',
        effect: 'the whole supply is a supply of goods at the goods\' own rate',
      },
      {
        condition: 'work on private dwellings (paragraph 9(1)), apartment development (9B(3)), or heat pumps (12A)',
        effect: 'that paragraph applies instead',
      },
      {
        condition: 'a construction service to a principal contractor within Relevant Contracts Tax',
        effect: 'the principal accounts for the VAT by reverse charge',
      },
    ],
    vatEffect: SCH3,
    interpretationNote: 'Covers 15(2).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '15', ruleKey: 'vat.reduced_rate_cleaning_services', rateRefs: ['15(3)'],
    name: 'Reduced rate: routine cleaning of buildings',
    statementExcerpt: 'Services consisting of the routine cleaning of immovable goods',
    conditions: [desc('^(?!.*\\b(supplies|products|chemicals|equipment|materials|detergents?)\\b).*\\b(cleaning|'
      + 'cleaners?|janitorial)\\b')],
    exceptions: [{
      condition: 'cleaning that is not routine (e.g. specialist or one-off), or cleaning of movable goods',
      effect: 'not within 15(3)',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 15(3); private dwellings are 9(2) (same rate).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '16', ruleKey: 'vat.reduced_rate_concrete', rateRefs: ['16'],
    name: 'Reduced rate: ready-to-pour concrete and I.S. EN 771-3 concrete blocks',
    statementExcerpt: 'The supply of concrete that is ready to pour, but excluding the margin scheme supply of the concrete.',
    conditions: [desc('\\bready-?mix(ed)?\\b|\\bready to pour\\b|\\bconcrete blocks?\\b')],
    exceptions: [{
      condition: 'a margin scheme supply; blocks not meeting I.S. EN 771-3',
      effect: 'not within paragraph 16',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 16(1) and (2). The block standard is not on most lines.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '17', ruleKey: 'vat.reduced_rate_electricity', rateRefs: ['17(2)'],
    name: 'Reduced rate: electricity',
    statementExcerpt: 'The supply of electricity, but not the distribution of electricity if the distribution is wholly '
      + 'or mainly in connection with the transmission of communication signals.',
    conditions: [desc('\\b(electricity|kwh|pso levy)\\b')],
    vatEffect: SCH3,
    interpretationNote: 'Covers 17(2).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '17', ruleKey: 'vat.reduced_rate_gas', rateRefs: ['17(3)'],
    name: 'Reduced rate: gas for heating or lighting',
    statementExcerpt: 'The supply of gas of a kind used for domestic or industrial heating or lighting, whether in '
      + 'gaseous or liquid form, but not including',
    conditions: [desc('^(?!.*\\b(vehicle gas|autogas|welding|cutting|lighter|argon|oxygen|acetylene|co2)\\b).*\\b('
      + 'natural gas|gas (supply|bill|usage|units?)|lpg|propane|butane)\\b')],
    exceptions: [{
      condition: 'vehicle gas; LPG used as a propellant; welding or cutting gas; lighter fuel',
      effect: 'excluded from 17(3): the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 17(3). Bottled LPG for a forklift is a propellant, which the line may not say.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '17', ruleKey: 'vat.reduced_rate_heating_oil', rateRefs: ['17(4)'],
    name: 'Reduced rate: heating oil, including marked gas oil',
    statementExcerpt: 'The supply of hydrocarbon oil of a kind used for domestic or industrial heating, excluding gas oil',
    conditions: [desc('^(?!.*\\b(derv|road diesel|auto diesel)\\b).*\\b(kerosene|heating oil|marked gas oil|green diesel)\\b')],
    exceptions: [{
      condition: 'gas oil that is not duly marked (road diesel)',
      effect: 'excluded from 17(4): the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 17(4).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '18', ruleKey: 'vat.reduced_rate_photography', rateRefs: ['18'],
    name: 'Reduced rate: photographic prints, slides and negatives; commissioned photography; film editing; microfilming',
    statementExcerpt: 'The supply to a person of photographic prints',
    conditions: [desc('^(?!.*\\b(photocop\\w*|framed|frames?)\\b).*\\b(photograph\\w*|photo (prints?|shoots?|sessions?)|'
      + 'negatives|microfilm\\w*|video editing|film editing)\\b')],
    exceptions: [{
      condition: 'photocopies; framed prints; photographs not made under an agreement to photograph the subject',
      effect: 'not within paragraph 18',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 18(1)–(6).',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '19', ruleKey: 'vat.reduced_rate_short_term_hire', rateRefs: ['19'],
    name: 'Reduced rate: short-term hire (5 weeks in 12 months) of cars, small passenger vessels, boats, caravans, tents',
    statementExcerpt: 'a vehicle designed and constructed, or adapted, for the conveyance of persons by road',
    conditions: [desc('\\b(car hire|car rental|vehicle hire|rental car|hire car|minibus hire|boat hire|caravan hire|'
      + 'tent hire|trailer tent|mobile home hire|motorhome hire|camper ?van hire)\\b')],
    exceptions: [{
      condition: 'hire that, added to earlier hires to the same person in the previous 12 months, exceeds 5 weeks; '
        + 'hire-purchase type agreements (s.19(1)(c)); goods vans',
      effect: 'not within paragraph 19: the standard rate',
    }],
    vatEffect: SCH3,
    interpretationNote: 'The 5-week test needs the hire history, which the line does not carry.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '21', ruleKey: 'vat.reduced_rate_miscellaneous_services', rateRefs: ['21'],
    name: 'Reduced rate: care of the body, jockeys, veterinary services, tour guides, driving instruction',
    statementExcerpt: 'Services consisting of the care of the human body, including services supplied in the course of '
      + 'a health studio business',
    conditions: [desc('^(?!.*\\b(sunbeds?|tanning beds?)\\b).*\\b(beauty (treatments?|salon)|beautician|massages?|'
      + 'facials?|manicures?|pedicures?|nail (bar|salon|treatments?)|waxing|spa treatments?|health studio|jockeys?|'
      + 'vets?|veterinary|tour guides?|guided tours?|driving (lessons?|instruction|school))\\b')],
    exceptions: [{
      condition: 'medical and other exempt activities (Sch.1 Part 1); hairdressing (13(3)); sunbed services; '
        + 'driving tuition that is exempt education (Sch.1 para 4(3)(c))',
      effect: 'not within paragraph 21',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Covers 21(1)–(5), all at the same rate. The LRC text prints this paragraph without its number.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '22', ruleKey: 'vat.reduced_rate_plants_flowers', rateRefs: ['22'],
    name: 'Reduced rate: live plants, trees, shrubs, bulbs, cut flowers and foliage; miscanthus for bio-fuel',
    statementExcerpt: 'The supply of nursery or garden centre stock consisting of live plants, live trees, live shrubs, '
      + 'bulbs, roots and the like',
    conditions: [desc('^(?!.*\\b(artificial|silk|dried|fake|light|led|halogen|lamps?|hire|machinery|power)\\b).*\\b('
      + 'plants?|trees?|shrubs?|bulbs?|cut flowers|flowers|bouquets?|floral|florist|hedging|miscanthus)\\b')],
    exceptions: [{
      condition: 'seeds, plants and bulbs used for sowing to produce food (Sch.2 para 12(4)); artificial or dried flowers',
      effect: 'not within paragraph 22',
    }],
    vatEffect: SCH3,
    interpretationNote: '"Plant" also means machinery; hire and machinery lines are excluded from the match.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '23', ruleKey: 'vat.reduced_rate_works_of_art', rateRefs: ['23'],
    name: 'Reduced rate: original paintings, drawings, prints and sculptures',
    statementExcerpt: 'a painting, drawing or pastel, or any combination of them, that is produced entirely by hand',
    conditions: [desc('\\b(original (paintings?|artworks?|sculptures?|prints?|lithographs?|engravings?)|oil paintings?|'
      + 'watercolou?rs?|sculptures?|statues?|lithographs?|engravings?)\\b')],
    exceptions: [{
      condition: 'hand-decorated articles; technical or commercial plans and drawings; mass-produced reproductions; '
        + 'the margin scheme supply of a work',
      effect: 'not within paragraph 23',
    }],
    vatEffect: SCH3,
    interpretationNote: 'Whether a work is original and hand-produced is not on the line.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '24', ruleKey: 'vat.reduced_rate_antiques', rateRefs: ['24'],
    name: 'Reduced rate: antique furniture, silver, glass or porcelain over 100 years old',
    statementExcerpt: 'shown to the satisfaction of the Revenue Commissioners to be more than 100 years old',
    conditions: [desc('\\bantiques?\\b')],
    exceptions: [{
      condition: 'a work of art within paragraph 23; the margin scheme supply of an antique; an article not of a '
        + 'kind specified in regulations',
      effect: 'not within paragraph 24',
    }],
    vatEffect: SCH3,
    interpretationNote: 'The age and the kind of article are not on most lines.',
  }),
  rule({
    scheduleNumber: '3', sectionNumber: '25', ruleKey: 'vat.reduced_rate_literary_manuscripts', rateRefs: ['25'],
    name: 'Reduced rate: literary manuscripts certified by the Director of the National Library',
    statementExcerpt: 'The supply of a literary manuscript certified by the Director of the National Library',
    conditions: [desc('\\bliterary manuscripts?\\b')],
    exceptions: [{
      condition: 'a manuscript without the Director\'s certificate',
      effect: 'not within paragraph 25',
    }],
    vatEffect: SCH3,
    interpretationNote: 'The certificate is not on the line.',
  }),
];

/**
 * Which schedule rule decides when a line matches more than one (issue #205).
 * A paragraph that excludes another's items comes after it: solar panels and
 * heat pumps before dwelling and construction work; catering and hot food
 * before zero-rated food; supplements before medicine; greyhound feed before
 * animal feed; electronic periodicals before e-books; periodicals before
 * books; apartments (9B) before 9A and before residential property;
 * minor repairs before general repairs; vessels and aircraft before repairs;
 * agricultural services (tree felling) before plants. The rest are disjoint.
 */
export const SCHEDULE_RULE_PRECEDENCE: string[] = [
  'vat.zero_rate_solar_panels',
  'vat.reduced_rate_heat_pumps',
  'vat.reduced_rate_restaurant_catering',
  'vat.reduced_rate_hot_food',
  'vat.reduced_rate_bakery_products',
  'vat.reduced_rate_food_supplements',
  'vat.reduced_rate_greyhound_feed_live_poultry',
  'vat.reduced_rate_horses_greyhounds',
  'vat.reduced_rate_agricultural_services',
  'vat.zero_rate_food_and_drink',
  'vat.zero_rate_oral_medicine',
  'vat.zero_rate_medical_appliances',
  'vat.zero_rate_fertiliser_feed_seed',
  'vat.reduced_rate_electronic_periodicals',
  'vat.zero_rate_electronic_books',
  'vat.reduced_rate_printed_periodicals',
  'vat.reduced_rate_brochures_catalogues_maps',
  'vat.zero_rate_printed_books',
  'vat.zero_rate_childrens_clothing_footwear',
  'vat.reduced_rate_child_car_seats',
  'vat.reduced_rate_apartment_development',
  'vat.reduced_rate_social_housing_apartment',
  'vat.reduced_rate_residential_property',
  'vat.reduced_rate_non_residential_property',
  'vat.zero_rate_vessels_aircraft',
  'vat.reduced_rate_minor_repairs',
  'vat.reduced_rate_repair_movable_goods',
  'vat.reduced_rate_dwelling_services',
  'vat.reduced_rate_construction_services',
  'vat.reduced_rate_cleaning_services',
  'vat.zero_rate_import_transport',
  'vat.zero_rate_export_transport',
  'vat.zero_rate_s56_authorised_person',
  'vat.zero_rate_menstrual_products',
  'vat.zero_rate_irish_lights_rnli',
  'vat.reduced_rate_non_oral_contraceptives',
  'vat.reduced_rate_cinema_admission',
  'vat.reduced_rate_admissions',
  'vat.reduced_rate_holiday_accommodation',
  'vat.reduced_rate_sporting_facilities',
  'vat.reduced_rate_waste_disposal',
  'vat.reduced_rate_hairdressing',
  'vat.reduced_rate_district_heating',
  'vat.reduced_rate_concrete',
  'vat.reduced_rate_solid_fuel',
  'vat.reduced_rate_electricity',
  'vat.reduced_rate_gas',
  'vat.reduced_rate_heating_oil',
  'vat.reduced_rate_photography',
  'vat.reduced_rate_short_term_hire',
  'vat.reduced_rate_miscellaneous_services',
  'vat.reduced_rate_plants_flowers',
  'vat.reduced_rate_works_of_art',
  'vat.reduced_rate_antiques',
  'vat.reduced_rate_literary_manuscripts',
];

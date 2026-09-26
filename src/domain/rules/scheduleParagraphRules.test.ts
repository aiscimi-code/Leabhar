import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { evaluateAllConditions } from './conditionEval';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { SCHEDULE_RULE_PRECEDENCE } from './vatcaScheduleParagraphRules';
import { scheduleThreeRate, SECOND_REDUCED_WINDOWS, withinReference } from './scheduleRates';
import { suggestFromFacts, RULE_TREATMENT_BINDINGS, type SuggestionFacts } from './vatSuggestion';
import { checkLineRate } from './lineRateCheck';
import type { AppDatabase } from '@/db';

/**
 * Issue #205 part 3: a rule for every Schedule 2 and 3 paragraph, and the
 * rate each Schedule 3 paragraph bears on a date. Deterministic: the rate is
 * read from the s.46 windows, never guessed.
 */

describe('scheduleThreeRate: the rate s.46 gives a Schedule 3 paragraph on a date', () => {
  const rate = (ref: string, d: string) => scheduleThreeRate(ref, d).code;

  it('is 13.5% for an unlisted paragraph from 2025, and undetermined before (the earlier (ca) list is not in the repo)', () => {
    expect(rate('17(1)', '2025-01-01')).toBe('IE_RED');
    expect(rate('17(1)', '2024-12-31')).toBeNull();
    expect(scheduleThreeRate('17(1)', '2024-12-31').gap).toMatch(/7\(a\), 7A and 12/);
  });

  it('(ca): 7(a), 7A, 12 and 12A are 9% from 1 January 2025', () => {
    for (const ref of ['7(a)', '7A', '12', '12(1A)', '12A']) {
      expect(rate(ref, '2025-01-01')).toBe('IE_SECOND_RED');
      expect(rate(ref, '2024-12-31')).toBeNull();
    }
  });

  it('(cb) 2020–2023: hospitality, printed matter, admissions and hairdressing at 9% from 1 Nov 2020 to 31 Aug 2023', () => {
    for (const ref of ['3(1)', '3(3)', '7(b)', '7(e)', '8(1)', '8(4)', '11', '13(3)']) {
      expect(rate(ref, '2020-10-31')).toBeNull();
      expect(rate(ref, '2020-11-01')).toBe('IE_SECOND_RED');
      expect(rate(ref, '2023-08-31')).toBe('IE_SECOND_RED');
    }
    // Not listed in (cb): undetermined before 2025 like any other paragraph.
    expect(rate('13(2)', '2021-06-01')).toBeNull();
    // After the window, 13.5% from 2025.
    expect(rate('8(1)', '2025-06-01')).toBe('IE_RED');
    expect(rate('11', '2026-09-01')).toBe('IE_RED');
  });

  it('Finance Act 2025 s.71: 3(1), 3(3) and 13(3) at 9% from 1 July 2026, with no end date', () => {
    for (const ref of ['3(1)', '3(3)', '13(3)']) {
      expect(rate(ref, '2026-06-30')).toBe('IE_RED');
      expect(rate(ref, '2026-07-01')).toBe('IE_SECOND_RED');
      expect(rate(ref, '2035-01-01')).toBe('IE_SECOND_RED');
    }
    expect(scheduleThreeRate('3(1)', '2026-07-01').provision).toMatch(/Finance Act 2025 s\.71/);
    // Not 3(5) bakery products, nor accommodation (11).
    expect(rate('3(5)', '2026-07-01')).toBe('IE_RED');
    expect(rate('11', '2026-07-01')).toBe('IE_RED');
  });

  it('(caa): electricity and gas at 9% from 1 May 2022 to 31 December 2030, heating oil not', () => {
    for (const ref of ['17(2)', '17(3)']) {
      expect(rate(ref, '2022-04-30')).toBeNull();
      expect(rate(ref, '2022-05-01')).toBe('IE_SECOND_RED');
      expect(rate(ref, '2030-12-31')).toBe('IE_SECOND_RED');
      expect(rate(ref, '2031-01-01')).toBe('IE_RED');
    }
    expect(rate('17(4)', '2026-01-01')).toBe('IE_RED');
  });

  it('(cab) and (cac): apartments', () => {
    expect(rate('9A', '2025-10-07')).toBe('IE_RED');
    expect(rate('9A', '2025-10-08')).toBe('IE_SECOND_RED');
    expect(rate('9A', '2025-11-25')).toBe('IE_SECOND_RED');
    expect(rate('9A', '2025-11-26')).toBe('IE_RED');
    expect(rate('9B(2)', '2025-11-26')).toBe('IE_SECOND_RED');
    expect(rate('9B(3)', '2030-12-31')).toBe('IE_SECOND_RED');
    expect(rate('9B(2)', '2031-01-01')).toBe('IE_RED');
  });

  it('matches a sub-paragraph within a listed paragraph, but not a lettered sibling', () => {
    expect(withinReference('8(2)', '8')).toBe(true);
    expect(withinReference('12A', '12')).toBe(false);
    expect(withinReference('13(3)', '13(3)')).toBe(true);
    expect(withinReference('13(2)', '13(3)')).toBe(false);
  });

  it('every Schedule 3 rule groups only sub-paragraphs that bear the same rate on every window boundary', () => {
    const dates = [...new Set(SECOND_REDUCED_WINDOWS.flatMap((w) => [w.from, w.to].filter((d): d is string => !!d)))];
    const probe = [...dates, '2019-01-01', '2024-12-31', '2025-01-01', '2031-01-01'];
    for (const r of VATCA_SCHEDULE_CURATED_RULES.filter((x) => x.scheduleNumber === '3')) {
      expect(r.rateRefs?.length, `${r.ruleKey} names its sub-paragraphs`).toBeGreaterThan(0);
      for (const d of probe) {
        const codes = new Set(r.rateRefs!.map((ref) => scheduleThreeRate(ref, d).code));
        expect(codes.size, `${r.ruleKey} on ${d}`).toBe(1);
      }
    }
  });
});

describe('schedule paragraph rules: what each matches, and each exclusion', () => {
  const byKey = new Map(VATCA_SCHEDULE_CURATED_RULES.map((r) => [r.ruleKey, r]));
  const matches = (key: string, description: string) =>
    evaluateAllConditions(byKey.get(key)!.conditions, { description }).allPassed;

  const cases: Array<[string, string[], string[]]> = [
    ['vat.zero_rate_import_transport', ['Freight charges on import from China'], ['Freight to Cork', 'Import duty']],
    ['vat.zero_rate_export_transport', ['Haulage for export consignment'], ['Haulage Dublin to Cork']],
    ['vat.zero_rate_vessels_aircraft', ['Engine repair to fishing trawler', 'Aircraft maintenance'], ['Van repair']],
    ['vat.zero_rate_s56_authorised_person', ['Zero-rated under section 56, authorisation 1234'], ['Standard supply']],
    ['vat.zero_rate_food_and_drink', ['Groceries', 'Milk and bread'], ['Wine and cheese', 'Chocolate biscuits', 'Hot chicken meal', 'Crisps']],
    ['vat.zero_rate_electronic_books', ['E-book: Tax Guide 2026', 'Digital audiobook'], ['Printed book']],
    ['vat.zero_rate_oral_medicine', ['Paracetamol tablets'], ['Flea tablets for dogs', 'Antiseptic cream']],
    ['vat.zero_rate_medical_appliances', ['Wheelchair', 'Hearing aid batteries'], ['Contact lenses', 'Spectacles']],
    ['vat.zero_rate_fertiliser_feed_seed', ['Fertiliser 50kg', 'Calf nuts'], ['Dog feed', 'Greyhound feeding stuff']],
    ['vat.zero_rate_menstrual_products', ['Tampons', 'Menstrual cup'], ['Toiletries']],
    ['vat.zero_rate_irish_lights_rnli', ['RNLI services'], ['Lighthouse tour']],
    ['vat.zero_rate_solar_panels', ['Supply and install solar PV panels'], ['Solar garden lights']],
    ['vat.reduced_rate_restaurant_catering', ['Catering for staff event', 'Business lunch'], ['Dinner with wine']],
    ['vat.reduced_rate_hot_food', ['Hot food counter', 'Takeaway'], ['Cold sandwich']],
    ['vat.reduced_rate_bakery_products', ['Cakes and scones'], ['Chocolate biscuits']],
    ['vat.reduced_rate_food_supplements', ['Vitamin D supplements'], ['Horse vitamins']],
    ['vat.reduced_rate_greyhound_feed_live_poultry', ['Greyhound feed 20kg', 'Live hens'], ['Chicken fillets']],
    ['vat.reduced_rate_non_oral_contraceptives', ['Condoms'], ['Contraceptive pill advice']],
    ['vat.reduced_rate_child_car_seats', ['Child car seat', 'Booster seat'], ['Car seat covers']],
    ['vat.reduced_rate_printed_periodicals', ['Trade magazine'], ['Digital magazine', 'Magazine advertisement']],
    ['vat.reduced_rate_brochures_catalogues_maps', ['Product catalogues', 'Ordnance maps'], ['Promotional leaflets', 'Digital brochure']],
    ['vat.reduced_rate_electronic_periodicals', ['Online magazine subscription', 'E-catalogue'], ['Printed catalogue']],
    ['vat.reduced_rate_admissions', ['Theatre tickets', 'Museum admission'], ['Theatre hire', 'Dance tickets']],
    ['vat.reduced_rate_social_housing_apartment', ['Sale of apartment 4'], ['Sale of house']],
    ['vat.reduced_rate_apartment_development', ['Construction of apartment block'], ['Office block']],
    ['vat.reduced_rate_agricultural_services', ['Silage cutting and baling', 'Tree felling'], ['Farm accountancy baling review', 'Horse insemination']],
    ['vat.reduced_rate_holiday_accommodation', ['Hotel accommodation 2 nights'], ['Office rent']],
    ['vat.reduced_rate_sporting_facilities', ['Green fees', 'Gym access'], ['Sports drinks']],
    ['vat.reduced_rate_heat_pumps', ['Air to water heat pump installed'], ['Gas boiler']],
    ['vat.reduced_rate_waste_disposal', ['Bin collection', 'Skip hire'], ['Plumbing']],
    ['vat.reduced_rate_minor_repairs', ['Shoe repairs', 'Clothing alterations'], ['Laptop repair']],
    ['vat.reduced_rate_hairdressing', ['Haircut', 'Barber'], ['Hair products']],
    ['vat.reduced_rate_district_heating', ['District heating charge'], ['Heating oil']],
    ['vat.reduced_rate_horses_greyhounds', ['Yearling filly sale', 'Livery fees'], ['Horse feed']],
    ['vat.reduced_rate_residential_property', ['Sale of house at 3 Main St'], ['House cleaning']],
    ['vat.reduced_rate_non_residential_property', ['Sale of commercial premises'], ['Rent of commercial premises']],
    ['vat.reduced_rate_construction_services', ['Office fit-out', 'Roofing works'], ['Legal fees']],
    ['vat.reduced_rate_cleaning_services', ['Office cleaning'], ['Cleaning supplies']],
    ['vat.reduced_rate_concrete', ['Ready-mix concrete 6m3', 'Concrete blocks'], ['Precast concrete lintels']],
    ['vat.reduced_rate_electricity', ['Electricity 1,200 kWh'], ['Electrical works']],
    ['vat.reduced_rate_gas', ['Natural gas supply', 'LPG cylinder'], ['Welding gas', 'Autogas']],
    ['vat.reduced_rate_heating_oil', ['Kerosene 900L', 'Green diesel'], ['Road diesel']],
    ['vat.reduced_rate_photography', ['Wedding photography', 'Photo prints'], ['Photocopying', 'Framed photographs']],
    ['vat.reduced_rate_short_term_hire', ['Car hire 3 days'], ['Van hire']],
    ['vat.reduced_rate_miscellaneous_services', ['Veterinary call-out', 'Driving lessons', 'Manicure'], ['Sunbed and manicure']],
    ['vat.reduced_rate_plants_flowers', ['Cut flowers for reception', 'Hedging plants'], ['Plant hire', 'LED bulbs', 'Artificial flowers']],
    ['vat.reduced_rate_works_of_art', ['Original oil painting'], ['Poster print']],
    ['vat.reduced_rate_antiques', ['Antique oak table'], ['Oak table']],
    ['vat.reduced_rate_literary_manuscripts', ['Literary manuscript'], ['Manuscript paper']],
  ];

  it('covers every rule added in part 3', () => {
    const tested = new Set(cases.map((c) => c[0]));
    const part3 = [...byKey.values()].filter((r) => SCHEDULE_RULE_PRECEDENCE.includes(r.ruleKey)
      && !['vat.zero_rate_printed_books', 'vat.zero_rate_childrens_clothing_footwear', 'vat.reduced_rate_dwelling_services',
        'vat.reduced_rate_solid_fuel', 'vat.reduced_rate_repair_movable_goods', 'vat.reduced_rate_cinema_admission'].includes(r.ruleKey));
    expect(part3.map((r) => r.ruleKey).filter((k) => !tested.has(k))).toEqual([]);
  });

  for (const [key, yes, no] of cases) {
    it(`${key}`, () => {
      expect(byKey.has(key), key).toBe(true);
      for (const d of yes) expect(matches(key, d), `"${d}" should match`).toBe(true);
      for (const d of no) expect(matches(key, d), `"${d}" should not match`).toBe(false);
    });
  }
});

describe('the rate a Schedule 3 line is checked against depends on its date', () => {
  let db: AppDatabase;
  let companyId: string;
  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Rates Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const facts = (description: string, transactionDate: string): SuggestionFacts => ({
    transactionDate, amountMinor: 10_000, currency: 'EUR', description, vatRegistered: true,
    direction: 'sale', counterpartyCountry: 'IE',
  });
  const checkOn = (description: string, date: string, charged: number) => {
    const statutory = suggestFromFacts(db, { companyId, subjectId: 'line', facts: facts(description, date), factSources: {}, bookedTreatmentId: null });
    return checkLineRate(db, { companyId, onDate: date, direction: 'sale', statutory, chargedRateBasisPoints: charged });
  };

  it('hairdressing: 13.5% consistent in June 2026, 9% consistent from July 2026 (Finance Act 2025 s.71)', () => {
    expect(checkOn('Haircut and blow-dry', '2026-06-15', 1350)).toMatchObject({
      outcome: 'consistent', expected: { treatmentCode: 'IE_RED', ruleKey: 'vat.reduced_rate_hairdressing' },
    });
    expect(checkOn('Haircut and blow-dry', '2026-07-15', 1350).outcome).toBe('inconsistent');
    expect(checkOn('Haircut and blow-dry', '2026-07-15', 900)).toMatchObject({
      outcome: 'consistent', expected: { treatmentCode: 'IE_SECOND_RED' },
    });
  });

  it('electricity at 9% is consistent to 2030 under (caa); 13.5% is flagged', () => {
    expect(checkOn('Electricity 1,200 kWh', '2026-03-01', 900).outcome).toBe('consistent');
    expect(checkOn('Electricity 1,200 kWh', '2026-03-01', 1350).outcome).toBe('inconsistent');
  });

  it('a line dated before its paragraph\'s current wording took effect is undetermined (para 15, amended 2025)', () => {
    expect(checkOn('Office cleaning', '2024-06-01', 1350).outcome).toBe('undetermined');
  });

  it('a Schedule 3 line dated 2024 is undetermined and says why', () => {
    // Para 19 is unamended since 2010, so its rule is in force; the rate is what the sources cannot give.
    const r = checkOn('Car hire 3 days', '2024-06-01', 1350);
    expect(r.outcome).toBe('undetermined');
    expect(r.message).toMatch(/cannot be confirmed/);
  });

  it('a zero-rated food line is consistent at 0%, and wine is not zero-rated', () => {
    expect(checkOn('Groceries: milk and bread', '2026-03-01', 0)).toMatchObject({
      outcome: 'consistent', expected: { ruleKey: 'vat.zero_rate_food_and_drink' },
    });
    expect(checkOn('Wine and cheese hamper', '2026-03-01', 0).outcome).not.toBe('consistent');
  });

  it('solar panels on a dwelling beat the dwelling-services rate (Sch.3 para 9(1) excludes them)', () => {
    const statutory = suggestFromFacts(db, { companyId, subjectId: 'line', facts: facts('Supply and install solar PV panels, private dwelling renovation', '2026-03-01'), factSources: {}, bookedTreatmentId: null });
    expect(statutory.decidingRule?.ruleKey).toBe('vat.zero_rate_solar_panels');
  });

  it('every schedule rule is bound, in precedence order, exactly once', () => {
    const scheduleBinding = RULE_TREATMENT_BINDINGS.find((b) => b.ruleKeys.includes('vat.zero_rate_solar_panels'))!;
    const keys = VATCA_SCHEDULE_CURATED_RULES.map((r) => r.ruleKey)
      .filter((k) => !['vat.zero_rate_intra_community_goods', 'vat.zero_rate_export_outside_community'].includes(k));
    expect([...scheduleBinding.ruleKeys].sort()).toEqual([...keys].sort());
    expect(new Set(SCHEDULE_RULE_PRECEDENCE).size).toBe(SCHEDULE_RULE_PRECEDENCE.length);
  });
});

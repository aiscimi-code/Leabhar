/**
 * Later versions of rules whose first version was curated from the Act as
 * enacted, now re-curated from the LRC-revised text with tighter conditions.
 *
 * A released version never changes (ADR-0021 §3): its dates, quote,
 * conditions and effects are part of the released-versions hash. So a
 * tightened rule is a NEW version of the same key, and the released version
 * before it is disabled (`active = false, enabled = false`), never closed or
 * edited — the same treatment `deriveSi156CapacityExclusionRule` gives the
 * TDM version before reg. 5 (#709). Disabling is what the graph check reads:
 * two open-ended spans of one key would overlap, and a disabled row keeps the
 * history queryable without changing a byte the release hashed.
 *
 * The derive follows `deriveVatScopeRules` (issue #199's guard included: a
 * rule whose quote is not verbatim in its provision is refused, never
 * inserted) and dates each version from the LRC footnotes on its quoted words
 * (issue #206), so a version's window is the words' own, never the revised
 * page's date (AGENTS.md: a revised text does not date its own figures).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { taxHeadsFor } from './taxHeads';
import { preferredSourceId } from './catalogueSupersession';
import { lrcAnnotationsForSource } from './vatcaScheduleIngestion';
import { containsIgnoringLayout, quotedTextWindow } from './lrcAnnotations';
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

const VATCA_COMMENCEMENT = '2010-11-01';

/** A tightened version of a released rule: `CuratedVatcaRule`'s shape, plus the fields the derive reads. */
export interface TightenedRule {
  /** Source citation, as ingested (the revised section's own source). */
  citation: string;
  /** Section number, matched against `irish_act_provisions.section_number`. */
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  /** The topic the released version carries; the lookup routes on it, so it must not change. */
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  crossReferences: string[];
  vatEffect: string;
  accountingEffect: string | null;
  reportingEffect: string | null;
  /** The version's own start date when the LRC footnotes date its words no later. */
  effectiveFrom: string;
  interpretationNote: string;
}

/**
 * The s.12 reverse charge, re-curated from the revised s.12. The conditions
 * stay the three a line can evaluate; every case the line cannot — the
 * s.65(2) recipient, the s.34(a)(ii)-(iii) fallbacks, the s.34 excepted
 * paragraphs, s.12(2) public bodies and the s.33(2) exclusion, and the
 * s.12(3)-(6) limited-accountability and election regimes — is an exception
 * the lookup reports by name rather than a guess.
 */
const S12_REVERSE_CHARGE: TightenedRule = {
  citation: '2010 Act 31 s.12',
  sectionNumber: '12',
  ruleKey: 'vat.reverse_charge_services_from_abroad',
  ruleType: 'other',
  topic: 'vat',
  name: 'Reverse charge: services received from a supplier established outside the State (revised s.12)',
  // Verbatim from the revised s.12 (catalogue/vatca-2010-revised/s012.json):
  // both limbs of s.12(1), the s.65(2) recipient included.
  statementExcerpt: '( a ) a taxable person who carries on a business in the State, or a person to whom '
    + 'a registration number has been assigned in accordance with section 65 (2) , receives a service from '
    + 'a supplier established outside the State, and ( b ) the place of supply of the service (as determined '
    + 'in accordance with section 34 (a) ) is the State, then the person is accountable for, and liable to '
    + 'pay, the tax chargeable in the State as if he or she had supplied that service for consideration in '
    + 'the course or furtherance of business.',
  conditions: [
    // s.12(1)(a): "receives a service".
    { field: 'supplyType', operator: 'equals', value: 'services' },
    // s.12(1)(a): "a supplier established outside the State" — the caller's
    // own determination (EU Reg 282/2011 arts.10-11), as transactionLookup
    // resolves it; a country code alone is never it (issue #207).
    { field: 'supplierEstablishedOutsideStateResolved', operator: 'equals', value: 'true' },
    // s.12(1)(a): "a taxable person who carries on a business in the State" —
    // necessary but not sufficient; the s.65(2) recipient is an exception below.
    { field: 'vatRegistered', operator: 'equals', value: 'true' },
  ],
  exceptions: [
    {
      condition: 'the service is supplied to a fixed establishment of the recipient located outside the '
        + 'State, or the recipient has no place of business or fixed establishment and the permanent address '
        + 'or usual residence governs (VATCA 2010 s.34(a)(ii)-(iii))',
      effect: 'the place of supply is not the State, so s.12(1)(b) is not met and this rule does not apply; '
        + 'the fixed-establishment test is multi-factor (EU Reg 282/2011 arts.10-11) and no line carries it '
        + '— confirm the establishment before self-accounting',
    },
    {
      condition: 'the service is of a kind in s.34(c), (d), (g), (i), (j) or (k) (connected with immovable '
        + 'goods, passenger transport, admission to events, restaurant or catering services, restaurant or '
        + 'catering services on board a ship, aircraft or train, or short-term hiring out of a means of '
        + 'transport)',
      effect: 's.34(a) excepts those supplies from its own general rule, so s.12(1)(b) is not determined by '
        + 'it; the excepted paragraph governs the place of supply and has its own rule '
        + '(vat.place_of_supply_immovable_goods and its siblings) — this rule defers and the line is reviewed',
    },
    {
      condition: 'the recipient is not a taxable person carrying on a business in the State but a person to '
        + 'whom a registration number was assigned in accordance with s.65(2) (s.12(1)(a))',
      effect: 's.12(1) applies to such a person too, but no recorded fact states a s.65(2) number, so the '
        + 'case cannot be evaluated from the line — routed to review under that name, never treated as out '
        + 'of scope',
    },
    {
      condition: 'a taxable person carrying on a business in the State, or a public body, receives a service '
        + 'other than one of a kind referred to in s.33(2)(b), (ba) or (c) from a supplier not established in '
        + 'the State, with the place of supply the State under s.34(c) (s.12(2), as amended by Finance Act 2018 '
        + '(30/2018) s.62 and sch. 2 para. 2, LRC F31, in effect 19 December 2018)',
      effect: 's.12(2), not s.12(1), makes the recipient accountable; neither the s.34(c) place-of-supply '
        + 'category, the s.33(2)(b), (ba), (c) exclusion nor public-body status is on the line — routed to '
        + 'review under that name',
    },
    {
      condition: 'the recipient is an accountable person by virtue of this section only, being a person '
        + 'referred to in s.6(1)(a) or (b) (s.12(3)-(4))',
      effect: 'accountable only for intra-Community acquisitions of goods and the services received '
        + '(s.12(3)), unless the person elected under s.12(4) that s.12(3) not apply; the election is not '
        + 'recorded — routed to review (s.12(3)-(4) limited accountability)',
    },
    {
      condition: 'the recipient is a person referred to in s.17(2) accountable by virtue of this section '
        + '(s.12(5)-(6))',
      effect: 'accountable only for intra-Community acquisitions of goods, racehorse training services '
        + 'supplied and the services received (s.12(5)), subject to the s.12(6) election, which is not '
        + 'recorded — routed to review (s.12(5)-(6) limited accountability)',
    },
  ],
  crossReferences: [
    'VATCA 2010 s.34(a)',
    'VATCA 2010 s.65(2)',
    'VATCA 2010 s.33(2)',
    'VATCA 2010 s.12(2)-(6)',
    'Finance Act 2018 s.62',
    'EU Reg 282/2011 arts.10-11',
  ],
  vatEffect: 'The RECIPIENT (not the overseas supplier) is accountable for, and liable to pay, '
    + 'Irish VAT on the supply, as if the recipient had supplied it themself (the reverse charge). '
    + 'The recipient self-accounts for output VAT on the reverse charge and may recover it as '
    + 'input VAT in the same period, subject to the deductibility rules '
    + '(vat.input_deduction_taxable_use and the s.60(2)(a) blocks) — usually a net-nil cash '
    + 'effect where the expense is fully deductible.',
  accountingEffect: null,
  reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT,
  interpretationNote: 'Version 2, curated from the revised s.12 (catalogue/vatca-2010-revised/s012.json); '
    + 'the released version 1, quoted from the Act as enacted, is disabled, never changed. '
    + 's.12(1)(a)\'s "a taxable person who carries on a business in the State" maps onto '
    + '`vatRegistered = true`, necessary but not sufficient: the paragraph also covers a person '
    + 'holding a registration number assigned under s.65(2), for which no TransactionContext field '
    + 'exists — routed to review by name. s.12(1)(b) is an explicit precondition: the rule applies '
    + 'only where s.34(a) determines the place of supply of the service to be the State, declared as a '
    + '`uses_value` link to vat.place_of_supply_b2b_general; the fixed-establishment and residence '
    + 'fallbacks (s.34(a)(ii)-(iii)) and the excepted paragraphs (s.34(c), (d), (g), (i), (j), (k)) are '
    + 'routed to review with named reasons, since no line carries the multi-factor establishment test '
    + '(EU Reg 282/2011 arts.10-11). s.12(2) (a taxable person or a public body receiving a service '
    + 'other than one of s.33(2)(b), (ba) or (c), the place of supply the State under s.34(c), as amended '
    + 'by Finance Act 2018 s.62 and sch. 2 para. 2, LRC F31, 19 December 2018) and the '
    + 'limited-accountability and election regimes of s.12(3)-(6) are likewise routed to review with '
    + 'named reasons: none is evaluable from transaction facts. requiresGuidance stays set: this '
    + 'version records no approval.',
};

/**
 * The s.34 general B2B place-of-supply rule, re-curated from the revised
 * s.34. The quote now carries all three subparagraphs of s.34(a) — the
 * business establishment, the fixed-establishment fallback and the
 * permanent-address/usual-residence fallback — and every excepted paragraph
 * is a named exception pointing at its own rule (or, for (j), at review),
 * the same keys the reverse-charge suggestion lets decide before s.12.
 */
const S34_PLACE_OF_SUPPLY_B2B: TightenedRule = {
  citation: '2010 Act 31 s.34',
  sectionNumber: '34',
  ruleKey: 'vat.place_of_supply_b2b_general',
  ruleType: 'other',
  topic: 'vat',
  name: 'Place of supply of services to a taxable person (general B2B rule, revised s.34)',
  // Verbatim from the revised s.34 (catalogue/vatca-2010-revised/s034.json):
  // the whole of paragraph (a), its fallback subparagraphs included.
  statementExcerpt: "( a ) except as provided by paragraphs (c) , (d) , (g) , (i) , (j) and "
    + "(k) , the place of supply of services to a taxable person acting as such is— "
    + "(i) subject to subparagraph (ii) , the place where the person's business is "
    + "established, (ii) if the services are supplied to a fixed establishment of the "
    + "person located in a place other than the place where the business is "
    + "established, the place where the fixed establishment is located, (iii) if there "
    + "is no such place of business or fixed establishment, the place where the "
    + "permanent address or usual place of residence of the taxable person who "
    + "receives the services is located;",
  conditions: [
    // s.34(a): a service supplied to a taxable person acting as such. The
    // rule is the general rule either side of the transaction reads; the
    // recipient-side facts that pick between its subparagraphs are the
    // confirmed-establishment fields the sale-side sibling rules carry
    // (vatPlaceOfSupplyCuration.ts), and the fallbacks are exceptions below.
    { field: 'supplyType', operator: 'equals', value: 'services' },
  ],
  exceptions: [
    {
      condition: 'the supply is connected with immovable goods, or is the grant of a right to '
        + 'use those goods (VATCA 2010 s.34(c))',
      effect: 'the place of supply is where those goods are located; the paragraph has its own '
        + 'rule (vat.place_of_supply_immovable_goods), and s.34(a) does not apply by its own '
        + 'opening words',
    },
    {
      condition: 'the supply is the provision of passenger transport (VATCA 2010 s.34(d))',
      effect: 'the place of supply is the place or places where the transport takes place '
        + '(vat.place_of_supply_passenger_transport)',
    },
    {
      condition: 'the supply, and any ancillary services, is in respect of or related to '
        + 'admission to a cultural, artistic, sporting, scientific, educational, entertainment '
        + 'or similar event, such as a fair or exhibition, including the supply of tickets '
        + 'granting access to such an event (VATCA 2010 s.34(g))',
      effect: 'the place of supply is where that event actually takes place '
        + '(vat.place_of_supply_event_admission), except where attendance at the event is '
        + 'virtual (inserted 1 January 2025 by S.I. 725/2024 reg. 4, LRC F79), which that rule '
        + 'carries as its own exception',
    },
    {
      condition: 'the supply is the provision of restaurant or catering services other than '
        + 'those physically carried out on board a ship, aircraft or train (VATCA 2010 '
        + 's.34(i))',
      effect: 'the place of supply is where those services are physically carried out '
        + '(vat.place_of_supply_restaurant_catering)',
    },
    {
      condition: 'the supply is the provision of restaurant or catering services physically '
        + 'carried out on board a ship, aircraft or train during a section of a passenger '
        + 'transport operation undertaken within the Community whose first scheduled point '
        + 'of departure within the Community is in the State (VATCA 2010 s.34(j))',
      effect: 'the place of supply is the State; no rule models this paragraph — routed to '
        + 'review under that name rather than guessed',
    },
    {
      condition: 'the supply consists of a short-term hiring out of a means of transport '
        + '(VATCA 2010 s.34(k))',
      effect: 'the place of supply is where the means of transport is actually placed at the '
        + 'disposal of the customer (vat.place_of_supply_short_term_hire)',
    },
    {
      condition: 'the services are supplied to a fixed establishment of the recipient located '
        + 'in a place other than the place where the business is established (VATCA 2010 '
        + 's.34(a)(ii))',
      effect: 'the place of supply is where that fixed establishment is located, not where '
        + 'the business is established; the fixed-establishment test is multi-factor (EU Reg '
        + '282/2011 arts.10-11) and no line carries it — routed to review with that name, '
        + 'never assumed away',
    },
    {
      condition: 'the recipient has no place of business or fixed establishment (VATCA 2010 '
        + 's.34(a)(iii))',
      effect: 'the place of supply is where the recipient\'s permanent address or usual place '
        + 'of residence is located; that address is not on the line — routed to review with '
        + 'that name',
    },
  ],
  crossReferences: [
    'VATCA 2010 s.34(c), (d), (g), (i), (j), (k)',
    'VATCA 2010 s.12(1)(b)',
    'EU Reg 282/2011 arts.10-11',
  ],
  vatEffect: 'Unless one of the excepted paragraphs applies, the place of supply of a service '
    + 'to a taxable person acting as such is where that person\'s business is established '
    + '(s.34(a)(i)); supplied to a fixed establishment of the recipient located elsewhere, '
    + 'where that fixed establishment is (s.34(a)(ii)); with no place of business or fixed '
    + 'establishment, where the recipient\'s permanent address or usual place of residence '
    + 'is (s.34(a)(iii)). For a recipient established in the State, the place of supply is '
    + 'the State — the result s.12(1)(b) needs for the reverse charge.',
  accountingEffect: null,
  reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT,
  interpretationNote: 'Version 2, curated from the revised s.34 '
    + '(catalogue/vatca-2010-revised/s034.json); the released version 1, quoted from the Act '
    + 'as enacted, is disabled, never changed. The condition stays `supplyType = services`: '
    + 'the rule states the general rule for any service to a taxable person acting as such, '
    + 'and the recipient-side facts that pick between s.34(a)\'s subparagraphs are the '
    + 'confirmed-establishment fields the sale-side sibling rules carry '
    + '(vat.place_of_supply_services_to_business_abroad, vatPlaceOfSupplyCuration.ts); the '
    + 'fixed-establishment and residence fallbacks ((a)(ii)-(iii)) are named exceptions '
    + 'because the multi-factor test (EU Reg 282/2011 arts.10-11) is not on a line. Each '
    + 'excepted paragraph has its own rule — the same keys the reverse-charge suggestion '
    + 'lets decide before s.12 (crossBorderCuration.ts) — except (j) (restaurant or '
    + 'catering on board a ship, aircraft or train within the Community), which no rule '
    + 'models and which is routed to review by name. requiresGuidance stays set: this '
    + 'version records no approval.',
};

/**
 * The s.59 input deduction, re-curated from the revised s.59. The quote now
 * carries the subsection's opening words and the three bases a line evidences
 * directly - charged by invoice (a), imports (b), intra-Community
 * acquisitions (c); the remaining bases, the s.60 limits, the s.61
 * apportionment and the s.62 qualifying-vehicle reduction are named
 * exceptions, and the use test is read from the line's business-use share,
 * not from a person's confirmation.
 */
const S59_INPUT_DEDUCTION: TightenedRule = {
  citation: '2010 Act 31 s.59',
  sectionNumber: '59',
  ruleKey: 'vat.input_deduction_taxable_use',
  ruleType: 'other',
  topic: 'vat_scope',
  name: 'Input VAT deductible for taxable supplies or qualifying activities, on each basis s.59(2) names (revised s.59)',
  // Verbatim from the revised s.59 (catalogue/vatca-2010-revised/s059.json):
  // the opening words of s.59(2) and bases (a), (b) and (c).
  statementExcerpt: 'Subject to subsection (3) , in computing the amount of tax payable by an '
    + 'accountable person in respect of a taxable period, that person may, in so far as the '
    + 'goods and services are used by him or her for the purposes of his or her taxable '
    + 'supplies or of any of the qualifying activities, deduct— ( a ) the tax charged to him '
    + 'or her during the period by other accountable persons by means of invoices, prepared '
    + 'in the manner prescribed by regulations, in respect of supplies of goods or services '
    + 'to him or her, ( b ) in respect of goods imported by him or her in the period, the '
    + 'tax paid by him or her or deferred as established from the relevant customs documents '
    + 'kept by him or her in accordance with section 84 (3) , ( c ) subject to such '
    + 'conditions (if any) as may be specified in regulations, the tax chargeable during '
    + 'the period, being tax for which he or she is liable in respect of intra-Community '
    + 'acquisitions of goods,',
  conditions: [
    // s.59(2): "an accountable person" computing the tax payable - the book's
    // own purchase line.
    { field: 'direction', operator: 'equals', value: 'purchase' },
    { field: 'vatRegistered', operator: 'equals', value: 'true' },
    // s.59(2)(a): "by means of invoices, prepared in the manner prescribed by
    // regulations" (S.I. 639/2010 reg.20; the particulars are checked when a
    // confirmed invoice is posted, vat.invoice_prescribed_particulars).
    { field: 'invoiceAvailable', operator: 'equals', value: 'true' },
  ],
  exceptions: [
    {
      condition: 'the tax relates to expenditure s.60(2)(a) lists: food, drink or '
        + 'accommodation or other personal services (i), such expenditure forming the cost of '
        + 'an advertising service (ii), immovable goods acquired or developed for '
        + 'non-business use on or after 1 January 2011 (iia), entertainment (iii), motor '
        + 'vehicles otherwise than as stock-in-trade or for the excluded businesses (iv, '
        + 'subject to s.59(2)(d)), petrol otherwise than as stock-in-trade (v), or contract '
        + 'work handing over goods to which s.60(2)(a)(vi) applies (VATCA 2010 s.60(2)(a))',
      effect: 'no deduction; each blocked category has its own rule '
        + '(vat.blocked_food_drink_accommodation, vat.blocked_entertainment, '
        + 'vat.blocked_motor_vehicle, vat.blocked_petrol), and qualifying accommodation at a '
        + 'qualifying conference is the exception s.60(1) defines (Revenue TDM VAT Part 3, '
        + 'Conferences — VAT deductibility, March 2025)',
    },
    {
      condition: 'the cost is a dual-use input, used for both deductible supplies or '
        + 'activities and non-deductible ones (VATCA 2010 s.61(1))',
      effect: 'only the proportion of tax deductible is deductible (s.61(2)): the turnover '
        + 'ratio of s.61(4) by default, or the other basis s.61(5) allows where the ratio '
        + 'does not reflect the use; the ratio is computed at period validation '
        + '(vat.dual_use_apportionment) and is not on the line - routed to review with that '
        + 'name, never guessed',
    },
    {
      condition: 'the tax is chargeable under another basis s.59(2) names rather than charged '
        + 'by invoice: the qualifying-vehicle 20 per cent (d), gas through the natural gas '
        + 'distribution network, heat or cooling energy or electricity (e), goods installed '
        + 'or assembled (f), services received under the reverse charge by virtue of s.12 '
        + 'or s.17(1) (g, as substituted 1 January 2011 by S.I. 612/2010 reg. 3(d), LRC '
        + 'F136), and the further bases (h) to (q)',
      effect: 'deductible on the same footing but evidenced differently; an import is '
        + 'accounted from the customs entry (vat.import_of_goods names it), and the '
        + 'reverse-charge VAT a recipient self-accounts for under s.12 is deducted as input '
        + 'VAT in the same period (s.59(2)(g)) - routed to review with the basis named rather '
        + 'than treated as non-deductible',
    },
    {
      condition: 'the purchase, hiring, intra-Community acquisition or importation is of a '
        + 'qualifying vehicle: first registered on or after 1 January 2021 with CO2 emissions '
        + 'under 140g/km, or in 2009-2020 under 156g/km (VATCA 2010 s.59(1)), used at least '
        + '60 per cent for business',
      effect: '20 per cent of the tax is deductible (s.59(2)(d), subject to s.61 and '
        + 'regulations); the registration, emissions and business use are not on the invoice '
        + '(Revenue TDM VAT Part 3, Recovery of VAT on motor vehicles, April 2026) - routed '
        + 'to review under that name (vat.blocked_motor_vehicle and '
        + 'vat.qualifying_vehicle_disposal carry it)',
    },
    {
      condition: 'the cost is used not for taxable supplies but for a qualifying activity: '
        + 'transport outside the State of passengers and their accompanying baggage (a), '
        + 'supplies deemed to have taken place in another Member State by s.30 (b), services '
        + 'specified in Schedule 1 paragraph 6(1), 7(1) or 8 supplied outside the Community '
        + 'or directly in connection with exports (d), or supplies outside the State that '
        + 'would be taxable supplies if made in the State (f) (VATCA 2010 s.59(1))',
      effect: 'deductible although not used for taxable supplies; which lines serve a '
        + 'qualifying activity is not on the line - routed to review with that name rather '
        + 'than guessed',
    },
    {
      condition: 'the person is an accountable person referred to in s.9(4) or s.12(3), or in '
        + 's.9(6) or s.12(5) other than for racehorse training services supplied, or in '
        + 's.22(3) or s.28(4), or a taxable person deemed to have supplied a letting under '
        + 's.28(5) (VATCA 2010 s.59(3), as substituted 12 November 2024 by Finance Act 2024 '
        + 's.80, LRC F144)',
      effect: 's.59(2) does not apply to them for the supplies those sections cover - routed '
        + 'to review with that name',
    },
  ],
  crossReferences: [
    'VATCA 2010 s.59(1)',
    'VATCA 2010 s.60',
    'VATCA 2010 s.61',
    'VATCA 2010 s.62',
    'VATCA 2010 s.12',
    'VATCA 2010 s.66',
    'S.I. 639/2010 reg.20',
  ],
  vatEffect: 'The VAT on the line is deductible (T2) in so far as the cost is used for the '
    + 'person\'s taxable supplies or any of the qualifying activities (s.59(2)): charged by '
    + 'invoice (s.59(2)(a)), on an import from the customs documents (s.59(2)(b)), on an '
    + 'intra-Community acquisition (s.59(2)(c)), and on the other bases the subsection names '
    + '- the 20 per cent qualifying-vehicle limit (d), gas, heat, cooling and electricity '
    + '(e), installed or assembled goods (f), services received under the reverse charge '
    + '(g) and the further bases (h) to (q). The s.60(2)(a) blocks deny it, the s.61 '
    + 'proportion trims it, and the s.62 formula claws back a qualifying vehicle\'s 20 per '
    + 'cent.',
  accountingEffect: null,
  reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT,
  interpretationNote: 'Version 2, curated from the revised s.59 '
    + '(catalogue/vatca-2010-revised/s059.json); the released version 1 is disabled, never '
    + 'changed. The quoted words are the opening of s.59(2) and the three bases a line '
    + 'evidences directly - invoice (a), customs documents (b), intra-Community acquisition '
    + '(c) - all unamended since the Act commenced, so the version starts with the Act; the '
    + 'remaining bases, including the reverse-charge basis (g) as substituted 1 January 2011 '
    + 'by S.I. 612/2010 reg. 3(d) (LRC F136), are named exceptions rather than quoted, '
    + 'because a quote spanning them would date this version from the latest amendment to '
    + 'any limb (s.59(2)(j) was substituted 1 August 2026 by the National Treasury '
    + 'Management Agency (Miscellaneous Provisions) Act 2026 s.4(3), LRC F140) and leave the '
    + 'deduction\'s span before that date uncovered. The use test is read from the line\'s '
    + 'business-use share, not a person\'s confirmation: a share of 100 is wholly for '
    + 'taxable supplies; below 100 is dual use, the s.61 proportion with the share flagged; '
    + 'absent means not yet assessed and the deduction is unresolved. The qualifying '
    + 'activities of s.59(1)(a)-(f), the s.60(2)(a) blocks, the s.61 apportionment and the '
    + 's.62 qualifying-vehicle reduction (TDMs: Recovery of VAT on motor vehicles, April '
    + '2026; Conferences — VAT deductibility, March 2025) are named routes; the blocked '
    + 'categories override this rule when they match (ruleLinks excludes). requiresGuidance '
    + 'stays set: this version records no approval.',
};

/** Every tightened version this module derives, keyed by its section. */
export const CONDITION_TIGHTENED_RULES: TightenedRule[] = [S12_REVERSE_CHARGE, S34_PLACE_OF_SUPPLY_B2B, S59_INPUT_DEDUCTION];

export interface ConditionTighteningResult {
  created: number;
  unchanged: number;
  /** Released versions disabled (never closed or edited) by their successor. */
  disabled: number;
  skippedNoProvision: string[];
  /** Rules refused because their quoted excerpt is not in the provision text. */
  skippedExcerptNotInProvision: string[];
}

/**
 * Derive each tightened rule as a new version of its key. The version before
 * it — released, its hash shipped — is disabled, never closed: its dates are
 * part of the released-versions hash, so a disabled row is the only way to
 * supersede it without the build failing on a changed release.
 */
export function deriveConditionTightenedRules(
  db: AppDatabase,
  params: { companyId: string },
): ConditionTighteningResult {
  const result: ConditionTighteningResult = {
    created: 0, unchanged: 0, disabled: 0, skippedNoProvision: [], skippedExcerptNotInProvision: [],
  };

  for (const rule of CONDITION_TIGHTENED_RULES) {
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).all()
      .find((s) => s.localPath?.startsWith('catalogue/'));
    const sourceId = source?.id ?? preferredSourceId(db, rule.citation);
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
    if (!prov || !prov.relevant) { result.skippedNoProvision.push(rule.ruleKey); continue; }

    // Issue #199's guard: a rule whose quote is not verbatim in its provision
    // is refused, never inserted.
    if (!containsIgnoringLayout(prov.provisionText ?? '', rule.statementExcerpt)) {
      result.skippedExcerptNotInProvision.push(rule.ruleKey);
      continue;
    }

    // The version's window is its quoted words' own (issue #206): the latest
    // LRC amendment that touches them, else the Act's commencement.
    const annotations = source ? lrcAnnotationsForSource(db, source.id) : null;
    const window = annotations ? quotedTextWindow(annotations, [rule.statementExcerpt]) : null;
    const effectiveFrom = window?.effectiveFrom ?? rule.effectiveFrom;
    const windowNote = window
      ? (window.footnotes.length
        ? `Effective from ${effectiveFrom}, the latest LRC amendment to the quoted words: `
          + `${window.footnotes.map((f) => `${f.ref} ${f.text}`).join(' ')} `
        : `Effective from ${effectiveFrom}: the LRC records no amendment to the quoted words since the Act commenced. `)
      : '';

    const rows = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, rule.ruleKey))).all();
    const same = rows.find((r) => r.provisionId === prov.id && r.statement === rule.statementExcerpt
      && JSON.stringify(r.conditions) === JSON.stringify(rule.conditions) && r.effectiveFrom === effectiveFrom);
    if (same) {
      // Idempotent: the tightened version already stands; make sure it, and
      // only it, is in force.
      if (!same.active || !same.enabled) {
        db.update(irishTaxRules).set({ active: true, enabled: true }).where(eq(irishTaxRules.id, same.id)).run();
      }
      for (const row of rows) {
        if (row.id !== same.id && row.active) {
          db.update(irishTaxRules).set({ active: false, enabled: false }).where(eq(irishTaxRules.id, row.id)).run();
          result.disabled++;
        }
      }
      result.unchanged++;
      continue;
    }

    // The version before it — released, its hash shipped — is disabled, never
    // closed or edited: closing it would change the released-version hash and
    // fail the build.
    const prior = rows.filter((r) => r.active || r.enabled)
      .sort((a, b) => b.ruleVersion - a.ruleVersion)[0];
    const nextVersion = rows.reduce((max, r) => Math.max(max, r.ruleVersion), 0) + 1;
    if (prior) {
      db.update(irishTaxRules).set({ active: false, enabled: false })
        .where(eq(irishTaxRules.id, prior.id)).run();
      result.disabled++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: rule.topic,
      taxHeads: taxHeadsFor(rule.ruleKey, rule.topic),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: 'Treatment decided from context (see vatSuggestion.ts)',
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: rule.crossReferences,
      accountingEffect: rule.accountingEffect,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: nextVersion,
      supersedesRuleId: prior?.id ?? null,
      priority: 100,
      effectiveFrom,
      effectiveTo: null,
      active: true,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} (LRC revised). Not yet human-reviewed. ${windowNote}${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    result.created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule version extracted: ${rule.name}`,
      detail: `${rule.citation} s.${rule.sectionNumber} (version ${nextVersion}). ${rule.interpretationNote} `
        + 'Review the condition mapping against the source text and approve, or reject, before it is '
        + 'treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber, ruleVersion: nextVersion },
    });
  }

  return result;
}

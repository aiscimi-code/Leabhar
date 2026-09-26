/**
 * Cross-border VAT rules (issue #207 part 2): intra-Community acquisitions,
 * imports, distance sales, the s.34 place-of-supply exceptions, s.10 goods
 * and s.35 use and enjoyment.
 *
 * Every rule here that turns on where a party is established reads the
 * establishment a person confirmed on the supplier or customer
 * (`counterpartyEstablishedOutsideState`, part 1), never a country code. The
 * country only says, once establishment abroad is confirmed, whether it is
 * in another Member State (`counterpartyInEu`).
 *
 * Only the acquisition rule decides a treatment (EU_GOODS_ACQ). The import
 * rule decides from the customs entry's own markers when the document shows
 * them. The rest are bound to no treatment: each names why the choice is the
 * person's (where the property or event is, whether the EU-wide distance-sales
 * threshold is passed, whether the goods are installed), and the line is
 * flagged with that reason (`CROSS_BORDER_GAPS`).
 */
import type { IrishRuleCondition } from '@/db/schema';
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';
const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });
const is = (field: string, value: string): IrishRuleCondition => ({ field, operator: 'equals', value });

export const ICA_RULE_KEY = 'vat.intra_community_acquisition_goods';
export const IMPORT_RULE_KEY = 'vat.import_of_goods';

type Rule = Omit<CuratedVatScopeRule, 'ruleType' | 'topic' | 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'effectiveFrom' | 'treatment' | 'exceptions'>
  & Partial<Pick<CuratedVatScopeRule, 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'exceptions'>>;
const rule = (r: Rule): CuratedVatScopeRule => ({
  ruleType: 'other', topic: 'vat_scope', crossReferences: [], accountingEffect: null, reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT, treatment: null, exceptions: [], ...r,
});

const EXCEPTION_BASE = [is('counterpartyEstablishedOutsideState', 'true')];

export const CROSS_BORDER_CURATED_RULES: CuratedVatScopeRule[] = [
  rule({
    citation: '2010 Act 31 s.9', sectionNumber: '9', ruleKey: ICA_RULE_KEY,
    name: 'Goods bought from a supplier established in another Member State: intra-Community acquisition',
    statementExcerpt: 'Where a person engages in the intra-Community acquisition of goods in the State in\nthe course or '
      + 'furtherance of business, he or she shall be',
    conditions: [
      is('direction', 'purchase'), is('supplyType', 'goods'), is('vatRegistered', 'true'),
      is('counterpartyEstablishedOutsideState', 'true'), is('counterpartyInEu', 'true'),
    ],
    exceptions: [
      {
        condition: 'the goods are not dispatched from another Member State to the State (they were already here, or come from outside the EU)',
        effect: 'not an intra-Community acquisition: a domestic supply, or an import',
      },
      {
        condition: 'the supplier charged its own country\'s VAT (it did not treat the sale as an intra-Community supply)',
        effect: 'the invoice is wrong for an acquisition: ask the supplier for a corrected invoice with your VAT number',
      },
    ],
    crossReferences: ['VATCA 2010 s.3(d)', 'VATCA 2010 s.24', 'VATCA 2010 s.32 (acquisition made where the goods arrive)'],
    vatEffect: 'You account for Irish VAT on the acquisition at the goods\' Irish rate (T1) and, where deductible, '
      + 'reclaim it in the same return (T2).',
    reportingEffect: 'The net value goes in box E2 of the VAT3.',
    interpretationNote: 'Requires the supplier\'s establishment in another Member State to be confirmed on its record '
      + 'and the line to be a supply of goods. That the goods were dispatched to Ireland is not on every invoice.',
  }),
  rule({
    citation: '2010 Act 31 s.3', sectionNumber: '3', ruleKey: IMPORT_RULE_KEY,
    name: 'Goods bought from a supplier established outside the EU: an importation',
    statementExcerpt: 'the importation\nof goods',
    conditions: [
      is('direction', 'purchase'), is('supplyType', 'goods'),
      is('counterpartyEstablishedOutsideState', 'true'), is('counterpartyInEu', 'false'),
    ],
    exceptions: [{
      condition: 'the goods were already in the EU (bought from stock held in a Member State)',
      effect: 'not an importation by you: a domestic or intra-Community supply',
    }],
    crossReferences: ['VATCA 2010 s.53 (value)', 'VATCA 2010 s.53A (postponed accounting)', 'Revenue Customs Manual on Import VAT'],
    vatEffect: 'Import VAT is due at importation, on the customs value plus duty and charges (s.53). It is paid to '
      + 'Customs at entry, or accounted for in the VAT3 under postponed accounting (s.53A).',
    reportingEffect: 'Under postponed accounting: T1 and T2, and the goods\' value in box PA1.',
    interpretationNote: 'The customs import entry is the evidence, not the supplier\'s invoice: "IEPOSTPONED" (code '
      + '1A05) on the entry means postponed accounting; tax type B00 means import VAT was paid at entry (Revenue '
      + 'Customs Manual on Import VAT, docs/statutes/import-vat). Without the entry the choice is flagged.',
  }),
  rule({
    citation: 'VATCA 2010 s.30', sectionNumber: '30', ruleKey: 'vat.distance_sales_goods_eu_consumers',
    name: 'Goods sold and sent to consumers in other Member States: distance sales',
    statementExcerpt: 'in the case of an intra-Community distance sale of goods,\nthe place where the goods are located when '
      + 'the dispatch or transport of the goods\nto the customer ends',
    conditions: [
      is('direction', 'sale'), is('supplyType', 'goods'), is('customerIsTaxablePerson', 'false'), is('counterpartyInEu', 'true'),
    ],
    vatEffect: 'Supplied where the goods arrive once the EU-wide total of such sales passes the threshold (s.35A), '
      + 'and then taxed at that country\'s rate, usually through the One-Stop Shop.',
    interpretationNote: 'The threshold is in s.35A, which is not in the repository, and the One-Stop Shop is not modelled: '
      + 'the line is flagged.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_immovable_goods',
    name: 'Services connected with property: supplied where the property is (s.34(c))',
    statementExcerpt: 'if the\nsupply of services is connected with immovable goods, or is the grant of a right\nto use those goods, '
      + 'the place where those goods are located',
    conditions: [...EXCEPTION_BASE, desc('\\b(property|premises|building|site|construction|architect\\w*|surveying|'
      + 'estate agent|conveyancing|hotel|accommodation|rent|lease|office space|co-?working)\\b')],
    vatEffect: 'Supplied where the property is, whoever the customer is.',
    interpretationNote: 'Where the property is is not on every line.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_passenger_transport',
    name: 'Passenger transport: supplied where the transport takes place (s.34(d))',
    statementExcerpt: 'if the\nsupply of services is the provision of passenger transport, the place or the\nplaces where the transport takes place',
    conditions: [...EXCEPTION_BASE, desc('\\b(flight|airfare|train|rail|bus|coach|ferry|taxi|transfer|passenger)\\b')],
    vatEffect: 'Supplied where the transport takes place, in proportion to the distance covered in each country.',
    interpretationNote: 'The route is not on every line.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_event_admission',
    name: 'Admission to events: supplied where the event takes place (s.34(g))',
    statementExcerpt: 'is in respect of or related to\nadmission to a cultural, artistic, sporting, scientific, educational,\nentertainment or similar event',
    conditions: [...EXCEPTION_BASE, desc('\\b(conference|summit|expo|exhibition|trade (fair|show)|event|tickets?|admission|delegate)\\b')],
    exceptions: [{ condition: 'attendance is virtual', effect: 's.34(g) does not apply; the general rule does' }],
    vatEffect: 'Supplied where the event takes place: an Irish event bears Irish VAT, a foreign event the other country\'s.',
    interpretationNote: 'Where the event is, and whether attendance is virtual, is not on every line.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_restaurant_catering',
    name: 'Restaurant and catering: supplied where it is physically carried out (s.34(i))',
    statementExcerpt: 'if the\nsupply of services is the provision of restaurant or catering services',
    conditions: [...EXCEPTION_BASE, desc('\\b(restaurant|catering|caterer|meals?|dinner|lunch)\\b')],
    vatEffect: 'Supplied where the meal or catering is provided.',
    interpretationNote: 'Where it took place is not on every line.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_short_term_hire',
    name: 'Short-term hire of a means of transport: supplied where it is put at the customer\'s disposal (s.34(k))',
    statementExcerpt: 'if the\nsupply of services consists of a short-term hiring out of a means of transport,\nthe place where the '
      + 'means of transport is actually placed at the disposal of the\ncustomer',
    conditions: [...EXCEPTION_BASE, desc('\\b(car hire|car rental|vehicle hire|van hire|rental car|boat hire)\\b')],
    vatEffect: 'Supplied where the vehicle is handed over.',
    interpretationNote: 'Where the vehicle was collected is not on every line.',
  }),
  rule({
    citation: '2010 Act 31 s.34', sectionNumber: '34', ruleKey: 'vat.place_of_supply_electronic_services_consumers',
    name: 'Telecoms, broadcasting and electronic services sold to consumers abroad: supplied where the consumer is (s.34(kc))',
    statementExcerpt: 'electronically\nsupplied services,',
    conditions: [
      is('direction', 'sale'), is('customerIsTaxablePerson', 'false'), is('counterpartyInEu', 'true'),
      desc('\\b(subscription|download|app|software|saas|licen[cs]e|streaming|e-?book|online course|digital)\\b'),
    ],
    vatEffect: 'Supplied where the consumer is (s.34(kc)), subject to the EU-wide threshold in s.35A; usually taxed '
      + 'through the One-Stop Shop at that country\'s rate.',
    interpretationNote: 's.35A and the One-Stop Shop are not modelled: the line is flagged.',
  }),
  rule({
    citation: '2010 Act 31 s.10', sectionNumber: '10', ruleKey: 'vat.recipient_accountable_goods_installed_or_energy',
    name: 'Goods installed, or gas and electricity supplied, by a supplier not established in the State: you account for the VAT (s.10)',
    statementExcerpt: 'supplies goods in the State which are installed or\nassembled, with or without a trial run, by or on behalf of the person',
    conditions: [
      is('direction', 'purchase'), is('counterpartyEstablishedOutsideState', 'true'),
      desc('\\b(install\\w*|assembl\\w*|commissioning|electricity|natural gas|district heat\\w*)\\b'),
    ],
    vatEffect: 'You, not the supplier, account for the Irish VAT on the supply, as if you had made it (s.10).',
    interpretationNote: 'No treatment is configured for a reverse charge on goods supplied in the State: the line is flagged.',
  }),
  rule({
    citation: '2010 Act 31 s.35', sectionNumber: '35', ruleKey: 'vat.use_and_enjoyment_hire_of_goods',
    name: 'Movable goods hired from outside the EU and used in the State: supplied in the State (s.35(1))',
    statementExcerpt: 'Where, in the case of a supply of services that consists of hiring out movable\ngoods, the place of '
      + 'supply of the services would, apart from this subsection, be a\nplace outside the Community but the services are '
      + 'in effect used and enjoyed in the\nState',
    conditions: [
      is('direction', 'purchase'), is('counterpartyEstablishedOutsideState', 'true'), is('counterpartyInEu', 'false'),
      desc('\\b(hire|rental|lease)\\b'),
    ],
    vatEffect: 'Supplied in the State when the goods are used and enjoyed here.',
    interpretationNote: 'Where the goods are used is not on every line.',
  }),
];

/** Why each flag-only rule leaves the choice to a person (shown as the line's review reason). */
export const CROSS_BORDER_GAPS: Record<string, string> = {
  [IMPORT_RULE_KEY]: 'Import VAT is accounted for from the customs import entry, not the supplier\'s invoice. Attach '
    + 'the entry: "IEPOSTPONED" (code 1A05) means postponed accounting (IMPORT_PA); tax type B00 means VAT was paid at '
    + 'entry (IMPORT_VAT_PAID).',
  'vat.distance_sales_goods_eu_consumers': 'A distance sale of goods to a consumer in another Member State is taxed '
    + 'there once EU-wide distance sales pass the s.35A threshold (not in the repository), usually through the One-Stop '
    + 'Shop, which this system does not model. Choose the treatment with your adviser.',
  'vat.place_of_supply_immovable_goods': 'A service connected with property is supplied where the property is (s.34(c)), '
    + 'not where the business is established. Property in Ireland: Irish VAT applies. Property abroad: outside Irish VAT.',
  'vat.place_of_supply_passenger_transport': 'Passenger transport is supplied where it takes place (s.34(d)). Choose '
    + 'the treatment for the route.',
  'vat.place_of_supply_event_admission': 'Admission to an event is supplied where the event takes place (s.34(g)). An '
    + 'event in Ireland bears Irish VAT; an event abroad does not.',
  'vat.place_of_supply_restaurant_catering': 'Restaurant and catering services are supplied where they are carried out '
    + '(s.34(i)). A meal abroad bears no Irish VAT; a meal in Ireland does.',
  'vat.place_of_supply_short_term_hire': 'Short-term hire of a vehicle is supplied where it is handed over (s.34(k)).',
  'vat.place_of_supply_electronic_services_consumers': 'Electronic, telecoms and broadcasting services sold to a '
    + 'consumer in another Member State are supplied where the consumer is (s.34(kc)), subject to the s.35A threshold; '
    + 'the One-Stop Shop is not modelled.',
  'vat.recipient_accountable_goods_installed_or_energy': 'A supplier not established in the State that installs goods '
    + 'here, or supplies gas or electricity, does not charge Irish VAT: you account for it (s.10). No treatment is '
    + 'configured for this; record it with your adviser.',
  'vat.use_and_enjoyment_hire_of_goods': 'Goods hired from outside the EU and used in Ireland are hired in the State '
    + '(s.35(1)): Irish VAT applies to the hire.',
};

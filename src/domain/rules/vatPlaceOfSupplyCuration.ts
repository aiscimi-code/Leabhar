/**
 * Curated place-of-supply rules for SALES of services (issue #200 step 5):
 * where a service the company sells is supplied, and so whether Irish VAT is
 * charged on it at all. Sourced from VATCA 2010 s.34 in its LRC-revised form
 * (docs/statutes/vatca-2010-revised/s034.md) — not the 2010 as-enacted s.34
 * `vatcaCuration.ts` reads, which #199 found differs from the current text.
 *
 * s.34 turns on one fact about the CUSTOMER: whether it receives the service
 * as a taxable person acting as such (a business) or not (a consumer).
 *
 *  - (a) business customer: the service is supplied where the customer's
 *    business is established. For a customer established abroad the sale is
 *    outside Irish VAT — the customer self-accounts in its own country (an EU
 *    customer: reported in ES1 and the VIES statement), and nothing is charged.
 *  - (b) consumer: the service is supplied where the SUPPLIER is established —
 *    Ireland — so Irish VAT is charged at whatever rate applies, wherever the
 *    consumer lives. This rule decides no treatment by itself; it tells the
 *    suggestion that a foreign consumer does not make the sale cross-border,
 *    so the rate rules still apply.
 *
 * The customer's taxable status comes from `customers.taxable_status` when
 * recorded, else from a structurally valid EU VAT number (EU Reg 282/2011
 * art.18(1) treats one as evidence — not ingested here, and not VIES-checked).
 * "Established abroad" is the establishment recorded and confirmed on the
 * customer (282/2011 arts.10-11, issue #207), never its country code; without
 * it the rule is unresolved and the line is flagged. The listed exceptions — (c) immovable goods,
 * (d) passenger transport, (g) event admission, (i) restaurant and catering,
 * (k) short-term vehicle hire, and for consumers (kc) telecoms/broadcasting/
 * electronically supplied services — are stated, not evaluated.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';

/** Rule key for s.34(b), which the suggestion treats as "Irish VAT applies" rather than a treatment. */
export const VAT_POS_CONSUMER_RULE_KEY = 'vat.place_of_supply_services_to_consumer';
/** Rule key for s.34(a) to a business abroad. */
export const VAT_POS_BUSINESS_ABROAD_RULE_KEY = 'vat.place_of_supply_services_to_business_abroad';

export const VAT_PLACE_OF_SUPPLY_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.34',
    sectionNumber: '34',
    ruleKey: VAT_POS_BUSINESS_ABROAD_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Services sold to a business established abroad: supplied where the customer is (s.34(a))',
    statementExcerpt: 'the place of supply of services to a taxable person acting as such\nis—\n\n(i) subject to\n\n'
      + 'subparagraph (ii)\n, the place where the person’s business is\nestablished',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'sale' },
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'customerIsTaxablePerson', operator: 'equals', value: 'true' },
      // Where the customer is established, as confirmed on its record; never its country code (issue #207).
      { field: 'customerEstablishedOutsideState', operator: 'equals', value: 'true' },
    ],
    exceptions: [
      { condition: 'the service is connected with immovable goods (s.34(c))', effect: 'supplied where the property is — Irish VAT if it is in the State' },
      { condition: 'the service is passenger transport (s.34(d))', effect: 'supplied where the transport takes place' },
      { condition: 'the service is admission to an event (s.34(g))', effect: 'supplied where the event takes place' },
      { condition: 'the service is restaurant or catering (s.34(i), (j))', effect: 'supplied where it is physically carried out' },
      { condition: 'the service is short-term hire of a means of transport (s.34(k))', effect: 'supplied where the vehicle is put at the customer\'s disposal' },
      {
        condition: 'the service is supplied to the customer\'s fixed establishment in the State (s.34(a)(ii))',
        effect: 'supplied in the State; Irish VAT applies',
      },
    ],
    crossReferences: [
      'EU Reg 282/2011 art.18 (evidence of customer status — not ingested)',
      'EU Reg 282/2011 arts.10-11 (establishment — docs/statutes/282-2011, not ingested)',
      'VATCA 2010 s.34(c)-(k)',
    ],
    treatment: null, // EU_SERVICES_SUPPLY or NON_EU_SERVICES_SUPPLY by customer country — see vatSuggestion.ts
    vatEffect: 'A service sold to a business customer is supplied where that customer\'s business is established '
      + '(s.34(a)). For a customer established outside the State no Irish VAT is charged: an EU business customer '
      + 'accounts for VAT in its own Member State under the reverse charge; a customer outside the EU is outside '
      + 'the scope of EU VAT.',
    accountingEffect: 'Book the full amount as sales; there is no output VAT.',
    reportingEffect: 'EU business customer: the net value goes in box ES1 and on the VIES statement, with the '
      + 'customer\'s VAT number. Non-EU customer: not reported on the VAT3.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'customerIsTaxablePerson comes from the customer record or an EU VAT number; '
      + 'customerEstablishedOutsideState is the establishment confirmed on the customer record (282/2011 '
      + 'arts.10-11, issue #207), never a country code. The s.34(c)-(k) exceptions are stated, not evaluated. effectiveFrom is the Act\'s '
      + 'commencement applied to the current consolidated text (issue #199).',
  },
  {
    citation: '2010 Act 31 s.34',
    sectionNumber: '34',
    ruleKey: VAT_POS_CONSUMER_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Services sold to a consumer: supplied where the supplier is established (s.34(b))',
    statementExcerpt: 'the place of supply of services\nto a non-taxable person is—\n\n(i) subject to\n\n'
      + 'subparagraph (ii)\n, the place where the supplier’s business is\nestablished',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'sale' },
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'customerIsTaxablePerson', operator: 'equals', value: 'false' },
    ],
    exceptions: [
      {
        condition: 'the service is telecommunications, broadcasting or an electronically supplied service (s.34(kc))',
        effect: 'supplied where the consumer is established or lives — for an EU consumer, that Member State\'s '
          + 'VAT (One-Stop Shop), subject to s.35A — not modelled here',
      },
      {
        condition: 'the service is of a kind in s.33(5) and the consumer is outside the EU (s.34(m))',
        effect: 'supplied where the consumer is; outside Irish VAT',
      },
      { condition: 'one of s.34(c)-(n) applies (property, transport, events, catering, vehicle hire, intermediaries)', effect: 'that paragraph decides the place of supply instead' },
    ],
    crossReferences: ['VATCA 2010 s.34(kc), s.35A (not ingested)', 'VATCA 2010 s.33(5), s.34(m)'],
    treatment: null, // Irish VAT at the applicable rate — the rate rules decide
    vatEffect: 'A service sold to a consumer is supplied where the supplier\'s business is established — for an '
      + 'Irish business, the State — so Irish VAT is charged at the applicable rate, wherever the consumer lives, '
      + 'unless a s.34(c)-(n) exception applies.',
    accountingEffect: null,
    reportingEffect: 'Output VAT in T1, as for a domestic sale.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'Fires only where the customer record says non_taxable_person: a missing VAT number is not '
      + 'evidence that a customer is a consumer. The (kc) electronic-services exception is the one most likely to '
      + 'matter to a software business selling to EU consumers, and is not evaluated.',
  },
];

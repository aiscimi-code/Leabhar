/**
 * VATCA 2010 s.47, composite and multiple supplies (issue #206).
 *
 * A line that looks ancillary (delivery, carriage, packaging, handling) takes
 * the rate of the supply it is ancillary to, if the invoice is one composite
 * supply (s.47(1)(a)); if the lines are separate supplies sold together (a
 * multiple supply), each takes its own rate and the price is apportioned
 * (s.47(1)(b)). Which it is depends on s.2(1)'s definitions ("not physically
 * and economically dissociable from a principal supply"), a judgement the
 * invoice does not settle.
 *
 * So this rule decides no treatment and is bound to none. It marks a line as
 * possibly ancillary; `documentLineChoices` then compares it with the other
 * lines on the same invoice, offers the principal supply's treatment, and
 * flags the choice (`consolidation/compositeSupply.ts`). The source is the LRC
 * revised s.47 (docs/statutes/vatca-2010-revised/s047.md), cited as its front
 * matter states.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const COMPOSITE_SUPPLY_RULE_KEY = 'vat.composite_supply_follows_principal';

/** Words that mark a line as possibly ancillary to another supply on the same invoice. */
export const ANCILLARY_LINE_PATTERN = '\\b(delivery|deliveries|shipping|postage|p\\s?&\\s?p|carriage|freight|'
  + 'packaging|packing|handling|courier)\\b';

export const COMPOSITE_SUPPLY_RULES: CuratedVatScopeRule[] = [
  {
    citation: 'VATCA 2010 s.47',
    sectionNumber: '47',
    ruleKey: COMPOSITE_SUPPLY_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Composite supply: an ancillary line follows the principal supply\'s rate',
    statementExcerpt: 'in the case\nof a composite supply, the tax chargeable on the total consideration which the\n'
      + 'accountable person is entitled to receive for that composite supply shall be at\nthe rate specified in',
    conditions: [{ field: 'description', operator: 'matches', value: ANCILLARY_LINE_PATTERN }],
    exceptions: [{
      condition: 'the line is a supply in its own right, sold alongside the others for one price (a multiple supply)',
      effect: 's.47(1)(b): it takes its own rate, on its share of the price',
    }],
    crossReferences: ['VATCA 2010 s.2(1) "ancillary supply", "composite supply", "principal supply", "multiple supply"'],
    treatment: null,
    vatEffect: 'If the line is ancillary to another supply on the invoice (a composite supply), it bears the '
      + 'principal supply\'s rate, or no VAT if the principal supply is exempt (s.47(1)(a)).',
    accountingEffect: null,
    reportingEffect: null,
    effectiveFrom: '2010-11-01',
    interpretationNote: 'Suggests no treatment on its own: the other lines of the same invoice decide which '
      + 'rate an ancillary line would follow, and whether it is ancillary at all is a judgement (issue #206).',
  },
];

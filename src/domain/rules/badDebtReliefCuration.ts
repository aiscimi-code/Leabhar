/**
 * Bad-debt relief (issue #620). Enforced by `claimBadDebtRelief`
 * (src/domain/invoicing/badDebts.ts) from the facts a person states, not by
 * matching words, so it carries no conditions and the `vat_reference` topic:
 * citable, never matched. The conditions and the formula are S.I. 639/2010
 * reg.10 (si639Curation.ts).
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const BAD_DEBT_RELIEF_RULE_KEY = 'vat.consideration_not_received_relief';

export const BAD_DEBT_RELIEF_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.39', sectionNumber: '39', ruleKey: BAD_DEBT_RELIEF_RULE_KEY,
    ruleType: 'relief', topic: 'vat_reference', effectiveFrom: '2010-11-01', treatment: null,
    name: 'Consideration not received: relief for the deficiency as regulations provide (s.39(2))',
    statementExcerpt: 'such relief may be given by repayment or\notherwise in respect of the deficiency as may be provided by\nregulations.',
    conditions: [],
    exceptions: [
      { condition: 'a letting of immovable goods that is a taxable supply of goods under s.95 (s.39(3))', effect: 'no relief under s.39(2)' },
      { condition: 'a reduction or discount allowed after the invoice (s.39(4))', effect: 'no relief until the s.67(1)(b) credit note is issued' },
    ],
    crossReferences: ['S.I. 639/2010 reg.10 (bad debts: conditions, A x B / (100 + B), recovery)', 'VATCA 2010 s.38', 'VATCA 2010 s.67(1)(b)'],
    vatEffect: 'Where the consideration actually received is less than the amount on which tax was charged, or none is '
      + 'received, the tax on the deficiency is relieved as the regulations provide.',
    accountingEffect: 'The relief reduces the bad-debt charge the write-off made.',
    reportingEffect: 'T2 in the period the claim is made (S.I. 639/2010 reg.10(9)).',
    interpretationNote: 'Enforced by claimBadDebtRelief from the facts a person states, not by matching words.',
  },
];

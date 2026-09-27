/**
 * Curated rules for VATCA 2010 Part 5 Chapter 1, the taxable amount
 * (issue #245: ss.36–45, consideration, open market value, adjustments).
 *
 * The invoice states the taxable amount; these rules never overwrite it. They
 * flag the situations where the stated figure may not be the one the Act
 * charges — a supply to a connected party below open market value (s.38),
 * goods provided under a services agreement that dominate its price (s.41,
 * the two-thirds rule), a credit note changing the tax charged (s.45) — and
 * state the general rule the whole Chapter turns on (s.37). A flagged line
 * always ends with a person deciding; nothing is silently repaired
 * (AGENTS.md invariant 7).
 *
 * Sources: ss.37 and 45 in their LRC-revised form
 * (docs/statutes/vatca-2010-revised/s037.md, s045.md — whose front matter
 * cites it "VATCA 2010 s.45"), ss.38 and 41 as enacted (the whole-Act text,
 * cited "2010 Act 31") — no revised text for those two is in the repository,
 * so the rule cites the 2010 text and the 2010 commencement.
 *
 * Every `statementExcerpt` is a verbatim substring of its provision's
 * `provisionText`; `deriveVatScopeRules` refuses (and reports) any that is
 * not.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const TAXABLE_AMOUNT_GENERAL_RULE_KEY = 'vat.taxable_amount_general';
export const OMV_CONNECTED_PARTY_RULE_KEY = 'vat.omv_connected_party_low_price';
export const TWO_THIRDS_RULE_KEY = 'vat.two_thirds_rule_goods_with_services';
export const CREDIT_NOTE_ADJUSTMENT_RULE_KEY = 'vat.consideration_change_credit_note';

/**
 * The rules that never decide a treatment (the facts they turn on are not on
 * any line): what each says when it matches, added to the review reasons by
 * `advisoryReasons` (advisoryRules.ts).
 */
export const TAXABLE_AMOUNT_ADVISORY: Record<string, string> = {
  [OMV_CONNECTED_PARTY_RULE_KEY]: 'The line names a connected party: where a supply to a connected person is '
    + 'below its open market value and the recipient cannot deduct all the tax, VAT may have to be accounted for '
    + 'on the open market value (VATCA s.38). The price is never changed automatically — confirm the open market '
    + 'value with your adviser.',
  [TWO_THIRDS_RULE_KEY]: 'Goods provided under a services agreement: if their value exceeds two-thirds of the '
    + 'total consideration, the whole price is deemed referable to the goods and taxed at the goods\' rate (VATCA '
    + 's.41). The goods\' share is not on the line — check it and the goods\' rate with your adviser.',
  [CREDIT_NOTE_ADJUSTMENT_RULE_KEY]: 'A credit note adjusts the tax charged by the amount of the change (VATCA '
    + 's.45): it posts as its own document and the VAT entries follow it. The original invoice is never edited '
    + '(invariant 2).',
};

const VATCA_COMMENCEMENT = '2010-11-01';

const desc = (value: string) => ({ field: 'description', operator: 'matches' as const, value });

/** Chapter 1 statuses the matrix cannot see on a line: the reasons are in docs/rules/coverage-matrix.json. */
export const TAXABLE_AMOUNT_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.37',
    sectionNumber: '37',
    ruleKey: TAXABLE_AMOUNT_GENERAL_RULE_KEY,
    ruleType: 'definition',
    topic: 'vat_scope',
    name: 'Taxable amount: the total consideration, including all taxes and charges except VAT (s.37(1))',
    statementExcerpt: 'the total consideration which the\n'
      + 'person supplying goods or services becomes entitled to receive in respect of or in\n'
      + 'relation to such supply of goods or services, including all taxes, commissions,\n'
      + 'costs and charges whatsoever, but not including value-added tax chargeable in\n'
      + 'respect of that supply',
    conditions: [{ field: 'vatChargedMinor', operator: 'gt', value: '0' }],
    exceptions: [],
    crossReferences: ['VATCA 2010 s.37(2) (intra-Community acquisitions)', 'VATCA 2010 s.37(3) (consideration not in money: open market price)'],
    treatment: null,
    vatEffect: 'The taxable amount is everything the supplier becomes entitled to receive for the supply — all taxes, '
      + 'commissions, costs and charges — except VAT itself. The invoice\'s own figure governs; a line whose VAT does '
      + 'not reconcile with it is flagged by the rate check (src/domain/rules/lineRateCheck.ts), never repaired.',
    accountingEffect: null,
    reportingEffect: 'T2 of the return sums VAT on the amounts this section defines.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'Foundational (like vat.charge_general), scoped to the lines it speaks to: it applies where '
      + 'a document line states a VAT amount, because that is where the taxable amount the line prints is the figure '
      + 's.37(1) defines. It decides no treatment.',
  },
  {
    citation: '2010 Act 31',
    sectionNumber: '38',
    ruleKey: OMV_CONNECTED_PARTY_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Open market value may apply: a supply to a connected party below its open market value (s.38(1)(a)(i), (b))',
    statementExcerpt: 'chargeable on a supply of goods or services is the open market value',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'sale' },
      desc('\\bconnected (persons?|part(y|ies))\\b|\\brelated (part(y|ies)|compan(y|ies)|entit(y|ies))\\b'
        + '|\\b(director|spouse|family member)s?\\b.{0,40}\\b(sale|sold|purchase|transfer|invoice)\\b'
        + '|\\b(sale|sold|purchase|transfer|invoice)\\b.{0,40}\\b(director|spouse|family member)s?\\b'),
    ],
    exceptions: [
      {
        condition: 'the recipient deducts all the tax on the supply, and neither party is a flat-rate farmer or in '
          + 'non-deductible supplies (s.38(1)(a))',
        effect: 'the Act charges the actual consideration; no open market value determination',
      },
      {
        condition: 'the price is the supply\'s open market value',
        effect: 's.38 has nothing to raise; the consideration and the value are the same',
      },
    ],
    crossReferences: ['VATCA 2010 s.37(3) (consideration not in money)', 'TCA 1997 s.10 (connected persons, a separate income tax concept)'],
    treatment: null,
    vatEffect: 'Where a supply to a connected person is below its open market value and the recipient cannot deduct '
      + 'all the tax, Revenue may determine that the tax is charged on the open market value (s.38(1)(a)(i), (b)). '
      + 'The amount charged never changes on its own: this rule flags the sale for a person.',
    accountingEffect: null,
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: connected-party wording on the line stands in for s.38(1)(b) (parties connected by '
      + 'financial or legal ties). Whether the price is below open market value is not on the line: always confirmed '
      + 'by a person.',
  },
  {
    citation: '2010 Act 31',
    sectionNumber: '41',
    ruleKey: TWO_THIRDS_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Two-thirds rule: goods provided under a services agreement may carry the whole price\'s rate (s.41(1))',
    statementExcerpt: 'exceeds two-thirds of the total\nconsideration under the agreement',
    conditions: [
      desc('\\bsupply (and|&) (fit|fits|fitted|install|installed|installation|erect|lay)\\b|\\b(supply|fitting) and '
      + '(installation|fixing)\\b|\\b(made|manufactured|built) to (order|specification)\\b'),
    ],
    exceptions: [
      {
        condition: 'the goods are of a kind specified in Schedule 2 paragraph 8, or the transport services in '
          + 'relation to them',
        effect: 'excluded by s.41(1); the ordinary rules decide',
      },
      {
        condition: 'the value of the goods is two-thirds or less of the total consideration',
        effect: 'the agreement stays a supply of services at the services rate',
      },
      {
        condition: 'the supply is construction to which s.16(3) applies',
        effect: 'excluded by s.41(4)',
      },
    ],
    crossReferences: ['VATCA 2010 s.41(3) (also applies to agreements for the supply of immovable goods)', 'VATCA 2010 s.47 (composite and multiple supplies)'],
    treatment: null,
    vatEffect: 'Where the movable goods provided under an agreement for services exceed two-thirds of its total '
      + 'consideration, the whole consideration is deemed referable to the goods and taxed at the goods\' rate '
      + '(s.41(1)). Which rate that is depends on the goods, so this rule flags the line rather than choosing.',
    accountingEffect: null,
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: "supply and fit" wording stands in for an agreement providing goods and services. '
      + 'The goods\' share of the price is not on the line: the rate is decided by a person, with the goods\' own '
      + 'schedule rule.',
  },
  {
    citation: 'VATCA 2010 s.45',
    sectionNumber: '45',
    ruleKey: CREDIT_NOTE_ADJUSTMENT_RULE_KEY,
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'A change in the tax chargeable is adjusted by credit note, never by editing the invoice (s.45(1), (3))',
    statementExcerpt: 'there shall be added to or deducted from the\n'
      + 'total amount of the consideration and any tax stated separately under the\n'
      + 'agreement an amount equal to the amount of the change in the tax chargeable',
    conditions: [desc('\\bcredit (notes?|memos?|invoices?)\\b')],
    exceptions: [
      {
        condition: 'the change happens after the tax fell due (s.74(1) or (2))',
        effect: 's.45(1) no longer applies; the adjustment follows the bad-debt or voluntary-relief provisions instead',
      },
    ],
    crossReferences: ['VATCA 2010 s.67 (credit notes for deduction)', 'VATCA 2010 s.87(6)–(7) (margin scheme: no credit notes)'],
    treatment: null,
    vatEffect: 'A credit note adjusts the consideration and the tax charged by the amount of the change (s.45(1)); '
      + 'VAT separately stated on an issued invoice is recoverable as part of the consideration (s.45(3)). The '
      + 'original invoice is never edited: the adjustment posts as its own document, and the VAT entries follow it.',
    accountingEffect: 'A credit note posts as a document of its own type with positive figures; the reversing entries '
      + 'carry the VAT adjustment.',
    reportingEffect: 'The adjustment lands in the return for the period it is issued in.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'Read from the line\'s "credit note" wording. A bad debt is a separate path: writeOffBadDebt '
      + 'flags the VAT in the written-off amount as possibly recoverable (invariant: VAT relief conditions are '
      + 'checked by a person).',
  },
];

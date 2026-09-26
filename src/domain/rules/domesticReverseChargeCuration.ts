/**
 * The domestic reverse charges of VATCA s.16 (issue #208).
 *
 * s.16(3) is the one that decides a treatment: construction operations
 * received by a principal to whom TCA 1997 s.530A applies are accounted for by
 * the principal (RC_CONSTRUCTION). Whether the company is such a principal is
 * recorded by a person on the company profile, from a date
 * (`companyIsRctPrincipal`); until it is, a construction purchase is flagged.
 *
 * The others turn on facts no transaction shows: whether the recipient deals in
 * scrap metal (s.16(4)), is connected with the builder (s.16(5), s.97(3)), is a
 * taxable dealer in gas or electricity (s.16(6)), or received emission
 * allowances or energy certificates (s.16(2), (7)). Each is bound to no
 * treatment and says why (`DOMESTIC_RC_GAPS`). NAMA vesting orders (s.16(1))
 * are not modelled: this company is neither NAMA nor a NAMA entity.
 */
import type { IrishRuleCondition } from '@/db/schema';
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';
const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });
const is = (field: string, value: string): IrishRuleCondition => ({ field, operator: 'equals', value });

export const RC_CONSTRUCTION_RULE_KEY = 'vat.domestic_reverse_charge_construction';
export const RC_CONSTRUCTION_UNRECORDED_RULE_KEY = 'vat.domestic_reverse_charge_construction_principal_unrecorded';
export const RC_CONSTRUCTION_SUPPLIED_RULE_KEY = 'vat.domestic_reverse_charge_construction_supplied';

/** Construction operations, TCA 1997 s.530(1)(a)-(f), as they are described on invoices. */
export const CONSTRUCTION_OPERATIONS = '\\b(construction|building works?|builders?|demolition|excavation|groundworks?|'
  + 'foundations?|plaster(ing|er)|plumb(ing|er)|electrical (installation|contracting|works?)|wiring|roofing|roofer|'
  + 'block ?laying|brick ?laying|carpentry|joinery|tiling|painting and decorating|site (clearance|preparation)|'
  + 'refurbishment|renovation|extension|fit[- ]?out|civil engineering|scaffold(ing)?|drainage works?|'
  + 'heating installation|insulation works?|glazing installation)\\b';

type Rule = Omit<CuratedVatScopeRule, 'ruleType' | 'topic' | 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'effectiveFrom' | 'treatment' | 'exceptions'>
  & Partial<Pick<CuratedVatScopeRule, 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'exceptions' | 'effectiveFrom'>>;
const rule = (r: Rule): CuratedVatScopeRule => ({
  ruleType: 'other', topic: 'vat_scope', crossReferences: [], accountingEffect: null, reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT, treatment: null, exceptions: [], ...r,
});

const S16 = { citation: '2010 Act 31 s.16', sectionNumber: '16' } as const;

export const DOMESTIC_RC_CURATED_RULES: CuratedVatScopeRule[] = [
  rule({
    ...S16, ruleKey: RC_CONSTRUCTION_RULE_KEY,
    name: 'Construction services received by an RCT principal: the principal accounts for the VAT (s.16(3))',
    statementExcerpt: 'receives services consisting of\nconstruction operations',
    conditions: [is('direction', 'purchase'), is('companyIsRctPrincipal', 'true'), desc(CONSTRUCTION_OPERATIONS)],
    exceptions: [
      {
        condition: 'the principal is one to whom TCA 1997 s.530A(1)(b)(ii) or (iii) applies (certain public bodies and '
          + 'State-funded bodies)',
        effect: 's.16(3) does not apply; the subcontractor charges VAT',
      },
      {
        condition: 'the work is not a construction operation within TCA 1997 s.530(1)(a)-(f) (e.g. an architect\'s or '
          + 'engineer\'s professional services, or goods delivered without installation)',
        effect: 'the supplier charges VAT in the ordinary way',
      },
    ],
    crossReferences: ['TCA 1997 s.530(1)', 'TCA 1997 s.530A', 'VATCA 2010 s.66(4)'],
    vatEffect: 'The subcontractor charges no VAT; the principal accounts for it in T1 and, where deductible, '
      + 'reclaims it in T2 in the same return.',
    reportingEffect: 'T1 and T2 on the VAT3.',
    interpretationNote: 'Requires the company\'s RCT principal status to be recorded on its profile, from a date. '
      + 'Whether the work is a construction operation is read from the invoice wording and is always confirmed by a '
      + 'person.',
  }),
  rule({
    ...S16, ruleKey: RC_CONSTRUCTION_UNRECORDED_RULE_KEY,
    name: 'Construction services received, company\'s RCT principal status not recorded',
    statementExcerpt: 'principal to whom\nsection\n530A',
    conditions: [is('direction', 'purchase'), is('companyRctPrincipalRecorded', 'false'), desc(CONSTRUCTION_OPERATIONS)],
    vatEffect: 'If the company is an RCT principal, it accounts for the VAT on construction services it receives '
      + '(s.16(3)); if not, the subcontractor charges VAT.',
    interpretationNote: 'Flags the line until the company\'s RCT principal status is recorded.',
  }),
  rule({
    ...S16, ruleKey: RC_CONSTRUCTION_SUPPLIED_RULE_KEY,
    name: 'Construction services supplied to a principal: the principal accounts for the VAT (s.16(3))',
    statementExcerpt: '(ii) the subcontractor\nshall not be accountable for or liable to pay such tax in respect of that supply.',
    conditions: [is('direction', 'sale'), desc(CONSTRUCTION_OPERATIONS)],
    vatEffect: 'If the customer is an RCT principal, it accounts for the VAT; the invoice charges none and states '
      + 'that the principal is liable (s.66(4)).',
    interpretationNote: 'Whether the customer is a principal is not recorded on the customer: the line is flagged.',
  }),
  rule({
    ...S16, ruleKey: 'vat.domestic_reverse_charge_scrap_metal',
    name: 'Scrap metal received by a dealer in scrap metal: the recipient accounts for the VAT (s.16(4))',
    statementExcerpt: 'he or she receives a supply of scrap\nmetal from another taxable person who carries on a business in the State',
    conditions: [is('direction', 'purchase'), desc('\\b(scrap (metal|iron|steel|copper|aluminium)|metal waste)\\b')],
    vatEffect: 'Where the recipient\'s business includes dealing in scrap metal, it accounts for the VAT.',
    interpretationNote: 'Whether the company deals in scrap metal is not recorded: the line is flagged.',
  }),
  rule({
    ...S16, ruleKey: 'vat.domestic_reverse_charge_connected_construction',
    name: 'Construction work supplied by a connected person: the recipient accounts for the VAT (s.16(5))',
    statementExcerpt: 'supplies construction work in the State to a taxable person (in\nthis subsection referred to as a '
      + '"recipient") to whom the accountable person is\nconnected',
    conditions: [is('direction', 'purchase'), desc(CONSTRUCTION_OPERATIONS)],
    crossReferences: ['VATCA 2010 s.97(3) (connected persons)'],
    vatEffect: 'Where the builder is connected with the company, the company accounts for the VAT.',
    interpretationNote: 'Whether the supplier is connected (s.97(3)) is not recorded; it matters only where s.16(3) '
      + 'does not already apply.',
  }),
  rule({
    ...S16, ruleKey: 'vat.domestic_reverse_charge_gas_electricity_dealer',
    name: 'Gas or electricity bought by a taxable dealer for resale: the dealer accounts for the VAT (s.16(6))',
    statementExcerpt: 'makes a supply of gas or of\nelectricity to a taxable dealer',
    conditions: [is('direction', 'purchase'), desc('\\b((gas|electricity) for resale|wholesale (gas|electricity|energy))\\b')],
    vatEffect: 'A taxable dealer in gas or electricity accounts for the VAT on its purchases for resale.',
    interpretationNote: 'Whether the company is a taxable dealer is not recorded: the line is flagged.',
  }),
  rule({
    ...S16, ruleKey: 'vat.domestic_reverse_charge_energy_certificates',
    name: 'Gas or electricity certificates: the recipient accounts for the VAT (s.16(7))',
    statementExcerpt: 'makes a supply of a gas or an\nelectricity certificate',
    conditions: [is('direction', 'purchase'), desc('\\b(guarantees? of origin|(gas|electricity|energy|renewable) certificates?)\\b')],
    vatEffect: 'The business receiving the certificate accounts for the VAT.',
    interpretationNote: 'No treatment is configured for this reverse charge: the line is flagged.',
  }),
  rule({
    ...S16, ruleKey: 'vat.domestic_reverse_charge_emission_allowances',
    name: 'Greenhouse gas emission allowances: the recipient accounts for the VAT (s.16(2))',
    statementExcerpt: 'receives greenhouse gas emission allowances from\nanother taxable person',
    conditions: [is('direction', 'purchase'), desc('\\b(emissions? allowances?|carbon (credits?|allowances?)|EUAs?)\\b')],
    vatEffect: 'The business receiving the allowances accounts for the VAT.',
    interpretationNote: 'No treatment is configured for this reverse charge: the line is flagged.',
  }),
];

/**
 * s.16 rules that never decide: they add their reason to whatever rule does
 * decide, and stop an invoice line being pre-selected, because the fact they
 * turn on (the company's or the customer's principal status, a connected builder)
 * is not recorded.
 */
export const DOMESTIC_RC_ADVISORY_RULE_KEYS = [
  RC_CONSTRUCTION_UNRECORDED_RULE_KEY, RC_CONSTRUCTION_SUPPLIED_RULE_KEY, 'vat.domestic_reverse_charge_connected_construction',
] as const;

/** Why each flag-only s.16 rule leaves the choice to a person. */
export const DOMESTIC_RC_GAPS: Record<string, string> = {
  [RC_CONSTRUCTION_UNRECORDED_RULE_KEY]: 'This looks like construction work. If the company is a principal for RCT '
    + '(TCA 1997 s.530A), it accounts for the VAT itself (RC_CONSTRUCTION, s.16(3)) and the subcontractor should '
    + 'charge none. Record the company\'s RCT principal status on its profile.',
  [RC_CONSTRUCTION_SUPPLIED_RULE_KEY]: 'This looks like construction work sold. If the customer is a principal for '
    + 'RCT, it accounts for the VAT (s.16(3)): the invoice charges none and states that the principal is liable. '
    + 'Otherwise charge VAT at the rate for the work. Confirm which.',
  'vat.domestic_reverse_charge_scrap_metal': 'If the company deals in scrap metal, it accounts for the VAT on scrap '
    + 'it buys (s.16(4)). RC_CONSTRUCTION has the same VAT3 effect (T1 and T2); choose it only if s.16(4) applies.',
  'vat.domestic_reverse_charge_connected_construction': 'Construction work from a connected builder (s.97(3)) is '
    + 'reverse-charged (s.16(5)). Whether the builder is connected is not recorded: confirm it.',
  'vat.domestic_reverse_charge_gas_electricity_dealer': 'Gas or electricity bought for resale by a taxable dealer '
    + 'is reverse-charged (s.16(6)). Confirm the company is such a dealer.',
  'vat.domestic_reverse_charge_energy_certificates': 'The recipient of a gas or electricity certificate accounts '
    + 'for the VAT (s.16(7)). No treatment is configured for it: record it with your adviser.',
  'vat.domestic_reverse_charge_emission_allowances': 'The recipient of emission allowances accounts for the VAT '
    + '(s.16(2)). No treatment is configured for it: record it with your adviser.',
};

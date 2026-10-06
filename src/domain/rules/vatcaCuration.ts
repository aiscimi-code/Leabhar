/**
 * Curated rules for VATCA 2010 (docs/RULES_KB.md "VATCA 2010").
 *
 * Unlike the Finance Act 2024 curation (`factExtractor.ts`), which mechanically
 * regexes a provision for a stated €/%/year figure, VATCA mostly states
 * *conditional rules*, not bare facts — "if a taxable person receives a
 * service from a supplier established outside the State... the recipient is
 * accountable for the tax." Encoding that as a `conditions` array is
 * necessarily an interpretive act: a human (here, the agent building this
 * pass) reads the provision and maps its legal test onto
 * `TransactionContext` fields. That is categorically different from finding
 * "€27,382" in a sentence, and is recorded as such — every curated rule below
 * carries `interpretationNote` explaining the mapping and its limits, ships
 * with `provenanceStatus: 'ai_suggestion'` (not `'system_rule'`) and lower
 * `confidence` than the mechanical Finance Act figures, and every condition
 * is a genuine textual element of the provision (an invoice requirement, a
 * supplier-location test), never an invented simplification of one.
 *
 * `statementExcerpt` is always a verbatim substring of the provision's own
 * `provisionText` (checked against `vatcaParser.ts` output, not retyped from
 * memory) — the same "never paraphrase into the authoritative field" rule
 * `factExtractor.ts` follows.
 *
 * Deliberately NOT curated: VATCA s.46 (rates of tax) states 21%/13.5%/4.8%/
 * 0% as ENACTED in 2010 — the standard rate has since been amended by Finance
 * Acts not ingested into this KB (it is 23% at the time of writing). Curating
 * that figure as a live, undated-`effectiveTo` rule would let a *current*
 * transaction resolve against a *stale* rate with no signal that it is
 * wrong — worse than surfacing no rule at all. See docs/RULES_KB.md
 * "Limitations".
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/**
 * `vat.input_deduction_general`'s own curated `exceptions` array already
 * records that the s.60(2)(a) exclusions below override it ("no deduction
 * regardless of business purpose"), but until issue #143 finding D,
 * `transactionLookup.ts` only surfaced that as review-reason prose — a
 * matching transaction still carried BOTH `vat.input_deduction_general`
 * ("deductible") and `vat.deduction_exclusions_entertainment` ("no
 * deduction") side by side. These two constants are what
 * `resolveDeductionExclusivity` (transactionLookup.ts) uses to drop the
 * general rule whenever any exclusion rule below also matched.
 */
// Issue #209: the as-enacted s.59/s.60 rules were replaced by the revised
// ones in inputRecoveryCuration.ts, which splits s.60(2)(a) by category.
export {
  INPUT_DEDUCTION_RULE_KEY as VAT_GENERAL_DEDUCTION_RULE_KEY,
  BLOCKED_DEDUCTION_RULE_KEYS as VAT_DEDUCTION_EXCLUSION_RULE_KEYS,
} from './inputRecoveryCuration';

export interface CuratedVatcaRule {
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
}

export const CONTRACT_WORK_RULE_KEY = 'vat.rate_contract_work_follows_goods';

/** The s.49 rule never decides a rate: the goods handed over decide it. Surfaced by `advisoryReasons`. */
export const CONTRACT_WORK_ADVISORY_REASON = 'Contract work is charged at the rate the goods handed over would '
  + 'carry (VATCA s.49): zero-rated goods make it zero-rated, reduced-rate goods 13.5%, others the standard rate. '
  + 'Which goods those are is not on the line — pick their schedule rule with your adviser.';

export const WORKS_OF_ART_RULE_KEY = 'vat.rate_works_of_art_imported';

/**
 * The s.48 rule never decides a rate: the reduced rate applies to the
 * importation and to a supply by the creator or the importer, and neither
 * fact is on a line. A resale by anyone else is standard-rated or under the
 * margin or auction scheme. Surfaced by `advisoryReasons`.
 */
export const WORKS_OF_ART_ADVISORY_REASON = 'The line may be a work of art, collector\'s item or antique (VATCA '
  + 's.48, Schedule 5): the reduced rate applies only to its importation and to a supply by its creator or '
  + 'importer. A resale by anyone else is standard-rated, or under the margin or auction scheme. Who is '
  + 'supplying it is not on the line — confirm the rate with your adviser.';

export const VATCA_CURATED_RULES: CuratedVatcaRule[] = [
  {
    sectionNumber: '3',
    ruleKey: 'vat.charge_general',
    ruleType: 'other',
    topic: 'vat',
    name: 'General charge to VAT',
    statementExcerpt: 'called value-added tax is, subject to and in accordance with this Act\n'
      + 'and regulations, chargeable, leviable and payable on the following\ntransactions:\n'
      + '( a ) the supply for consideration of goods by a taxable person\nacting in that capacity '
      + 'when the place of supply is the\nState;',
    conditions: [],
    exceptions: [],
    vatEffect: 'VAT is chargeable on a supply of goods or services for consideration by a taxable '
      + 'person acting as such, where the place of supply is the State (foundational rule — which '
      + 'specific treatment applies still depends on place of supply, rate, exemption and deduction rules elsewhere in the Act).',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Foundational/declaratory: this is the charging provision every other VAT '
      + 'rule qualifies. It carries no conditions because it is not itself a test on a transaction '
      + 'attribute — it states that VAT applies at all. Always requires guidance because whether a '
      + 'specific transaction is actually within charge depends on the exemption (Schedule 1), '
      + 'zero-rate (Schedule 2) and other provisions not curated in this pass.',
  },
  {
    sectionNumber: '12',
    ruleKey: 'vat.reverse_charge_services_from_abroad',
    ruleType: 'other',
    topic: 'vat',
    name: 'Reverse charge: services received from a supplier established outside the State',
    // Verbatim from provisionText.
    statementExcerpt: '12 .—(1) Where—\n( a ) a taxable person who carries on a business in the State, or '
      + 'a person to whom a registration number has been\nassigned in accordance with section 65(2) , '
      + 'receives a service from a supplier established outside the State, and\n( b ) the place of '
      + 'supply of the service (as determined in accord-\nance with section 34(a) ) is the State,\nthen '
      + 'the person is accountable for, and liable to pay, the tax charge-\nable in the State as if he '
      + 'or she had supplied that service for consider-\nation in the course or furtherance of business.',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'supplierEstablishedOutsideStateResolved', operator: 'equals', value: 'true' },
      { field: 'vatRegistered', operator: 'equals', value: 'true' },
    ],
    exceptions: [],
    vatEffect: 'The RECIPIENT (not the overseas supplier) is accountable for, and liable to pay, '
      + 'Irish VAT on the supply, as if the recipient had supplied it themself (the reverse charge). '
      + 'The recipient self-accounts for output VAT on the reverse charge and may recover it as '
      + 'input VAT in the same period, subject to the general deductibility rule '
      + '(vat.input_deduction_general) and its exclusions (vat.deduction_exclusions_entertainment) — '
      + 'usually a net-nil cash effect where the expense is fully deductible.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: '"supplier established outside the State" is mapped onto '
      + '`supplierEstablishedOutsideStateResolved` (`transactionLookup.ts`\'s `normaliseTransactionContext`) — '
      + 'the caller\'s own direct determination when supplied (the actual multi-factor test: EU Reg 282/2011 '
      + 'arts.10-11, seat of economic activity / fixed establishment — see '
      + 'catalogue/eu-282-2011/consolidated-2025-04-14.json), falling back to an ISO-3166-validated '
      + '`supplierCountry != \'IE\'` proxy only when no direct determination is given (a supplier can be '
      + 'established in Ireland while invoicing from elsewhere, or vice versa; establishment, not invoicing '
      + 'address, is the statutory test — issue #136 bug 4 / #138). An unresolved or invalid country code no '
      + 'longer defaults to "abroad": it leaves the field unresolved instead. "a taxable person who carries on '
      + 'a business in the State" '
      + 'is mapped onto `vatRegistered = true`, which is necessary but not sufficient (the section '
      + 'also covers unregistered persons with a registration number under s.65(2), not modelled '
      + 'here). requiresGuidance is set because subsections (2)–(6) carry further conditions '
      + '(a different rule for non-taxable-person recipients, elections under (4)/(6)) this rule '
      + 'does not evaluate.',
  },
  {
    sectionNumber: '34',
    ruleKey: 'vat.place_of_supply_b2b_general',
    ruleType: 'other',
    topic: 'vat',
    name: 'Place of supply of services to a taxable person (general B2B rule)',
    statementExcerpt: '( a ) except as provided by paragraphs (c) , (d) , (g) , (i) , (j) and\n(k) , '
      + 'the place of supply of services to a taxable person\nacting as such is—\n(i) subject to '
      + 'subparagraph (ii) , the place where the per-\nson’s business is established,',
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
    ],
    exceptions: [
      {
        condition: 'the supply is connected with immovable goods, passenger transport, or the '
          + 'other specific cases in section 34 paragraphs (c), (d), (g), (i), (j) and (k)',
        effect: 'the general rule does not apply; a different place-of-supply paragraph governs instead',
      },
    ],
    vatEffect: 'Unless one of the listed exceptions applies, the place of supply of a service to a '
      + 'taxable person is where that person’s business is established — for an Irish-established '
      + 'recipient, the place of supply is the State.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'This rule only checks `supplyType = services`; it cannot evaluate whether '
      + 'the transaction falls into one of the excepted categories in paragraphs (c)/(d)/(g)/(i)/(j)/(k) '
      + '(immovable goods, passenger transport, restaurant/catering, short-term hiring of means of '
      + 'transport, electronically-supplied services to non-taxable persons, and others) — those '
      + 'require reading the transaction description against each paragraph, which is exactly the '
      + 'kind of judgement this system flags for human review rather than silently assumes.',
  },
  {
    sectionNumber: '48',
    ruleKey: WORKS_OF_ART_RULE_KEY,
    ruleType: 'rate',
    topic: 'vat',
    name: 'Works of art, collectors\' items and antiques: charged at the reduced rate (s.48(1), Schedule 5)',
    statementExcerpt: 'tax shall be charged at the\n'
      + 'rate specified in section 46(1)(c) of the amount on which tax is\n'
      + 'chargeable in relation to',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\b(work of art|works of art|painting|watercolou?r|sculpture|statue|tapestry|ceramic|enamel|'
          + "antiques?|collectors?['\\u2019]? items?|first[- ]day covers?|stamp collections?|philatelic|numismatic)\\b",
      },
    ],
    exceptions: [
      {
        condition: 'a supply by a taxable dealer (Sch.5 para 1 goods bought and sold in the course of dealing), or a '
          + 'supply under the margin scheme (s.87)',
        effect: 'the margin scheme governs instead; no VAT is shown (vat.margin_scheme_goods_purchase)',
      },
      {
        condition: 'the item is not of a kind specified in Schedule 5 (a print that is a mass-produced reproduction, '
          + 'jewellery, an article under 100 years old claimed as an antique)',
        effect: 'not within Schedule 5; the standard rate applies',
      },
    ],
    vatEffect: 'The importation, and a supply by the creator or (occasionally) by the importer, of goods specified in '
      + 'Schedule 5 — works of art, collectors\' items and antiques — is charged at the reduced rate (s.48(1)), '
      + 'not the standard rate.',
    accountingEffect: null,
    reportingEffect: 'Output VAT at the reduced rate lands in the same T1/T2 boxes as any other taxable supply.',
    requiresGuidance: true,
    interpretationNote: 'PROXY: art/collectible wording stands in for a Schedule 5 category. Which category the item '
      + 'falls into, and whether the seller is its creator or importer (s.48(1)(b)–(c)), is not on the line, so '
      + 'the rule flags and never decides: words like "painting" or "ceramic" also describe decorating work and '
      + 'ordinary goods at the standard rate.',
  },
  {
    sectionNumber: '49',
    ruleKey: CONTRACT_WORK_RULE_KEY,
    ruleType: 'rate',
    topic: 'vat',
    name: 'Contract work: charged at the rate of the goods handed over (s.49(1))',
    statementExcerpt: 'the rate at which tax is chargeable on a supply of contract work\n'
      + 'shall be the rate that would be chargeable if that supply of services\n'
      + 'were a supply of the goods being handed over by the contractor to',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\bcontract work\\b|\\b(made|manufactured|built) to (order|specification)\\b',
      },
    ],
    exceptions: [
      {
        condition: 'the supply is in the circumstances specified in paragraph (xvi) of the Second Schedule '
          + '(s.49(2)); immovable goods and construction services are not contract work',
        effect: 's.49(1) does not apply; the ordinary rate rules govern',
      },
    ],
    vatEffect: 'A supply of contract work is charged at the rate the goods handed over would carry: a joiner making '
      + 'and fitting zero-rated Sch.2 para 8 goods charges 0%; goods at the reduced rate carry 13.5%; others the '
      + 'standard rate. The rule flags the line; the goods\' own schedule rule decides the rate.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'PROXY: "contract work" wording stands in for s.49. Which goods are handed over, and so '
      + 'which rate applies, is not on the line: the person picks the goods\' schedule rule; nothing is decided '
      + 'automatically (see also the two-thirds rule, s.41).',
  },
];

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
      + 'docs/statutes/282-2011/articles-10-13b-establishment.md), falling back to an ISO-3166-validated '
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
];

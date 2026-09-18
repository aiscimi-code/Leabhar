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
      { field: 'supplierCountry', operator: 'not_equals', value: 'IE' },
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
      + '`supplierCountry != \'IE\'` — a reasonable but imperfect proxy (a supplier can be established '
      + 'in Ireland while invoicing from elsewhere, or vice versa; establishment, not invoicing '
      + 'address, is the statutory test). "a taxable person who carries on a business in the State" '
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
    sectionNumber: '59',
    ruleKey: 'vat.input_deduction_general',
    ruleType: 'deductibility',
    topic: 'vat',
    name: 'General deduction for VAT borne or paid',
    statementExcerpt: 'that person may, in so far as the goods and services are used by him or her '
      + 'for the purposes of his or her taxable supplies or of any of the qualifying activities, deduct—'
      + '\n( a ) the tax charged to him or her during the period by other accountable persons by '
      + 'means of invoices, prepared in the manner prescribed by regulations, in respect of sup-\n'
      + 'plies of goods or services to him or her',
    conditions: [
      { field: 'vatRegistered', operator: 'equals', value: 'true' },
      { field: 'invoiceAvailable', operator: 'equals', value: 'true' },
      { field: 'businessUsePercent', operator: 'gt', value: 0 },
    ],
    exceptions: [
      {
        condition: 'the expenditure is of a kind listed in section 60(2)(a) (food/drink/'
          + 'accommodation/entertainment, most motor vehicles, petrol)',
        effect: 'no deduction regardless of business purpose — see vat.deduction_exclusions_entertainment',
      },
    ],
    vatEffect: 'VAT charged by another accountable person, evidenced by an invoice, on goods or '
      + 'services used for the accountable person’s taxable supplies is deductible as input VAT — '
      + 'subject to the section 60(2)(a) exclusions.',
    accountingEffect: null,
    reportingEffect: 'Deductible input VAT is included in the VAT3 return’s T2 figure for the period.',
    requiresGuidance: false,
    interpretationNote: '`invoiceAvailable = true` is a direct textual match ("by means of invoices, '
      + 'prepared in the manner prescribed by regulations") rather than a proxy. `businessUsePercent > 0` '
      + 'stands in for "used... for the purposes of his or her taxable supplies", which in reality is '
      + 'not a simple percentage test (apportionment rules, partial exemption, and the qualifying-'
      + 'activities list in subsection (1) all bear on it) — treated here as the closest available '
      + 'TransactionContext field, not as a full restatement of the test.',
  },
  {
    sectionNumber: '60',
    ruleKey: 'vat.deduction_exclusions_entertainment',
    ruleType: 'deductibility',
    topic: 'business_expense',
    name: 'Deduction excluded: food, drink, accommodation, entertainment, most motor vehicles, petrol',
    statementExcerpt: '(2) ( a ) Notwithstanding anything in this Chapter, a deduction of\ntax under '
      + 'this Chapter shall not be made if, and to the\nextent that, the tax relates to—\n(i) '
      + 'expenditure incurred by the accountable person on\nfood or drink, or accommodation (other '
      + 'than quali-\nfying accommodation in connection with attendance\nat a qualifying conference), '
      + 'or other personal\nservices, for the accountable person, the accountable\nperson’s agents '
      + 'or employees',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '(food|drink|meal|restaurant|catering|entertainment|hospitality|\\bhotel\\b|accommodation|petrol|\\bfuel\\b)',
      },
    ],
    exceptions: [
      {
        condition: 'qualifying accommodation in connection with attendance at a qualifying '
          + 'conference (50+ delegates, as defined in section 60(1))',
        effect: 'the food/drink/accommodation exclusion in paragraph (a)(i) does not apply to that '
          + 'qualifying accommodation expenditure',
      },
      {
        condition: 'motor vehicle purchase/hire/acquisition for stock-in-trade, a vehicle-hiring '
          + 'business, or driving-school instruction (section 60(2)(a)(iv))',
        effect: 'the motor-vehicle exclusion does not apply; ordinary deduction (or the partial '
          + 'section 59(2)(d) deduction for qualifying vehicles) may apply instead',
      },
    ],
    vatEffect: 'No VAT deduction is available for expenditure on food, drink, accommodation, other '
      + 'personal services, entertainment, most motor vehicles, or petrol — even where the general '
      + 'section 59 test (used for taxable supplies) is otherwise met — unless a listed exception applies.',
    accountingEffect: 'The VAT element of an excluded expense is a cost, not a recoverable asset — '
      + 'book the gross (VAT-inclusive) amount as the expense.',
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'The condition is a keyword match on the transaction description, not a '
      + 'reading of the actual supply — a transaction merely mentioning "hotel" is not necessarily '
      + 'within the exclusion (e.g. a hotel booking that IS qualifying-conference accommodation is '
      + 'excepted), and a transaction that IS within the exclusion may not use any of these words. '
      + 'This rule flags candidates for review; it does not classify them. requiresGuidance is '
      + 'always true for this reason.',
  },
];

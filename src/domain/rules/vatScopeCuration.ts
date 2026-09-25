/**
 * Curated exempt and outside-the-scope rules (issue #200 step 5, first pass).
 *
 * Until these existed the knowledge base held no rule that could say "this is
 * not standard-rated" for the commonest non-VATable lines in a small
 * business's bank statement — bank charges, insurance, rent, train fares,
 * postage, wages, tax payments, capital introduced — so the statutory
 * suggestion fell through to the 23% residual rule for every one of them
 * (issue #200: insurance and bank charges came back as 23%).
 *
 * Two kinds of rule, from two kinds of source, both LRC-revised VATCA text:
 *
 *  - EXEMPT (Schedule 1, `2010 Act 31 Sch.1`). A supply that is within the
 *    scope of VAT but is an "exempted activity" (s.2(1)): no VAT is charged
 *    and input VAT on the related costs is not deductible. Only the five
 *    paragraphs an ordinary SME meets week to week are curated here: postal
 *    services (para 1), bank account and payment services (para 6(1)(c)),
 *    insurance (para 8), letting of immovable goods (para 11) and passenger
 *    transport (para 14(3)). Credit is deliberately NOT curated: para 6(1)(a)
 *    — the limb that used to cover granting credit — reads "…" (repealed) in
 *    the ingested text, so this KB holds no verbatim basis for treating loan
 *    interest as exempt and says nothing rather than guess.
 *
 *  - OUTSIDE THE SCOPE (s.2 and s.3). s.3 lists every transaction VAT is
 *    charged on — a supply for consideration by a taxable person, an
 *    importation, an intra-Community acquisition — and s.2(1) defines a
 *    "taxable person" as one who carries on a business "independently",
 *    which it says excludes an employee. A line that is none of those is not
 *    exempt: it is outside VAT altogether. That is the statutory test; which
 *    specific money movements fail it (share capital, loans, dividends) is
 *    settled in CJEU case law this KB does not ingest, so every one of these
 *    rules carries `requiresGuidance: true` and names that gap.
 *
 * Every condition that matches the bank description is a PROXY for the legal
 * test (issue #199): a description that says "insurance" is a candidate for
 * the Schedule 1 para 8 exemption, not proof of it. `interpretationNote` names
 * the list or test each proxy stands in for. `direction` is the one
 * structured fact these rules can rely on — the sign of the bank amount.
 *
 * `effectiveFrom` is the Act's commencement (2010-11-01) for all nine rules,
 * the same known limitation #199 records for the Schedule 2/3 rules: the
 * consolidated text has no per-paragraph commencement date. Where the
 * current wording visibly post-dates 2010 (para 11's "emergency
 * accommodation") the interpretation note says so.
 *
 * Every `statementExcerpt` must be a verbatim substring of its provision's
 * `provisionText`; `deriveVatScopeRules` refuses (and reports) any that is not.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export type VatScopeTreatment = 'IE_EXEMPT' | 'OUT_OF_SCOPE';

export interface CuratedVatScopeRule {
  /** Source citation, as ingested. */
  citation: '2010 Act 31 Sch.1' | '2010 Act 31 s.2' | '2010 Act 31 s.3' | '2010 Act 31 s.34';
  /** Schedule paragraph or section number, matched against `irish_act_provisions.section_number`. */
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: 'vat_scope';
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  crossReferences: string[];
  /** The treatment the rule decides, or null where vatSuggestion.ts decides it from context
   *  (place-of-supply rules, vatPlaceOfSupplyCuration.ts). */
  treatment: VatScopeTreatment | null;
  vatEffect: string;
  accountingEffect: string | null;
  reportingEffect: string | null;
  effectiveFrom: string;
  interpretationNote: string;
}

const EXEMPT_EFFECT_SUFFIX = ' No VAT is charged, and input VAT on costs of making an exempt supply is not deductible '
  + '(it is an "exempted activity", s.2(1)) — unlike a zero-rated supply.';

const VATCA_COMMENCEMENT = '2010-11-01';

export const VAT_SCOPE_CURATED_RULES: CuratedVatScopeRule[] = [
  // --- Exempt: Schedule 1 -------------------------------------------------
  {
    citation: '2010 Act 31 Sch.1',
    sectionNumber: '6',
    ruleKey: 'vat.exempt_bank_account_and_payment_services',
    ruleType: 'exemption',
    topic: 'vat_scope',
    name: 'Exempt: operating a bank account and dealing in payments and transfers',
    statementExcerpt: 'operating a current, deposit or savings account, and negotiating or dealing in payments,\n'
      + 'transfers, debts, cheques and other negotiable instruments, but excluding debt collecting\nand factoring',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(bank (charges?|fees?)|account (fees?|charges?|maintenance)|maintenance fee|'
          + 'transaction (fees?|charges?)|transfer (fees?|charges?)|quarterly (fees?|charges?)|'
          + 'sepa (fees?|charges?)|cheque (fees?|charges?)|standing order (fees?|charges?))\\b',
      },
    ],
    exceptions: [
      {
        condition: 'the charge is for debt collecting or factoring',
        effect: 'excluded from para 6(1)(c) by its own words; not exempt under this paragraph',
      },
      {
        condition: 'the charge is a card-acquiring / merchant-service fee rather than a charge for operating the account',
        effect: 'para 6(1)(h) (card schemes), not 6(1)(c), is the relevant limb — not curated here',
      },
      {
        condition: 'the charge is interest on a loan or overdraft',
        effect: 'not covered: the credit limb, para 6(1)(a), reads "…" (repealed) in the ingested text, '
          + 'so this KB has no rule for it',
      },
    ],
    crossReferences: ['VATCA 2010 s.2(1) "exempted activity"', 'VATCA 2010 Sch.1 para 6(1)(h)'],
    treatment: 'IE_EXEMPT',
    vatEffect: 'Charges for operating a bank account and for making payments and transfers are exempt (Schedule 1 '
      + 'para 6(1)(c)).' + EXEMPT_EFFECT_SUFFIX,
    accountingEffect: 'Book the full amount as bank charges; there is no VAT to reclaim.',
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: a description keyword ("bank charges", "account fee", "transfer fee"…) stands in for '
      + 'para 6(1)(c)\'s legal test (the service is operating an account or dealing in payments/transfers). '
      + 'Direction is required to be a purchase: the company is receiving the service.',
  },
  {
    citation: '2010 Act 31 Sch.1',
    sectionNumber: '8',
    ruleKey: 'vat.exempt_insurance',
    ruleType: 'exemption',
    topic: 'vat_scope',
    name: 'Exempt: insurance and reinsurance, and related broker/agent services',
    statementExcerpt: 'Insurance and reinsurance transactions, and the supply of related services by\n'
      + 'insurance brokers and insurance agents.',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      { field: 'description', operator: 'matches', value: '\\b(insurance|assurance|insurer|reinsurance)\\b' },
    ],
    exceptions: [
      {
        condition: 'the payment is to a broker or agent for a service that is not a "related service" as para 8(2) '
          + 'describes it (collecting premiums, selling insurance, delegated claims handling)',
        effect: 'the broker/agent service is not within para 8 and may be taxable',
      },
    ],
    crossReferences: ['VATCA 2010 s.2(1) "exempted activity"'],
    treatment: 'IE_EXEMPT',
    vatEffect: 'Insurance premiums, and related services of insurance brokers and agents, are exempt (Schedule 1 '
      + 'para 8).' + EXEMPT_EFFECT_SUFFIX,
    accountingEffect: 'Book the full premium as insurance expense (or a prepayment); there is no VAT to reclaim.',
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: the words "insurance/assurance/insurer" stand in for para 8(1)\'s test (an insurance '
      + 'or reinsurance transaction, or a related broker/agent service within para 8(2)).',
  },
  {
    citation: '2010 Act 31 Sch.1',
    sectionNumber: '11',
    ruleKey: 'vat.exempt_letting_immovable_goods',
    ruleType: 'exemption',
    topic: 'vat_scope',
    name: 'Exempt: letting of immovable goods (property rent)',
    statementExcerpt: 'The letting of immovable\ngoods\n, including a letting of\nemergency accommodation, but excluding any of the\nfollowing:',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\b(rent|letting)\\b|\\brental of (office|premises|unit|shop|warehouse|property)\\b',
      },
    ],
    exceptions: [
      { condition: 'letting machinery or a business installation separately', effect: 'excluded by para 11(1)(a); taxable' },
      {
        condition: 'holiday or guest accommodation of the kind in Schedule 3 para 11 (hotels, guesthouses, holiday lets)',
        effect: 'excluded by para 11(1)(b) (unless used as emergency accommodation); reduced/second-reduced rate instead',
      },
      { condition: 'providing sporting facilities (Schedule 3 para 12)', effect: 'excluded by para 11(1)(c)' },
      { condition: 'car-park operators providing vehicle parking', effect: 'excluded by para 11(1)(d); taxable' },
      { condition: 'hiring safes', effect: 'excluded by para 11(1)(e); taxable' },
      {
        condition: 'the landlord has exercised a landlord\'s option to tax the letting',
        effect: 'the letting is taxable and the invoice will show VAT — the option-to-tax provision (VATCA s.97) is '
          + 'not ingested in this KB, so this rule cannot detect it',
      },
    ],
    crossReferences: ['VATCA 2010 s.97 (landlord\'s option to tax — not ingested)', 'VATCA 2010 Sch.3 paras 11, 12'],
    treatment: 'IE_EXEMPT',
    vatEffect: 'The letting of property is exempt (Schedule 1 para 11) unless one of the listed exclusions applies or '
      + 'the landlord has opted to tax it.' + EXEMPT_EFFECT_SUFFIX,
    accountingEffect: 'Book the full rent as rent expense (or rental income for a letting you make); no VAT arises '
      + 'unless the invoice shows the landlord opted to tax.',
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: "rent/letting" in the description stands in for para 11(1)\'s test (a letting of '
      + 'immovable goods, outside the (a)–(e) exclusions). Either direction: rent paid or rent received. The '
      + 'current wording ("including a letting of emergency accommodation") is later than 2010; the 2010-11-01 '
      + 'effectiveFrom is the Act\'s commencement, not that wording\'s (issue #199).',
  },
  {
    citation: '2010 Act 31 Sch.1',
    sectionNumber: '14',
    ruleKey: 'vat.exempt_passenger_transport',
    ruleType: 'exemption',
    topic: 'vat_scope',
    name: 'Exempt: transporting passengers and their baggage',
    statementExcerpt: '(3) Transporting passengers and their accompanying baggage.',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(train|rail|iarnr[oó]d|dart|luas|bus|taxi|cab fare|ferry)\\b',
      },
    ],
    exceptions: [
      {
        condition: 'the payment is for hiring a vehicle, or for transporting goods rather than passengers',
        effect: 'not passenger transport; para 14(3) does not apply',
      },
    ],
    crossReferences: ['VATCA 2010 Sch.1 para 14 ("Exemptions by derogation in accordance with Article 371 of the VAT Directive")'],
    treatment: 'IE_EXEMPT',
    vatEffect: 'Passenger transport (train, bus, taxi, ferry fares) is exempt (Schedule 1 para 14(3)).'
      + EXEMPT_EFFECT_SUFFIX,
    accountingEffect: 'Book the full fare as travel expense; there is no VAT to reclaim.',
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: transport-operator and fare keywords stand in for para 14(3)\'s test (the supply is '
      + 'transporting passengers). Air travel is deliberately not in the keyword list: this KB has not ingested '
      + 'the rules that distinguish domestic and international passenger air transport.',
  },
  {
    citation: '2010 Act 31 Sch.1',
    sectionNumber: '1',
    ruleKey: 'vat.exempt_postal_universal_service',
    ruleType: 'exemption',
    topic: 'vat_scope',
    name: 'Exempt: public postal services under the universal service',
    statementExcerpt: 'Public postal services, including\nthe supply of goods and services incidental to their provision, '
      + 'which are provided\nas\npart of a universal service',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      { field: 'description', operator: 'matches', value: '\\ban post\\b|\\bpostage\\b|\\bstamps?\\b' },
    ],
    exceptions: [
      {
        condition: 'the postal service is supplied on individually negotiated terms (e.g. a business contract rate)',
        effect: 'para 1 applies "only if that supply is not on terms that have been individually negotiated"; taxable',
      },
      {
        condition: 'the supplier is a courier or parcel company, not An Post or another designated universal-service provider',
        effect: 'not a universal postal service; taxable',
      },
    ],
    crossReferences: [],
    treatment: 'IE_EXEMPT',
    vatEffect: 'Public postal services provided as part of the universal service (An Post stamps and standard '
      + 'postage) are exempt (Schedule 1 para 1).' + EXEMPT_EFFECT_SUFFIX,
    accountingEffect: 'Book the full amount as postage; there is no VAT to reclaim.',
    reportingEffect: null,
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: "An Post/postage/stamps" stands in for para 1\'s test (a universal-service postal '
      + 'supply by An Post or a designated provider, not on individually negotiated terms).',
  },

  // --- Outside the scope: s.2(1) and s.3 ----------------------------------
  {
    citation: '2010 Act 31 s.2',
    sectionNumber: '2',
    ruleKey: 'vat.outside_scope_employment',
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Outside the scope: wages and salaries paid to employees',
    statementExcerpt: '“independently”, in relation to a taxable person, excludes a person who is\n'
      + 'employed or who is bound to an employer by a contract of employment',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      { field: 'description', operator: 'matches', value: '\\b(salary|salaries|wages?|payroll|net pay)\\b' },
    ],
    exceptions: [
      {
        condition: 'the payee is a self-employed contractor invoicing for services, not an employee',
        effect: 'a contractor carries on a business independently and may be a taxable person; the invoice decides',
      },
    ],
    crossReferences: ['VATCA 2010 s.2(1) "taxable person"', 'VATCA 2010 s.3'],
    treatment: 'OUT_OF_SCOPE',
    vatEffect: 'An employee does not carry on a business "independently" (s.2(1)), so is not a taxable person and '
      + 'makes no supply within s.3. Wages and salaries are outside the scope of VAT.',
    accountingEffect: 'Book to wages/net pay (payroll taxes are separate lines); no VAT arises.',
    reportingEffect: 'Not reported on the VAT3 return.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: payroll keywords stand in for the legal test (the payee is bound by a contract of '
      + 'employment, s.2(1) "independently").',
  },
  {
    citation: '2010 Act 31 s.3',
    sectionNumber: '3',
    ruleKey: 'vat.outside_scope_tax_payment',
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Outside the scope: tax paid to or refunded by Revenue',
    statementExcerpt: 'a tax called value-added tax is, subject\nto and in accordance with this Act and regulations, '
      + 'chargeable, leviable and payable\non the following transactions:',
    conditions: [
      { field: 'description', operator: 'matches', value: '\\b(revenue|collector[ -]general|ros)\\b' },
      {
        field: 'description', operator: 'matches',
        value: '\\b(vat3?|paye|prsi|usc|ct1?|corporation tax|preliminary tax|income tax|rct|lpt|cgt)\\b',
      },
    ],
    exceptions: [],
    crossReferences: ['VATCA 2010 s.3(a)–(e)'],
    treatment: 'OUT_OF_SCOPE',
    vatEffect: 'Paying tax to Revenue (or receiving a refund) is not consideration for a supply of goods or services, '
      + 'an importation or an intra-Community acquisition — none of the transactions s.3 charges VAT on. It is '
      + 'outside the scope of VAT.',
    accountingEffect: 'Book against the relevant tax liability account (VAT, PAYE/PRSI/USC, corporation tax), '
      + 'not to an expense.',
    reportingEffect: 'Not a VAT3 box entry itself; a VAT payment settles the liability the return declared.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: requires both a Revenue keyword and a tax-head keyword in the description. The '
      + 'legal test is s.3: the payment is not consideration for any of transactions (a)–(e).',
  },
  {
    citation: '2010 Act 31 s.3',
    sectionNumber: '3',
    ruleKey: 'vat.outside_scope_capital_loans_dividends',
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Outside the scope: share capital, loans, dividends and drawings',
    statementExcerpt: 'a tax called value-added tax is, subject\nto and in accordance with this Act and regulations, '
      + 'chargeable, leviable and payable\non the following transactions:',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\b(share capital|share subscription|capital introduced|funds introduced|'
          + 'director\'?s? loan|loan (drawdown|advance|repayment)|dividends?|drawings)\\b',
      },
    ],
    exceptions: [
      {
        condition: 'part of a loan repayment is interest or a fee',
        effect: 'that part is a separate question this rule does not answer (the credit exemption limb, Sch.1 '
          + 'para 6(1)(a), reads "…" in the ingested text)',
      },
    ],
    crossReferences: ['VATCA 2010 s.3(a)–(e)', 'CJEU case law on capital raising and loans (not ingested)'],
    treatment: 'OUT_OF_SCOPE',
    vatEffect: 'Issuing shares, receiving or repaying loan capital, paying dividends and a director\'s drawings are '
      + 'movements of capital, not a supply of goods or services for consideration — none of the transactions s.3 '
      + 'charges VAT on. They are outside the scope of VAT.',
    accountingEffect: 'Book to share capital, the loan or director\'s current account, or retained earnings — '
      + 'never to income or expense.',
    reportingEffect: 'Not reported on the VAT3 return.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: capital/loan/dividend keywords stand in for the s.3 test. That these particular '
      + 'movements are not a "supply for consideration" is settled in CJEU case law this KB does not ingest, so '
      + 'requiresGuidance stays true.',
  },
  {
    citation: '2010 Act 31 s.3',
    sectionNumber: '3',
    ruleKey: 'vat.outside_scope_own_account_transfer',
    ruleType: 'other',
    topic: 'vat_scope',
    name: 'Outside the scope: transfer between the company\'s own accounts',
    statementExcerpt: 'a tax called value-added tax is, subject\nto and in accordance with this Act and regulations, '
      + 'chargeable, leviable and payable\non the following transactions:',
    conditions: [
      {
        field: 'description', operator: 'matches',
        value: '\\b(own account transfer|internal transfer|transfer (to|from) (savings|deposit|current)( account)?|'
          + 'savings transfer|saver)\\b',
      },
    ],
    exceptions: [],
    crossReferences: ['VATCA 2010 s.3(a)–(e)'],
    treatment: 'OUT_OF_SCOPE',
    vatEffect: 'Moving money between the company\'s own accounts involves no other party and no supply; it is '
      + 'outside the scope of VAT (s.3).',
    accountingEffect: 'Book to the other bank account; no income, expense or VAT.',
    reportingEffect: 'Not reported on the VAT3 return.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'PROXY: transfer keywords stand in for the fact that both accounts belong to the company.',
  },
];

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
 *    paragraphs are curated in two passes: the five an ordinary SME meets week
 *    to week (postal, bank accounts, insurance, letting, passenger transport),
 *    then every remaining paragraph (issue #206), or a justified
 *    `not_applicable` in the coverage matrix (paras 13 and 15, exemptions at
 *    importation). Loan interest has a rule that suggests no treatment and
 *    flags why: para 6(1)(a)'s credit words were deleted in 2023
 *    (`vat.loan_interest_undetermined`).
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
 * A Schedule 1 rule's window starts on the latest LRC amendment to the words
 * it quotes (`statementExcerpt` and any `windowQuotes`), read from the LRC
 * HTML beside schedule-1.md (`quotedTextWindow`, issue #206). The s.2 and
 * s.3 rules keep the Act's commencement: their LRC HTML is not in the
 * repository.
 *
 * Every `statementExcerpt` must be a verbatim substring of its provision's
 * `provisionText`; `deriveVatScopeRules` refuses (and reports) any that is not.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export type VatScopeTreatment = 'IE_EXEMPT' | 'OUT_OF_SCOPE';

export interface CuratedVatScopeRule {
  /** Source citation, as ingested. */
  citation: '2010 Act 31 Sch.1' | '2010 Act 31 s.2' | '2010 Act 31 s.3' | '2010 Act 31 s.34' | 'VATCA 2010 s.47';
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
  /** The Act's commencement; for a Schedule 1 rule, the derive dates it from the LRC amendments to its quoted words instead. */
  effectiveFrom: string;
  interpretationNote: string;
  /**
   * Further verbatim words the rule relies on besides `statementExcerpt` (a
   * stated exclusion, say): an amendment to any of them also moves the rule's
   * window (issue #206).
   */
  windowQuotes?: string[];
}

const EXEMPT_EFFECT_SUFFIX = ' No VAT is charged, and input VAT on costs of making an exempt supply is not deductible '
  + '(it is an "exempted activity", s.2(1)) — unlike a zero-rated supply.';

const VATCA_COMMENCEMENT = '2010-11-01';


const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });

/** A Schedule 1 exemption rule with this file's defaults. */
function sch1(r: {
  sectionNumber: string; ruleKey: string; name: string; statementExcerpt: string; conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[]; vatEffect: string; interpretationNote: string; windowQuotes?: string[];
}): CuratedVatScopeRule {
  return {
    citation: '2010 Act 31 Sch.1', ruleType: 'exemption', topic: 'vat_scope', crossReferences: [],
    treatment: 'IE_EXEMPT', accountingEffect: null, reportingEffect: null, effectiveFrom: VATCA_COMMENCEMENT,
    ...r,
    vatEffect: r.vatEffect + EXEMPT_EFFECT_SUFFIX,
  };
}

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
        effect: 'not this rule: see vat.loan_interest_undetermined, which flags it (the credit words of para '
          + '6(1)(a) were deleted in 2023 and where they went is not in the repository)',
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

  // --- Exempt: the remaining Schedule 1 paragraphs (issue #206) -------------
  // Each is a keyword candidate on the invoice line (with the supplier's name
  // and the invoice's VAT legends), never a determination: most exemptions
  // here turn on who the supplier is (a registered practitioner, a non-profit,
  // a recognised school), which the line does not prove.
  sch1({
    sectionNumber: '2', ruleKey: 'vat.exempt_medical_care',
    name: 'Exempt: hospital and medical care; professional medical, dental and optical services',
    statementExcerpt: 'Hospital and medical care or treatment provided by a hospital, nursing home,\nclinic or similar establishment.',
    windowQuotes: ['Professional medical care\nservices (other than dental or optical services) supplied by', 'Professional dental or optical services.'],
    conditions: [desc('^(?!.*\\b(spectacles|glasses|frames|contact lens(es)?|cosmetic|aesthetic|botox)\\b).*\\b('
      + 'hospital|nursing home|clinic|gp|doctor|consultant|consultation|physiotherap\\w*|dentist|dental|orthodont\\w*|'
      + 'optician|optometrist|eye test|nurse|midwife|medical (care|treatment|fees?|examination))\\b')],
    exceptions: [
      {
        condition: 'professional medical care supplied in the course of a business that wholly or partly sells goods (para 2(3))',
        effect: 'not exempt under para 2(3)',
      },
      {
        condition: 'goods sold with the service (spectacles, contact lenses) and cosmetic procedures that are not medical care',
        effect: 'taxable at their own rate',
      },
    ],
    vatEffect: 'Hospital and medical care, and professional medical, dental and optical services, are exempt (Schedule 1 para 2).',
    interpretationNote: 'Covers 2(1), 2(3) and 2(5). Whether the supplier is a registered practitioner, and whether a '
      + 'sale of goods is part of the same business, are not on the line. 2(2) (HSE home care), 2(4) (dental '
      + 'technicians), 2(6) (organs, blood, milk) and 2(7) are not matched.',
  }),
  sch1({
    sectionNumber: '3', ruleKey: 'vat.exempt_nonprofit_membership_and_sport',
    name: 'Exempt: non-profit members\' subscriptions; non-profit sports facilities',
    statementExcerpt: 'The supply of services and the supply of goods closely related to those services\nfor the '
      + 'benefit of their members by non-profit making organisations',
    windowQuotes: ['The provision by non-profit making organisations of'],
    conditions: [
      desc('\\b(membership|subscription|annual fee|club fees?|affiliation fee)\\b'),
      desc('\\b(association|society|union|institute|federation|chamber|club|guild|charity)\\b'),
    ],
    exceptions: [{
      condition: 'the organisation is run for profit, its aims are not political, trade union, religious, patriotic, '
        + 'philosophical, philanthropic or civic, or the member pays more than the subscription',
      effect: 'not exempt under para 3(3)',
    }],
    vatEffect: 'A non-profit organisation\'s services to its members for their subscription, and a non-profit\'s '
      + 'sports facilities, are exempt (Schedule 1 para 3(3), (4)).',
    interpretationNote: 'Covers 3(3) and 3(4). Whether the body is non-profit, and its aims, are not on the line. '
      + '3(1) (cost-sharing groups), 3(2) (welfare) and 3(5) (cultural bodies) are not matched.',
  }),
  sch1({
    sectionNumber: '4', ruleKey: 'vat.exempt_education_childcare',
    name: 'Exempt: childcare otherwise than for profit; recognised education and vocational training; private tuition',
    statementExcerpt: 'The supply of services for the protection or care of children and young persons,\nand the supply '
      + 'of goods closely related to that supply, otherwise than for profit.',
    windowQuotes: ['but excluding instruction in the driving of mechanically\npropelled road vehicles',
      'Tuition\ngiven privately by teachers and covering school or university education.'],
    conditions: [desc('^(?!.*\\b(driving|research)\\b).*\\b(tuition|course fees?|training course|school fees|'
      + 'university|college fees?|childcare|creche|crèche|montessori|after-?school|grinds)\\b')],
    exceptions: [
      {
        condition: 'education or training not by a public body, recognised school, college or university, or not a '
          + 'validated, accredited or approved programme; research services',
        effect: 'not exempt under para 4(3)',
      },
      {
        condition: 'instruction in driving vehicles other than heavy goods vehicles and vehicles for more than 9 persons',
        effect: 'excluded from para 4(3); see Sch.3 para 21(5)',
      },
      {
        condition: 'childcare provided for profit by a person not regulated under the Child Care Act 1991',
        effect: 'not exempt under para 4(1) or (2)',
      },
    ],
    vatEffect: 'Childcare otherwise than for profit or by regulated providers, recognised education and vocational '
      + 'training, and private school or university tuition, are exempt (Schedule 1 para 4).',
    interpretationNote: 'Covers 4(1)–(4). Who provides the education and whether the programme is validated are not '
      + 'on the line; a line naming driving or research does not match.',
  }),
  sch1({
    sectionNumber: '5', ruleKey: 'vat.exempt_live_performances',
    name: 'Exempt: admission to live theatrical or musical performances without food or drink facilities',
    statementExcerpt: 'The promotion of, and admission to, live theatrical or musical performances, including\ncircuses, but excluding',
    windowQuotes: ['performances in conjunction with which facilities are available for the consumption\nof food or drink'],
    conditions: [
      desc('\\b(admissions?|tickets?|entry|entrance)\\b'),
      desc('^(?!.*\\b(dances?|disco|dinner|food|drinks?|bar|supper|meal)\\b).*\\b(theatre|concerts?|gigs?|musicals?|'
        + 'opera|pantomime|circus)\\b'),
    ],
    exceptions: [{
      condition: 'dances; performances where food or drink can be consumed during all or part of the performance',
      effect: 'excluded from para 5(2); the reduced rate under Sch.3 para 8(2) may apply',
    }],
    vatEffect: 'Admission to live theatrical or musical performances (including circuses) without food or drink '
      + 'facilities is exempt (Schedule 1 para 5(2)).',
    interpretationNote: 'Covers 5(2). Whether food or drink is available at the venue is often not on the ticket; a '
      + 'line that mentions it does not match. 5(1) (hospital and school catering), 5(3) (sporting events) and 5(4) '
      + '(national broadcasting) are not matched.',
  }),
  sch1({
    sectionNumber: '6', ruleKey: 'vat.exempt_securities_and_fund_management',
    name: 'Exempt: dealing in shares and securities; underwriting; currency exchange; guarantees; fund management',
    statementExcerpt: 'transferring or otherwise dealing\nin stocks, shares, debentures and other securities (other than '
      + 'documents establishing\ntitle to goods);',
    windowQuotes: ['Financial services that consist of managing an undertaking of a kind specified in\nthis subparagraph:'],
    conditions: [desc('\\b(stockbrok\\w*|share dealing|dealing (fee|commission)|securities|underwriting|'
      + 'fund management|management fee.{0,20}fund|foreign exchange|currency exchange|fx (fee|margin)|'
      + 'guarantee fee|bond fee)\\b')],
    exceptions: [{
      condition: 'management or safekeeping of securities (custody), debt collecting and factoring, or advice that is '
        + 'not itself dealing',
      effect: 'not within para 6; taxable',
    }],
    vatEffect: 'Dealing in shares and securities, underwriting, dealing in currency, credit guarantees, and '
      + 'managing a listed fund are exempt (Schedule 1 para 6(1)(a), (b), (d), (f) and 6(2)).',
    interpretationNote: 'Custody and investment advice are commonly billed alongside dealing and are not exempt; the '
      + 'line rarely separates them.',
  }),
  sch1({
    sectionNumber: '6', ruleKey: 'vat.exempt_card_scheme_services',
    name: 'Exempt: card-scheme services to a merchant (acquiring, merchant service charges)',
    statementExcerpt: 'supplying services to a person under an arrangement that provides for the person\nto be reimbursed '
      + 'for the supply by the person of goods or services in accordance with\na credit card, charge card or similar card scheme;',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'purchase' },
      desc('\\b(merchant (service )?(fees?|charges?)|card (processing|acquiring|transaction) (fees?|charges?)|'
        + 'acquiring fees?|stripe fees?|payment processing fees?|interchange|msc)\\b'),
    ],
    exceptions: [{
      condition: 'terminal rental, software or other services billed separately from the card-scheme service',
      effect: 'not within para 6(1)(h); taxable',
    }],
    vatEffect: 'Services to a merchant under a card scheme, by which the merchant is reimbursed for card sales, are '
      + 'exempt (Schedule 1 para 6(1)(h)).',
    interpretationNote: 'Terminal rental and gateway software fees on the same statement are taxable; a keyword cannot '
      + 'separate them.',
  }),
  sch1({
    sectionNumber: '7', ruleKey: 'vat.exempt_financial_agency',
    name: 'Exempt: agency services relating to the financial services in para 6(1)',
    statementExcerpt: 'The supply of agency services relating to the financial services specified in\n\nsubparagraph (1)\nof\nparagraph 6',
    conditions: [desc('\\b(stockbroker|investment (broker|agent)|placing (fee|commission)|introducer (fee|commission)|'
      + 'broker(age)? commission)\\b')],
    exceptions: [
      {
        condition: 'management or safekeeping in relation to shares and securities (para 6(1)(a))',
        effect: 'excluded from para 7(1); taxable',
      },
      {
        condition: 'negotiating credit',
        effect: 'undetermined: para 6(1) no longer lists granting credit (see vat.loan_interest_undetermined)',
      },
    ],
    vatEffect: 'Agency services relating to the financial services in Schedule 1 para 6(1) are exempt (para 7(1)).',
    interpretationNote: 'Insurance agency is para 8, not para 7.',
  }),
  sch1({
    sectionNumber: '9', ruleKey: 'vat.exempt_investment_gold',
    name: 'Exempt: investment gold',
    statementExcerpt: 'The supply, intra-Community acquisition and importation of investment gold,\nother than supplies of '
      + 'investment gold to the Central Bank of Ireland.',
    conditions: [desc('\\b(investment gold|gold (bullion|bars?|ingots?|sovereigns?|krugerrands?)|bullion)\\b')],
    exceptions: [{
      condition: 'gold that is not "investment gold" within s.90(1) (jewellery, most coins), or a supply to the Central Bank',
      effect: 'not exempt under para 9',
    }],
    vatEffect: 'Investment gold is exempt (Schedule 1 para 9).',
    interpretationNote: 'Whether the gold meets the s.90(1) definition (purity, weight, coin criteria) is not on the line.',
  }),
  sch1({
    sectionNumber: '10', ruleKey: 'vat.exempt_betting_and_lotteries',
    name: 'Exempt: betting subject to betting duty; lottery tickets',
    statementExcerpt: 'The issuing of tickets or coupons for the purpose of a lottery.',
    windowQuotes: ['The acceptance of bets that are subject to excise duty'],
    conditions: [desc('\\b(bets?|betting|bookmakers?|lottery|lotto|raffle|scratch ?cards?)\\b')],
    exceptions: [{
      condition: 'a bet not subject to (or exempt from) excise duty under the Finance Act 2002',
      effect: 'not within para 10(1)',
    }],
    vatEffect: 'Accepting bets within the betting duty regime, and issuing lottery tickets, are exempt (Schedule 1 para 10).',
    interpretationNote: 'Covers 10(1) and 10(2); the remote-betting limbs (1A)–(1C) are not matched.',
  }),
  sch1({
    sectionNumber: '12', ruleKey: 'vat.exempt_sale_of_non_deductible_goods',
    name: 'Exempt: sale of business goods on which no VAT was deductible (e.g. a car)',
    statementExcerpt: 'that no part of the\ntax was deductible under',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'sale' },
      desc('\\b(sale|disposal|trade-?in) of\\b.{0,30}\\b(car|motor car|vehicle)\\b'),
    ],
    exceptions: [{
      condition: 'any part of the VAT on the goods was deductible, or the goods are immovable goods or within s.19(1)(h)',
      effect: 'not exempt under para 12; the sale is taxable',
    }],
    vatEffect: 'Selling goods used in the business on which VAT was borne but none was deductible is exempt '
      + '(Schedule 1 para 12).',
    interpretationNote: 'Whether VAT on the goods was deductible is in the company\'s own purchase records, not on '
      + 'the sale line: check the purchase before accepting this.',
  }),
  sch1({
    sectionNumber: '14', ruleKey: 'vat.exempt_funeral_services',
    name: 'Exempt: services of a funeral undertaking',
    statementExcerpt: 'The provision of services by a funeral undertaking.',
    conditions: [desc('\\b(funeral|undertakers?|burial|cremation)\\b')],
    exceptions: [{
      condition: 'goods sold separately from the funeral service (a headstone, flowers)',
      effect: 'taxable at their own rate',
    }],
    vatEffect: 'Services of a funeral undertaking are exempt (Schedule 1 para 14(1)).',
    interpretationNote: 'Covers 14(1).',
  }),
  sch1({
    sectionNumber: '14', ruleKey: 'vat.exempt_public_water',
    name: 'Exempt: water supplied by local authorities and Irish Water',
    statementExcerpt: 'The supply of water by local authorities\nand Irish Water',
    conditions: [desc('\\b(irish water|uisce [ée]ireann|water (charges?|supply|rates)|county council.{0,30}water)\\b')],
    exceptions: [{
      condition: 'water supplied by anyone else (bottled water, a private supplier)',
      effect: 'not within para 14(2)',
    }],
    vatEffect: 'Water supplied by local authorities and Irish Water (Uisce Éireann) is exempt (Schedule 1 para 14(2)).',
    interpretationNote: 'Covers 14(2).',
  }),
  sch1({
    sectionNumber: '14', ruleKey: 'vat.exempt_sporting_event_admission',
    name: 'Exempt: admission of spectators to sporting events',
    statementExcerpt: 'The admission of spectators to sporting events.',
    conditions: [
      desc('\\b(admissions?|tickets?|entry|entrance|season ticket)\\b'),
      desc('\\b(match|game|fixture|sporting event|race meeting|races|championship|final|stadium|croke park)\\b'),
    ],
    exceptions: [{
      condition: 'hospitality packages (food, drink, corporate boxes) sold with the ticket',
      effect: 'that part is not admission; taxable',
    }],
    vatEffect: 'Admission of spectators to sporting events is exempt (Schedule 1 para 14(4)).',
    interpretationNote: 'Covers 14(4).',
  }),
  {
    ...sch1({
      sectionNumber: '6', ruleKey: 'vat.loan_interest_undetermined',
      name: 'Loan and overdraft interest: exemption cannot be confirmed from the sources',
      statementExcerpt: 'Financial services that consist of any of the following:',
      conditions: [
        desc('\\binterest\\b'),
        desc('\\b(loans?|overdraft|credit|finance|mortgage|facility)\\b'),
      ],
      exceptions: [],
      vatEffect: 'No treatment is suggested: whether granting credit is still an exempt financial service cannot be '
        + 'established from the sources in the repository.',
      interpretationNote: 'The revised Schedule 1 para 6(1) no longer lists granting credit: words at the start of '
        + '6(1)(a) were deleted on 18 December 2023 by Finance (No. 2) Act 2023 s.63 (LRC footnote F392), and the '
        + 'deleted words, and any provision they moved to, are not in the repository. Revenue\'s current guidance '
        + '(docs/statutes/_inbox/C/financial-services/vat-treatment-of-negotiation-services.md, section 2.4) still '
        + 'treats negotiating credit as an exempt agency service. The two cannot be reconciled from these sources, '
        + 'so the line is flagged for a person to decide (issue #206).',
    }),
    treatment: null,
    vatEffect: 'No treatment is suggested: whether granting credit is still an exempt financial service cannot be '
      + 'established from the sources in the repository.',
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

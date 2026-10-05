/**
 * Curated rules for the Companies Act 2014 size-threshold and filing/audit-
 * exemption sections, from their LRC-revised text
 * (docs/statutes/companies-act-2014/s*.md, ingested by
 * companiesAct2014Ingestion.ts). Closes issue #135: this KB previously held
 * only a hand-written paraphrase of these sections
 * (docs/statutes/companies-act-2014/companies-act-2014.md), which cannot
 * back a curated rule under this KB's verbatim-only policy.
 *
 * Company size, filing exemption and audit exemption are a wholly different
 * subject from every other source in this KB (VAT, RCT, capital allowances):
 * a company-level annual-accounts classification, not a per-transaction VAT/
 * tax treatment. `topic: 'company_filing_reference'` is deliberately not one
 * of `transactionLookup.ts`'s `TOPIC_RULES` (see that file), so these rules
 * are never auto-routed to for a bank transaction or invoice — the same
 * `_reference` convention `si692025Curation.ts` established for declaratory
 * citation facts (`vat.registration_threshold_turnover_test`,
 * `vat.annual_turnover_definition`) that would otherwise pollute every
 * matching transaction's `applicableRules`. They remain directly citable by
 * `ruleKey` via `lookupTaxRule`.
 *
 * Every threshold rule below carries `conditions: []`, and deliberately so —
 * not an oversight. VATCA's registration/cash-accounting thresholds could be
 * wired to a real per-transaction test because `TransactionContext` already
 * carries `annualTurnoverCurrentYearMinor`/`annualTurnoverPreviousYearMinor`
 * (a VAT-specific concept: taxable turnover on a rolling 12-month test).
 * Companies Act "turnover", "balance sheet total" and "average number of
 * employees" are different figures on a different (financial-year) basis,
 * and neither the `companies` table nor `TransactionContext` carries them at
 * all — inventing a condition against a field that doesn't exist, or
 * silently reusing the VAT turnover field for a different legal test, would
 * be exactly the kind of fabricated match AGENTS.md invariant #7 forbids.
 * This mirrors `rctCuration.ts`'s own rate-criteria rules, which state
 * Revenue's published criteria "without evaluating them" because the
 * relevant fact (a subcontractor's 3-year compliance history) is not
 * transaction data either — `requiresGuidance`/`humanReviewRequired` are
 * always true here for the same reason.
 *
 * Twelve rules from seven of the eleven ingested sections:
 * - s.280A (small company, general): three separate rule keys for the three
 *   independent 2-of-3 test limbs (turnover, balance sheet, employees) —
 *   split the same way `financeAct2024VatThresholdsCuration.ts` splits a
 *   single section's independent goods/services thresholds into separate
 *   ruleKeys, since `factExtractor.ts`'s generic one-fact-per-section
 *   pipeline cannot itself split a section stating three.
 * - s.280D (micro company): the same three-way split, at the micro
 *   thresholds. s.280E (which merely says a qualifying micro company may use
 *   "different rules" elsewhere in the Act, without itself stating any) is
 *   ingested for citability but backs no rule of its own — referenced in
 *   interpretation notes only.
 * - s.280F (medium company, issue #554): the same three-way split, at the
 *   medium thresholds. s.280B (small groups) and s.280C (which only names the
 *   "small companies regime") are ingested for citability; the group test
 *   needs group figures these books do not hold, so a holding company's size
 *   is a person's decision (src/domain/reports/companySize.ts).
 * - s.352 (abridged filing exemption): one rule.
 * - s.358/359/360 (audit exemption conditions and effect): one rule each —
 *   358 for the non-group gate, 359 for the group gate, 360 for the actual
 *   disapplication of the s.333 audit requirement. s.359(3)-(12) are genuine
 *   LRC deletions (superseded by the European Union (Statutory Audits)
 *   (Directive 2006/43/EC, as amended by Directive 2014/56/EU, and
 *   Regulation (EU) No 537/2014) Regulations 2016 / Companies (Accounting)
 *   Act 2017 restructuring) and are rendered as bare "…" in the fetched
 *   text — nothing is curated from them; only s.359(1), (2) and (13), which
 *   are real text, back this file's s.359 rule.
 *
 * None of these rules binds `taxRateId`/`vatTreatmentId` — there is no
 * existing rate/treatment configuration for a company-size classification to
 * point at; unlike a VAT rate, "small company" is not itself a number this
 * KB's other tables already hold anywhere.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/** Matches the `irish_tax_rules.unit` column's enum (src/db/schema/irishRules.ts); not separately exported there. */
type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedCompaniesAct2014Rule {
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  extractedFact: string;
  numericValue: number | null;
  unit: IrishRuleUnit | null;
  qualifier: string | null;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  reportingEffect: string | null;
  effectiveFrom: string;
  interpretationNote: string;
}

/** Reference facts (thresholds, filing/audit exemption tests), never auto-routed to by `identifyTopics`. */
export const COMPANY_FILING_REFERENCE_TOPIC = 'company_filing_reference';

const SMALL_COMPANY_2_OF_3_NOTE = 'Companies Act 2014 s.280A(3): a company satisfies the small-company '
  + 'qualifying conditions in a financial year if it "fulfils 2 or more" of the three limbs below — meeting only '
  + 'one, or none, is not enough, and meeting all three is not required beyond two. This KB curates the three '
  + 'limbs as separate rule keys (see this file\'s own header) rather than one combined rule, since none of them '
  + 'is itself an evaluable TransactionContext/company fact today; a human must apply the 2-of-3 test by hand '
  + 'against the company\'s own financial-year figures. s.280A(4) also excludes a holding company or an '
  + '"ineligible company" (defined elsewhere in the Act, not curated here) from qualifying at all, whatever its '
  + 'figures. s.280A(2) additionally requires the conditions to be met in two consecutive years (or the company '
  + 'to have already so qualified) before a subsequent year — not just the year being tested in isolation.';

const MICRO_COMPANY_2_OF_3_NOTE = 'Companies Act 2014 s.280D(3): a company satisfies the micro-company '
  + 'qualifying conditions in a financial year if it (a) qualifies for the small companies regime under s.280A, '
  + 'AND (b) "fulfils 2 or more" of the three limbs below — this is an additional, narrower test layered on top '
  + 'of the small-company test, not an alternative to it. s.280D(4) excludes an investment undertaking, a '
  + 'financial holding undertaking, a holding company preparing group financial statements, or a subsidiary '
  + 'included in a higher holding undertaking\'s consolidated statements. s.280E (ingested, not separately '
  + 'curated) states only that a qualifying micro company may then use different ("micro companies regime") '
  + 'rules for its financial statements and reports — it states no figure of its own.';

/**
 * The s.280A, s.280D and s.280F thresholds as they now stand were substituted
 * from 1 July 2024 by the European Union (Adjustments of Size Criteria for
 * Certain Companies and Groups) Regulations 2024 (S.I. No. 301 of 2024), per
 * the LRC annotations to each section (issue #554). They were first dated
 * 2026-09-20, the day they were fetched, which is not when they took effect.
 * The employee limbs were not amended and date from 2017 (issue #555).
 */
/** The Act commenced on 1 June 2015 (S.I. No. 249 of 2015); ss.281-285 carry no LRC amendment annotation, so that is their date. */
const CA_2014_COMMENCEMENT = '2015-06-01';
/** s.343's 56 days substituted 16 December 2020 (Companies (Amendment) Act 2019 s.1, S.I. No. 631 of 2020). */
const CA_2014_S343_2020_FROM = '2020-12-16';
const SI_301_2024_FROM = '2024-07-01';
/** Chapter 1A of Part 6 inserted by the Companies (Accounting) Act 2017, in operation 9 June 2017. */
const CAA_2017_FROM = '2017-06-09';

const SI_301_2024_NOTE = 'Substituted (1.07.2024) by S.I. No. 301 of 2024 (in operation 1 July 2024, reg. 2). Under '
  + 's.280I, inserted by its reg. 9, the company elects whether the substituted figure applies to each financial year '
  + 'beginning on or after 1 January 2024, or on or after 1 January 2023; the figure it replaced is curated as the '
  + '`_pre_2024` rule (sizeCriteriaCuration.ts). ';

/** The employee limbs date from the 2017 insertion of the section; S.I. 301/2024 did not amend them. */
const EMPLOYEE_LIMB_NOTE = 'Inserted (9.06.2017) by the Companies (Accounting) Act 2017 s.15 (LRC annotation); not amended by '
  + 'S.I. No. 301 of 2024, which changed only the turnover and balance sheet figures. '

const MEDIUM_COMPANY_2_OF_3_NOTE = 'Companies Act 2014 s.280F(3): a company satisfies the medium-company '
  + 'qualifying conditions in a financial year if it "fulfils 2 or more" of the three limbs. s.280F(4) excludes a '
  + 'holding company, an ineligible company, and a company that qualifies for the small or micro companies regime, '
  + 'so a company is medium only when it is neither small nor micro. s.280F(2) applies the same two-year rule as '
  + 's.280A(2); s.280F(5) adjusts the turnover limb proportionately for a financial year that is not a year; '
  + 's.280F(6) takes the average number of employees by the s.317 methods (not ingested here).';

export const COMPANIES_ACT_2014_CURATED_RULES: CuratedCompaniesAct2014Rule[] = [
  {
    citation: '2014 Act 38 s.281',
    sectionNumber: '281',
    ruleKey: 'company.accounting_records_duty',
    ruleType: 'procedure',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Accounting records: a company must keep adequate records',
    statementExcerpt: 'A company shall keep or cause to be kept adequate accounting records.',
    extractedFact: 'adequate accounting records',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'Every company must keep adequate accounting records (s.281). Section 282(1) says what is adequate: records that correctly record and explain the transactions and let the assets, liabilities, financial position and profit or loss be determined with reasonable accuracy at any time.',
    effectiveFrom: CA_2014_COMMENCEMENT,
    interpretationNote: 'The duty the books already honour: every posted journal keeps its source, and the ledger is the accounting record. s.282 (what is adequate) and s.286 (offences) are cited, not curated.',
  },
  {
    citation: '2014 Act 38 s.282',
    sectionNumber: '282',
    ruleKey: 'company.adequate_accounting_records',
    ruleType: 'definition',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Adequate accounting records: what they must do',
    statementExcerpt: 'adequate accounting records are those that are\nsufficient to—\n\n(a) correctly record and explain the transactions of the company,',
    extractedFact: 'records that correctly record and explain the transactions of the company',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'They must also enable the assets, liabilities, financial position and profit or loss to be determined with reasonable accuracy at any time, and enable the directors to ensure the financial statements comply with the Act (s.282(1)).',
    effectiveFrom: CA_2014_COMMENCEMENT,
    interpretationNote: 'The ledger and the document chain behind each journal are the books\' answer to this test; it does not change a computation.',
  },
  {
    citation: '2014 Act 38 s.283',
    sectionNumber: '283',
    ruleKey: 'company.accounting_records_location',
    ruleType: 'procedure',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Accounting records: kept at the registered office or where the directors think fit',
    statementExcerpt: 'accounting records shall be kept at its registered office or at such other place\nas the directors think fit.',
    extractedFact: 'registered office or a place the directors choose',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'Records kept outside the State need information and returns kept in the State that disclose the business with reasonable accuracy at intervals not exceeding 6 months (s.283(2)).',
    effectiveFrom: CA_2014_COMMENCEMENT,
    interpretationNote: 'A local-first book on the company\'s own machine is a place the directors have chosen; the s.283(2) 6-month returns apply only to records kept outside the State.',
  },
  {
    citation: '2014 Act 38 s.284',
    sectionNumber: '284',
    ruleKey: 'company.accounting_records_access',
    ruleType: 'procedure',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Accounting records: available for inspection without charge',
    statementExcerpt: 'shall make its accounting records, and any information and returns\nreferred to in\nsection 283\n(2)\n, available',
    extractedFact: 'available at all reasonable times for inspection without charge',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'Officers, and other persons the Act entitles, may inspect the records at all reasonable times without charge; records kept electronically must be converted to written form in an official language on request (s.284(1)-(2)).',
    effectiveFrom: CA_2014_COMMENCEMENT,
    interpretationNote: 'A member who is not a director has no right of inspection except as statute, the constitution or the directors under s.284(4) allow (s.284(3)).',
  },
  {
    citation: '2014 Act 38 s.285',
    sectionNumber: '285',
    ruleKey: 'company.accounting_records_retention',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Accounting records: preserved for at least 6 years',
    statementExcerpt: 'shall be preserved by the company concerned for a period of at least 6 years after\nthe end of the financial year',
    extractedFact: 'at least 6 years after the end of the financial year containing the latest date to which the record relates',
    numericValue: 6,
    unit: 'count',
    qualifier: 'years after the end of the financial year containing the latest date to which the record, information or return relates',
    conditions: [],
    exceptions: [],
    reportingEffect: 'Accounting records, and the information and returns of s.283(2), must be kept for at least 6 years after that financial year end.',
    effectiveFrom: CA_2014_COMMENCEMENT,
    interpretationNote: 'The books already keep records for six years; this rule cites the duty (AGENTS.md, rule issues vs the tools). s.881 is an evidence-admissibility provision, not a retention one.',
  },
  {
    citation: '2014 Act 38 s.290',
    sectionNumber: '290',
    ruleKey: 'company.financial_statements_duty',
    ruleType: 'procedure',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Directors must prepare entity financial statements for each financial year',
    statementExcerpt: 'The directors of a company shall prepare entity financial statements for the\ncompany in respect of each financial year of it.',
    extractedFact: 'entity financial statements for each financial year',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'The entity financial statements are the statutory financial statements unless the company prepares group financial statements under s.293. They are prepared under s.291 (Companies Act) or under IFRS and s.292, as the company elects (s.290(3)).',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: 'Dated from 9 June 2017: s.290 was amended (LRC annotations F141-F143) by the Companies (Accounting) Act 2017 s.16, S.I. No. 246 of 2017. Statements for a company not trading for the acquisition of gain by its members must follow s.291 (s.290(5)). Leabhar prepares Companies Act statements; the IFRS route (s.292) is out of scope.',
  },
  {
    citation: '2014 Act 38 s.291',
    sectionNumber: '291',
    ruleKey: 'company.companies_act_financial_statements',
    ruleType: 'reporting',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Companies Act entity financial statements: contents and true and fair view',
    statementExcerpt: 'Companies Act entity financial statements in relation to a company for any financial\nyear of it shall comprise—',
    extractedFact: 'a balance sheet, a profit and loss account and any other statements the framework requires',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    reportingEffect: 'They comprise a balance sheet as at the year end and a profit and loss account, with other statements the framework requires (s.291(1)), and give a true and fair view (s.291(2)). Schedule 3, 3A or 3B sets form and content by company size (s.291(3)).',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: 'Dated from 9 June 2017: s.291 was amended (LRC annotations F144-F147) by the Companies (Accounting) Act 2017 s.17, S.I. No. 246 of 2017. The size regimes are curated in company.small_company_* and company.micro_company_*; which Schedule applies is the person\'s decision on those tests.',
  },
  {
    citation: '2014 Act 38 s.293',
    sectionNumber: '293',
    ruleKey: 'company.group_financial_statements',
    ruleType: 'procedure',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Holding company must also prepare group financial statements, unless small or micro',
    statementExcerpt: 'where at the end of its financial year\na company is a holding company, the directors of the company, as well as preparing\nentity financial statements for the financial year, shall prepare group financial\nstatements',
    extractedFact: 'group financial statements for the holding company and all its subsidiary undertakings',
    numericValue: null,
    unit: null,
    qualifier: 'a holding company at the end of its financial year; exempt under s.293(1A) if it qualifies for the small or micro companies regime, which it may elect to waive',
    conditions: [],
    exceptions: [],
    reportingEffect: 'A holding company that qualifies for the small or micro regime is exempt but may elect to prepare group statements (s.293(1A)). Where it prepares them, the entity statements join them as the statutory financial statements (s.293(2)).',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: 'Dated from 9 June 2017: the small and micro exemption in s.293(1A) was inserted (LRC annotation F152) by the Companies (Accounting) Act 2017 s.19, S.I. No. 246 of 2017. The exemptions in s.293(9) and the group size test need group figures these books do not hold; a holding company\'s position is the person\'s decision.',
  },
  {
    citation: '2014 Act 38 s.343',
    sectionNumber: '343',
    ruleKey: 'company.annual_return_delivery',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Annual return: delivered to the Registrar within 56 days of the annual return date',
    statementExcerpt: 'a company shall deliver to the Registrar\nan annual return in accordance with\nsubsection (4)\nnot later than\n56 days\nafter the annual return date of the company.',
    extractedFact: '56 days after the annual return date',
    numericValue: 56,
    unit: 'count',
    qualifier: 'days after the annual return date (or after the earlier date to which the return is made up, s.343(3))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'The return is in the prescribed form and made up to a date not later than the annual return date (s.343(4)). The court may extend the time once for a period (s.343(5)); an order must be filed within 28 days (s.343(6)). Subsection (2) does not apply while the company is being wound up or struck off (s.343(8)-(9)).',
    effectiveFrom: CA_2014_S343_2020_FROM,
    interpretationNote: 'Dated from 16 December 2020: the 56-day period was substituted (LRC annotation F252) by the Companies (Amendment) Act 2019 s.1, S.I. No. 631 of 2020. The annual return date is fixed by s.345, which is not ingested. This rule states the 56-day period; it does not compute a date.',
  },
  {
    citation: '2014 Act 38 s.347',
    sectionNumber: '347',
    ruleKey: 'company.annual_return_annexes',
    ruleType: 'reporting',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Annual return: annex the financial statements, directors\' report and auditors\' report',
    statementExcerpt: 'there shall be annexed to the annual return a copy of the following documents that\nhave been, or are to be, laid before the relevant general meeting:',
    extractedFact: 'the statutory financial statements, the directors\' report and the statutory auditors\' report',
    numericValue: null,
    unit: null,
    qualifier: 'a micro-regime company that has taken the s.325(1A) exemption need not annex a directors\' report (s.347(1A))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'Each annexed copy is a true copy, with signatures in typeset form, accompanied by a certificate of a director and the secretary (s.347(2)).',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: 'Dated from 9 June 2017: the directors\' report limb and the s.347(1A) micro exemption were substituted and inserted (LRC annotations F257-F258) by the Companies (Accounting) Act 2017 s.50. \'this Part and Part 28\' was substituted on 6 July 2024 by S.I. No. 336 of 2024 reg. 7. Part 28 and s.352 modify this duty: a qualifying small or micro company may annex abridged statements instead (company.abridged_filing_exemption).',
  },
  {
    citation: '2014 Act 38 s.280A',
    sectionNumber: '280A',
    ruleKey: 'company.small_company_turnover_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Small company qualifying condition: turnover does not exceed €15 million',
    statementExcerpt: 'the amount of turnover of the company does not exceed\n€15 million',
    extractedFact: '€15 million',
    numericValue: 1_500_000_000, // AGENTS.md invariant #1: money is integer minor units. €15,000,000 = 1,500,000,000 cents.
    unit: 'eur_minor',
    qualifier: 'one of the three s.280A(3) qualifying-condition limbs; 2 of 3 must be met (s.280A(3)); '
      + 'proportionately adjusted for a financial year that is not in fact a year (s.280A(5))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'Qualifying as a small company (2 of 3 of this limb, the balance-sheet limb, and the '
      + 'employee-count limb — see company.small_company_balance_sheet_threshold/company.small_company_employee_threshold) '
      + 'is the gateway condition for the s.352 abridged-filing exemption and, via s.358, the audit exemption.',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`: this KB has no company-level "annual '
      + 'turnover" field (distinct from the VAT-specific `annualTurnoverCurrentYearMinor`/'
      + '`annualTurnoverPreviousYearMinor` fields `financeAct2024VatThresholdsCuration.ts` uses for a different '
      + 'legal test) to test it against, so this states the figure for a human to apply, rather than a mechanical '
      + 'gate — see this file\'s own header.',
  },
  {
    citation: '2014 Act 38 s.280A',
    sectionNumber: '280A',
    ruleKey: 'company.small_company_balance_sheet_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Small company qualifying condition: balance sheet total does not exceed €7.5 million',
    statementExcerpt: 'the balance sheet total of the company does not exceed\n€7.5 million',
    extractedFact: '€7.5 million',
    numericValue: 750_000_000, // €7,500,000 = 750,000,000 cents
    unit: 'eur_minor',
    qualifier: 'one of the three s.280A(3) qualifying-condition limbs; 2 of 3 must be met (s.280A(3))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.small_company_turnover_threshold.',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`, for the same reason as '
      + 'company.small_company_turnover_threshold: this KB has no company-level "balance sheet total" field.',
  },
  {
    citation: '2014 Act 38 s.280A',
    sectionNumber: '280A',
    ruleKey: 'company.small_company_employee_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Small company qualifying condition: average number of employees does not exceed 50',
    statementExcerpt: 'the average number of employees does not exceed 50',
    extractedFact: '50',
    numericValue: 50,
    unit: 'count',
    qualifier: 'one of the three s.280A(3) qualifying-condition limbs; 2 of 3 must be met (s.280A(3)); the '
      + 'average is determined by the s.317(1)(a) methods (s.280A(6)), not curated here',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.small_company_turnover_threshold.',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: EMPLOYEE_LIMB_NOTE + SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`: this KB has no company-level employee-'
      + 'count field, and does not ingest s.317 (the averaging method this limb defers to).',
  },
  {
    citation: '2014 Act 38 s.280D',
    sectionNumber: '280D',
    ruleKey: 'company.micro_company_turnover_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Micro company qualifying condition: turnover does not exceed €900,000',
    statementExcerpt: 'the amount of turnover of the company does not exceed\n€900,000',
    extractedFact: '€900,000',
    numericValue: 90_000_000, // €900,000 = 90,000,000 cents
    unit: 'eur_minor',
    qualifier: 'one of the three s.280D(3)(b) qualifying-condition limbs; also requires qualifying for the small '
      + 'companies regime under s.280A (s.280D(3)(a)); 2 of 3 of the limbs below must be met; proportionately '
      + 'adjusted for a financial year that is not in fact a year (s.280D(5))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'A qualifying micro company may apply the "micro companies regime" (s.280E) to its '
      + 'financial statements and reports.',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`, for the same reason as the small-company '
      + 'thresholds above: no company-level "annual turnover" field exists in this KB.',
  },
  {
    citation: '2014 Act 38 s.280D',
    sectionNumber: '280D',
    ruleKey: 'company.micro_company_balance_sheet_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Micro company qualifying condition: balance sheet total does not exceed €450,000',
    statementExcerpt: 'the balance sheet total of the company does not exceed\n€450,000',
    extractedFact: '€450,000',
    numericValue: 45_000_000, // €450,000 = 45,000,000 cents
    unit: 'eur_minor',
    qualifier: 'one of the three s.280D(3)(b) qualifying-condition limbs; also requires qualifying for the small '
      + 'companies regime under s.280A (s.280D(3)(a)); 2 of 3 of the limbs below must be met',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.micro_company_turnover_threshold.',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`: no company-level "balance sheet total" field.',
  },
  {
    citation: '2014 Act 38 s.280D',
    sectionNumber: '280D',
    ruleKey: 'company.micro_company_employee_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Micro company qualifying condition: average number of employees does not exceed 10',
    statementExcerpt: 'the average number of employees does not exceed 10',
    extractedFact: '10',
    numericValue: 10,
    unit: 'count',
    qualifier: 'one of the three s.280D(3)(b) qualifying-condition limbs; also requires qualifying for the small '
      + 'companies regime under s.280A (s.280D(3)(a)); 2 of 3 of the limbs below must be met; the average is '
      + 'determined by the s.317(1)(a) methods (s.280D(6)), not curated here',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.micro_company_turnover_threshold.',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: EMPLOYEE_LIMB_NOTE + MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`: no company-level employee-count field, and '
      + 's.317 is not ingested here (same gap as the small-company employee limb).',
  },
  {
    citation: '2014 Act 38 s.280F',
    sectionNumber: '280F',
    ruleKey: 'company.medium_company_turnover_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Medium company qualifying condition: turnover does not exceed €50 million',
    statementExcerpt: 'the amount of turnover of the company does not exceed\n€50 million',
    extractedFact: '€50 million',
    numericValue: 5_000_000_000, // €50,000,000 = 5,000,000,000 cents
    unit: 'eur_minor',
    qualifier: 'one of the three s.280F(3) qualifying-condition limbs; 2 of 3 must be met; proportionately adjusted '
      + 'for a financial year that is not in fact a year (s.280F(5))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'A company that is neither small nor micro and meets 2 of the 3 medium limbs is a medium company; '
      + 'one that meets fewer is large (issue #554, src/domain/reports/companySize.ts).',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + MEDIUM_COMPANY_2_OF_3_NOTE,
  },
  {
    citation: '2014 Act 38 s.280F',
    sectionNumber: '280F',
    ruleKey: 'company.medium_company_balance_sheet_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Medium company qualifying condition: balance sheet total does not exceed €25 million',
    statementExcerpt: 'the balance sheet total of the company does not exceed\n€25 million',
    extractedFact: '€25 million',
    numericValue: 2_500_000_000, // €25,000,000 = 2,500,000,000 cents
    unit: 'eur_minor',
    qualifier: 'one of the three s.280F(3) qualifying-condition limbs; 2 of 3 must be met',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.medium_company_turnover_threshold.',
    effectiveFrom: SI_301_2024_FROM,
    interpretationNote: SI_301_2024_NOTE + MEDIUM_COMPANY_2_OF_3_NOTE,
  },
  {
    citation: '2014 Act 38 s.280F',
    sectionNumber: '280F',
    ruleKey: 'company.medium_company_employee_threshold',
    ruleType: 'threshold',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Medium company qualifying condition: average number of employees does not exceed 250',
    statementExcerpt: 'the average number of employees does not exceed 250',
    extractedFact: '250',
    numericValue: 250,
    unit: 'count',
    qualifier: 'one of the three s.280F(3) qualifying-condition limbs; 2 of 3 must be met; the average is '
      + 'determined by the s.317 methods (s.280F(6)), not curated here',
    conditions: [],
    exceptions: [],
    reportingEffect: 'See company.medium_company_turnover_threshold.',
    effectiveFrom: CAA_2017_FROM,
    interpretationNote: EMPLOYEE_LIMB_NOTE + MEDIUM_COMPANY_2_OF_3_NOTE,
  },
  {
    citation: '2014 Act 38 s.352',
    sectionNumber: '352',
    ruleKey: 'company.abridged_filing_exemption',
    ruleType: 'exemption',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Abridged financial statements: filing exemption for small/micro companies',
    statementExcerpt: 'That exemption is an exemption from the requirement in\nsection 347\nto annex to the company',
    extractedFact: 'exemption from annexing full statutory financial statements, directors\' report and auditors\' report',
    numericValue: null,
    unit: null,
    qualifier: 'available to a company that qualifies for the small companies regime (s.280A) or the micro '
      + 'companies regime (s.280D), and has not elected to prepare group financial statements under s.293 '
      + '(s.352(1))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'A qualifying small or micro company may annex abridged financial statements (prepared per '
      + 's.353, approved/signed per s.355) and a special auditors\' report (per s.356) to its annual return, '
      + 'instead of the full statutory financial statements, directors\' report (except a micro company that has '
      + 'not elected to prepare one) and statutory auditors\' report otherwise required by s.347 (s.352(2)-(3)).',
    effectiveFrom: '2026-09-20',
    interpretationNote: 'Gated on the same small/micro qualifying conditions curated above — this KB cannot '
      + 'itself determine whether a given company meets them (see those rules\' own notes), so this rule states '
      + 'the exemption\'s own terms for a human to apply once that determination is made. Does not curate s.353 '
      + '(what "abridged" financial statements must contain), s.355 (approval/signature) or s.356 (the special '
      + 'auditors\' report) — those sections are not ingested here.',
  },
  {
    citation: '2014 Act 38 s.358',
    sectionNumber: '358',
    ruleKey: 'company.audit_exemption_non_group_gate',
    ruleType: 'exemption',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Audit exemption (non-group companies): qualifies as a small company',
    statementExcerpt: 'section 360\n(audit exemption) applies to a company in respect of its statutory financial '
      + 'statements\nfor a particular financial year if the company qualifies as a small company in relation\nto '
      + 'that financial year',
    extractedFact: 'qualifies as a small company under s.280A',
    numericValue: null,
    unit: null,
    qualifier: 'subject to s.358(3): does not apply if the company was a group company at any point in the '
      + 'financial year, unless the group qualifies as a small group under s.359 — see company.audit_exemption_group_gate',
    conditions: [],
    exceptions: [],
    reportingEffect: 'The audit exemption (s.360 — see company.audit_exemption) is available to a non-group '
      + 'company for a financial year in which it qualifies as a small company (s.280A), determined per s.280A '
      + 'and s.280B (s.280B is not ingested here). Nothing in this section affects the separate dormant-company '
      + 'audit exemption in Chapter 16 (s.358(5), not ingested here).',
    effectiveFrom: '2026-09-20',
    interpretationNote: 'References s.280A\'s qualifying conditions (curated above) and, for a group company, '
      + 's.359 (curated separately, see company.audit_exemption_group_gate) — neither is re-evaluated '
      + 'mechanically by this rule, consistent with the small/micro threshold rules\' own no-conditions '
      + 'reasoning. s.358(2) also cross-references s.280B (small-company qualification detail), which this KB '
      + 'does not ingest.',
  },
  {
    citation: '2014 Act 38 s.359',
    sectionNumber: '359',
    ruleKey: 'company.audit_exemption_group_gate',
    ruleType: 'exemption',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Audit exemption (group companies): group qualifies as a small group',
    statementExcerpt: 'section 360\n(audit exemption) applies to any group company in respect of its statutory '
      + 'financial\nstatements for a particular financial year if the\ngroup, would qualify under\nsection 280B\n'
      + 'as a small group\nin relation to that financial year',
    extractedFact: 'the group would qualify under s.280B as a small group',
    numericValue: null,
    unit: null,
    qualifier: '"group company" means a holding company or a subsidiary undertaking; "the group" means that '
      + 'company together with all its associated undertakings (s.359(1))',
    conditions: [],
    exceptions: [],
    reportingEffect: 'The audit exemption (s.360 — see company.audit_exemption) is available to a group company '
      + 'for a financial year in which its group would qualify as a small group under s.280B. Nothing in this '
      + 'section affects the separate dormant-company audit exemption in Chapter 16 (s.359(13)).',
    effectiveFrom: '2026-09-20',
    interpretationNote: 'Only s.359(1), (2) and (13) are curated: subsections (3)-(12) are genuine LRC deletions '
      + '(shown as bare "…" in the fetched text — superseded by the 2016/2017 statutory-audit restructuring, not '
      + 'a fetch or conversion defect) and contain no statutory text to curate from at all. s.280B (the small-'
      + 'group qualification test itself) is not ingested here, so this rule states only the gate, not the test '
      + 'it defers to — a human must apply s.280B\'s own conditions separately.',
  },
  {
    citation: '2014 Act 38 s.360',
    sectionNumber: '360',
    ruleKey: 'company.audit_exemption',
    ruleType: 'exemption',
    topic: COMPANY_FILING_REFERENCE_TOPIC,
    name: 'Audit exemption: statutory audit requirement disapplied',
    statementExcerpt: 'section 333\n(obligation to have statutory financial statements audited) shall not apply',
    extractedFact: 's.333 statutory audit requirement disapplied',
    numericValue: null,
    unit: null,
    qualifier: 'applies only where s.358 (non-group) or s.359 (group) gates it in for the financial year, and '
      + 'only "unless and until circumstances... arise" removing entitlement (s.360(1)(b)) — see '
      + 'company.audit_exemption_non_group_gate / company.audit_exemption_group_gate',
    conditions: [],
    exceptions: [],
    reportingEffect: 'Where the audit exemption applies (per s.358 or s.359), the company\'s (or holding '
      + 'company\'s, for group financial statements) statutory financial statements are not required to be '
      + 'audited under s.333, and the auditor-related provisions listed in the s.360(2) Table (e.g. s.322 '
      + 'remuneration disclosure, s.336/337 auditors\' report form/signature, s.347 documents annexed to the '
      + 'annual return) do not apply for that financial year, unless and until the company loses its entitlement '
      + 'to the exemption.',
    effectiveFrom: '2026-09-20',
    interpretationNote: 'The operative disapplication itself; whether it actually applies to a given company in '
      + 'a given year is entirely gated by company.audit_exemption_non_group_gate / '
      + 'company.audit_exemption_group_gate above, which this KB cannot resolve without company-level figures it '
      + 'does not hold (see this file\'s own header) — so this rule states the effect, never asserts that a '
      + 'specific company currently qualifies for it.',
  },
];

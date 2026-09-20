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
 * Nine rules from six of the eight ingested sections:
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

export const COMPANIES_ACT_2014_CURATED_RULES: CuratedCompaniesAct2014Rule[] = [
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
    effectiveFrom: '2026-09-20',
    interpretationNote: SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`: this KB has no company-level "annual '
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
    effectiveFrom: '2026-09-20',
    interpretationNote: SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`, for the same reason as '
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
    effectiveFrom: '2026-09-20',
    interpretationNote: SMALL_COMPANY_2_OF_3_NOTE + ' No `conditions`: this KB has no company-level employee-'
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
    effectiveFrom: '2026-09-20',
    interpretationNote: MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`, for the same reason as the small-company '
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
    effectiveFrom: '2026-09-20',
    interpretationNote: MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`: no company-level "balance sheet total" field.',
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
    effectiveFrom: '2026-09-20',
    interpretationNote: MICRO_COMPANY_2_OF_3_NOTE + ' No `conditions`: no company-level employee-count field, and '
      + 's.317 is not ingested here (same gap as the small-company employee limb).',
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

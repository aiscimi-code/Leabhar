/**
 * Curated rules for S.I. 69/2025 (European Union (Value-Added Tax)
 * Regulations 2025) — Regulations 5, 8 and 9.
 *
 * Regulation 8 closes a gap `si639Curation.ts` explicitly flagged: Regulation 25 of
 * S.I. 639/2010 requires a Revenue authorisation to use the moneys-received
 * (cash) basis of VAT accounting, but states no eligibility threshold of its
 * own — "the real threshold lives in section 80(1) of the Act, not this
 * Regulation". Regulation 8 here substitutes the *current* text of VATCA
 * 2010 s.80(1)(a) and (b), so both eligibility limbs are now curated from a
 * source ingested for exactly that purpose, in force from 6 March 2025 (the
 * date this instrument was made — it carries no separate commencement
 * clause of its own).
 *
 * Two rules for Regulation 8, not one, because s.80(1) states two independent
 * tests and a person need only satisfy one:
 *  - s.80(1)(a): at least 90% of annual turnover from supplies to
 *    unregistered persons (a proportion test, not itself a euro figure);
 *  - s.80(1)(b): total annual turnover has not exceeded, and is not likely
 *    to exceed, €2,000,000 in any continuous 12-month period.
 *
 * Regulations 5 and 9 close the gap issue #136 bug 2 / issue #137 flagged:
 * `vat.registration_threshold_goods`/`_services`
 * (`financeAct2024VatThresholdsCuration.ts`) stated the s.2(1)/s.78 threshold
 * *figures* but had no way to test a transaction's actual turnover against
 * them, so a single low-value invoice "matched" a registration-threshold
 * rule regardless of the business's real turnover. Regulation 5 substitutes
 * the current s.6(1)(c)/(d) test ("has not exceeded, in the current calendar
 * year or the previous calendar year, the goods/services threshold") and
 * Regulation 9 inserts s.92B's "annual turnover" definition that test now
 * relies on (s.6(1)(c)(i)/(2)(b) were amended by the same Regulation 5 to
 * say "annual turnover" instead of "consideration"). Both are curated here
 * as declaratory/citable statements of the actual legal test and
 * definition; `financeAct2024VatThresholdsCuration.ts`'s own two rules are
 * the ones that actually gate on it (via `annualTurnoverMaxMinor`), citing
 * these two rules' text rather than duplicating the mechanical condition.
 *
 * Regulations 1-4, 6, 7 and 10 (the rest of the cross-border SME exemption
 * scheme and its consequential amendments) remain deliberately NOT curated
 * in this pass — left for a future pass, same as before.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/** Matches the `irish_tax_rules.unit` column's enum (src/db/schema/irishRules.ts); not separately exported there. */
type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedSi692025Rule {
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  /** Which of this document's numbered regulations this rule is derived from — see si692025Ingestion.ts. */
  regulationNumber: string;
  /** VATCA 2010 section this regulation amends/inserts, for `crossReferences`. */
  amendsSection: string;
  statementExcerpt: string;
  numericValue: number | null;
  unit: IrishRuleUnit | null;
  qualifier: string | null;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  vatEffect: string;
  reportingEffect: string | null;
  interpretationNote: string;
}

export const SI_69_2025_CURATED_RULES: CuratedSi692025Rule[] = [
  {
    ruleKey: 'vat.registration_threshold_turnover_test',
    ruleType: 'other',
    topic: 'vat',
    name: 'Registration-threshold turnover test: current calendar year or previous calendar year',
    regulationNumber: '5',
    amendsSection: '6',
    statementExcerpt: '“(i) subject to subparagraph (ii), a person for whose supply of goods (other than '
      + 'supplies of the kind specified in section 30(a) and (b) made by a person established in the State) and '
      + 'services the total annual turnover has not exceeded, in the current calendar year or the previous '
      + 'calendar year, the goods threshold,”',
    numericValue: null,
    unit: null,
    qualifier: 'the actual accountable-person test VATCA s.6(1)(c)/(d) applies — not a euro figure itself, but '
      + 'the "current calendar year or the previous calendar year" window the goods/services threshold figures '
      + '(VATCA s.2(1), substituted by Finance Act 2024 s.78) are tested against',
    conditions: [],
    exceptions: [],
    vatEffect: 'A person is not an accountable person under VATCA s.6(1)(c) (goods) or (d) (services) — and so '
      + 'is not obliged to register for VAT on that basis — only if their total annual turnover has not '
      + 'exceeded the relevant threshold in EITHER the current calendar year OR the previous calendar year. '
      + 'Exceeding it in either year is enough to trigger the registration obligation; a low current-year '
      + 'figure does not cure a previous year that already exceeded the threshold.',
    reportingEffect: null,
    interpretationNote: 'Declaratory citation of the actual statutory test, not itself a mechanical gate — see '
      + 'vat.registration_threshold_goods/_services (financeAct2024VatThresholdsCuration.ts) for the rules that '
      + 'evaluate it against a transaction context\'s annualTurnoverCurrentYearMinor/annualTurnoverPreviousYearMinor '
      + 'fields. This KB cannot itself compute a business\'s actual turnover in either year; the fields must be '
      + 'supplied by the caller (e.g. from bookkeeping records), and their absence leaves the threshold rule '
      + 'unresolved rather than matched (issue #136 bug 2).',
  },
  {
    ruleKey: 'vat.annual_turnover_definition',
    ruleType: 'other',
    topic: 'vat',
    name: 'Definition of "annual turnover" for the SME exemption scheme and registration thresholds',
    regulationNumber: '9',
    amendsSection: '92A',
    statementExcerpt: '‘annual turnover’ means the total consideration (other than consideration from '
      + 'disposals of tangible or intangible capital assets), exclusive of tax, from – (a) supplies of goods '
      + 'and services, in so far as those supplies would be chargeable to tax if supplied by a taxable person '
      + 'who is not exempt from tax, and (b) supplies of immovable goods, services specified in paragraphs 6 '
      + 'and 7 of Schedule 1 and, insurance and reinsurance services, unless those supplies are transactions '
      + 'which are incidental to the taxable person’s supplies and activities;',
    numericValue: null,
    unit: null,
    qualifier: 'VATCA s.92B, inserted by this instrument — the definition s.6(1)(c)/(d)\'s turnover test (see '
      + 'vat.registration_threshold_turnover_test) and the cross-border SME scheme both now use',
    conditions: [],
    exceptions: [],
    vatEffect: '"Annual turnover" excludes VAT and excludes consideration from disposals of tangible or '
      + 'intangible capital assets entirely (not merely when incidental). It includes ordinary taxable '
      + 'goods/services supplies, and separately includes immovable-goods supplies, Schedule 1 paragraphs 6/7 '
      + 'supplies, and insurance/reinsurance services — but only the latter group is excluded again when those '
      + 'specific supplies are themselves incidental to the person\'s activities.',
    reportingEffect: null,
    interpretationNote: 'Declaratory: states what the KB should and should not count if it is ever asked to '
      + 'help a business total its own turnover for a registration-threshold or SME-scheme test. It does not '
      + 'itself classify any given transaction as "incidental" — that judgement (e.g. an occasional van sale, '
      + 'per the worked example in docs/statutes/vat-thresholds/revenue-vat-thresholds.md) is exactly the kind '
      + 'of call this system flags for human review rather than assumes.',
  },
  {
    ruleKey: 'vat.cash_accounting_turnover_threshold',
    regulationNumber: '8',
    amendsSection: '80',
    ruleType: 'threshold',
    topic: 'vat',
    name: 'Cash (moneys-received) basis of VAT accounting: €2,000,000 annual turnover threshold',
    statementExcerpt: '“(b) the total annual turnover which the person is entitled to receive has not exceeded '
      + 'and is not likely to exceed €2,000,000 in any continuous period of 12 months,”',
    // AGENTS.md invariant #1: money is integer minor units, never a bare
    // number without a currency — €2,000,000 is stored as 200,000,000 cents.
    numericValue: 200_000_000,
    unit: 'eur_minor',
    qualifier: 'not exceeded, and not likely to exceed, in any continuous 12-month period — an alternative to '
      + 'the s.80(1)(a) 90%-of-turnover test, not a condition combined with it',
    conditions: [
      { field: 'description', operator: 'matches', value: '\\b(cash basis|moneys received basis|money received basis)\\b' },
    ],
    exceptions: [],
    vatEffect: 'A business is eligible to apply to use the moneys-received basis of VAT accounting under VATCA '
      + 's.80(1)(b) if its total annual turnover has not exceeded, and is not likely to exceed, €2,000,000 in any '
      + 'continuous 12-month period. This is a necessary condition for eligibility, not itself an authorisation — '
      + 'S.I. 639/2010 reg.25 still requires a separate written Revenue authorisation before the basis actually '
      + 'applies (see vat.cash_accounting_requires_authorisation).',
    reportingEffect: null,
    interpretationNote: 'The description keyword match only flags a candidate cash-basis mention; it cannot '
      + 'itself compute a rolling 12-month annual turnover figure from this KB alone, so a human must confirm '
      + 'eligibility against the business\'s actual turnover. This threshold is one of two independent eligibility '
      + 'tests in s.80(1) — satisfying either is sufficient; see also '
      + 'vat.cash_accounting_supplies_to_unregistered_persons_test.',
  },
  {
    ruleKey: 'vat.cash_accounting_supplies_to_unregistered_persons_test',
    regulationNumber: '8',
    amendsSection: '80',
    ruleType: 'threshold',
    topic: 'vat',
    name: 'Cash (moneys-received) basis of VAT accounting: 90% supplies-to-unregistered-persons test',
    statementExcerpt: '“(a) taking one period with another, at least 90 per cent of the person’s annual turnover '
      + 'is derived from supplies to persons who are not registered persons, or”',
    numericValue: 90,
    unit: 'percent',
    qualifier: 'of annual turnover, taking one VAT period with another — an alternative to the s.80(1)(b) '
      + '€2,000,000 turnover threshold, not a condition combined with it',
    conditions: [
      { field: 'description', operator: 'matches', value: '\\b(cash basis|moneys received basis|money received basis)\\b' },
    ],
    exceptions: [],
    vatEffect: 'A business is also eligible for the moneys-received basis under VATCA s.80(1)(a) if, taking one '
      + 'VAT period with another, at least 90% of its annual turnover is derived from supplies to persons who are '
      + 'not themselves VAT-registered (typically retail/consumer-facing trade). Satisfying either this test or '
      + 'the €2,000,000 turnover threshold in s.80(1)(b) is sufficient.',
    reportingEffect: null,
    interpretationNote: 'This KB cannot itself compute what proportion of a business\'s turnover is to registered '
      + 'versus unregistered customers; the condition only flags a cash-basis candidate transaction for human '
      + 'review against the business\'s actual customer mix.',
  },
];

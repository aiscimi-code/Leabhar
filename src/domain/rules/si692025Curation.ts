/**
 * Curated rules for S.I. 69/2025 (European Union (Value-Added Tax)
 * Regulations 2025), Regulation 8 only.
 *
 * This closes a gap `si639Curation.ts` explicitly flagged: Regulation 25 of
 * S.I. 639/2010 requires a Revenue authorisation to use the moneys-received
 * (cash) basis of VAT accounting, but states no eligibility threshold of its
 * own — "the real threshold lives in section 80(1) of the Act, not this
 * Regulation". Regulation 8 here substitutes the *current* text of VATCA
 * 2010 s.80(1)(a) and (b), so both eligibility limbs are now curated from a
 * source ingested for exactly that purpose, in force from 6 March 2025 (the
 * date this instrument was made — it carries no separate commencement
 * clause of its own).
 *
 * Two rules, not one, because s.80(1) states two independent tests and a
 * person need only satisfy one:
 *  - s.80(1)(a): at least 90% of annual turnover from supplies to
 *    unregistered persons (a proportion test, not itself a euro figure);
 *  - s.80(1)(b): total annual turnover has not exceeded, and is not likely
 *    to exceed, €2,000,000 in any continuous 12-month period.
 *
 * Regulation 7 (restricting VAT deductibility for a person availing of the
 * cross-border SME exemption scheme) is deliberately NOT curated in this
 * pass — it is a distinct, narrower rule (the EU cross-border small-
 * enterprise scheme under new ss.92B-92D) that deserves its own review
 * rather than being folded in here, and is left for a future pass.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/** Matches the `irish_tax_rules.unit` column's enum (src/db/schema/irishRules.ts); not separately exported there. */
type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedSi692025Rule {
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
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
    ruleKey: 'vat.cash_accounting_turnover_threshold',
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

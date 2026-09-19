/**
 * Curated rules for S.I. 639/2010 (Value-Added Tax Regulations 2010),
 * as-made text (see `si639Parser.ts`'s header on why the whole 47-regulation
 * document is parsed rather than the paraphrased per-regulation files
 * already in docs/statutes/si-639-2010/ — those (`reg-14.md`, `reg-25.md`
 * etc.) are short hand-written summaries, not verbatim, and are NOT used as
 * sources here).
 *
 * Only Regulation 25 (moneys-received/cash basis of accounting) is curated
 * in this pass. It is a good first target because it is purely procedural —
 * an eligibility test and an authorisation process, no numeric threshold of
 * its own (the actual turnover threshold for VATCA s.80(1)(b) eligibility
 * lives in the Act, not this Regulation, and is not restated or curated
 * here) — so, unlike VATCA s.46 or TCA 1997 s.284, there is no stale-figure
 * risk to guard against.
 *
 * Regulation 14A (postponed accounting for import VAT) is NOT curated here
 * even though it is the single most requested RCT/VAT-adjacent procedure in
 * `docs/statutes/import-vat/`: reg.14A did not exist in this 2010 as-made
 * text at all — it was inserted by S.I. 734/2020, a separate instrument not
 * ingested here. `docs/statutes/si-639-2010/reg-14A-si-734-2020.md` is a
 * paraphrase of S.I. 734/2020's own text, not verbatim, so it cannot back a
 * rule under this KB's verbatim-only policy either.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export interface CuratedSi639Rule {
  regulationNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  vatEffect: string;
  reportingEffect: string | null;
  interpretationNote: string;
}

export const SI_639_CURATED_RULES: CuratedSi639Rule[] = [
  {
    regulationNumber: '25',
    ruleKey: 'vat.cash_accounting_requires_authorisation',
    ruleType: 'procedure',
    topic: 'vat',
    name: 'Cash (moneys-received) basis of VAT accounting requires a granted Revenue authorisation',
    statementExcerpt: 'Where the Commissioners consider that a person satisfies the requirements of '
      + 'section 80(1) of the Act, they shall authorise the person, by notice in writing, to use the '
      + 'moneys received basis of accounting',
    conditions: [
      { field: 'description', operator: 'matches', value: '\\b(cash basis|moneys received basis|money received basis)\\b' },
    ],
    exceptions: [
      {
        condition: 'the supply is to a person connected with the authorised person (reg.25(5))',
        effect: 'the cash-basis authorisation does not apply to that supply — normal (invoice-date) VAT timing applies instead',
      },
      {
        condition: 'the authorised person no longer satisfies the section 80(1) eligibility test for 4 '
          + 'consecutive calendar months and fails to notify Revenue within 30 days (reg.25(9))',
        effect: 'the authorisation is deemed cancelled, retrospective to the start of the taxable period '
          + 'when notification should have been made',
      },
    ],
    vatEffect: 'A business cannot simply elect to account for VAT on a cash-received basis by choice of '
      + 'bookkeeping method — it requires a written application to Revenue (name, registration number, '
      + 'nature of business, and turnover/customer-mix particulars supporting eligibility under VATCA '
      + 's.80(1)(a) or (b)) and a written authorisation from Revenue before it applies, and does not '
      + 'apply retroactively before that authorisation\'s effective date.',
    reportingEffect: 'Until authorised, VAT due is determined by reference to invoice date (accruals basis), '
      + 'not to when payment is received, regardless of the business\'s own accounting records.',
    interpretationNote: 'The description keyword match only flags a candidate mention of cash-basis '
      + 'accounting; it cannot verify whether the business genuinely holds a current, uncancelled Revenue '
      + 'authorisation, which is external state this KB has no access to. The actual turnover/customer-mix '
      + 'thresholds for eligibility (VATCA s.80(1)(a)/(b)) are stated in the Act itself, not this Regulation, '
      + 'and are not curated here — only the "authorisation is required, not automatic" procedural fact is.',
  },
];

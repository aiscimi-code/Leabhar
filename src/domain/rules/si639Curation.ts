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
  // Issue #645: the gift limit and the private-use formula that recordDeemedSupply
  // (src/domain/vat/deemedSupply.ts) applies. No conditions and a reference
  // topic: citable, never matched. The TaxSource "Current" view of both
  // regulations (checked October 2026) matches this as-made text.
  {
    regulationNumber: '5',
    ruleKey: 'vat.business_gift_limit',
    ruleType: 'threshold',
    topic: 'vat_reference',
    name: 'A business gift costing no more than €20 excluding VAT is not a supply (reg.5, VATCA s.21(a))',
    statementExcerpt: 'the cost of which to the donor does not exceed €20, exclusive of tax, shall be deemed not to '
      + 'have been effected for consideration.',
    conditions: [],
    exceptions: [
      { condition: 'the gift is one of a series or succession of gifts to the same person', effect: 'the limit does not apply: the gift is a supply' },
    ],
    vatEffect: 'No output VAT on a gift within the limit. Above it, the whole cost is taxed (VATCA s.42(1)(a)).',
    reportingEffect: null,
    interpretationNote: 'Enforced by recordDeemedSupply (BUSINESS_GIFT_LIMIT_MINOR). Amending instruments after 2010 '
      + 'are not ingested; the figure is the as-made text.',
  },
  {
    regulationNumber: '7',
    ruleKey: 'vat.immovable_goods_private_use_proportion',
    ruleType: 'other',
    topic: 'vat_reference',
    name: 'Private use of pre-2011 property: floor-area proportion, C x D / (20 x 6), standard rate (reg.7)',
    statementExcerpt: 'being immovable goods acquired or developed by an accountable person before 1 January 2011, the '
      + 'private use proportion shall be calculated in accordance with the following formula:',
    conditions: [],
    exceptions: [],
    vatEffect: 'Each taxable period: the taxable amount on the acquisition or development x private floor area / total '
      + 'floor area / 120, at the rate in VATCA s.46(1)(a) (reg.7(4)).',
    reportingEffect: 'T1 in the period of the use.',
    interpretationNote: 'Enforced by recordDeemedSupply. Amending instruments after 2010 are not ingested; the formula '
      + 'is the as-made text.',
  },
  {
    regulationNumber: '10',
    ruleKey: 'vat.bad_debt_relief',
    ruleType: 'relief',
    topic: 'vat_reference',
    name: 'Bad-debt relief: A x B / (100 + B) on the amount outstanding, claimed as deductible tax (reg.10(3), (4), (9))',
    statementExcerpt: 'is calculated in accordance with the following formula:\n\nA x\nB\n\n100+B',
    conditions: [],
    exceptions: [
      { condition: 'all reasonable steps to recover the debt have not been taken (reg.10(3)(a))', effect: 'no relief' },
      { condition: 'the debt is not allowable as a deduction under TCA 1997 s.81(2)(i), where the person is chargeable '
        + 'under Case I or II of Schedule D (reg.10(3)(b))', effect: 'no relief' },
      { condition: 'the debt is not written off in the financial accounts, or the reg.27(1)(m) records are not kept '
        + '(reg.10(3)(c))', effect: 'no relief' },
      { condition: 'the debtor was connected with the person (VATCA s.97(3)) at any time from the supply to the '
        + 'write-off (reg.10(3)(d))', effect: 'no relief' },
      { condition: 'goods supplied under a hire-purchase agreement (VATCA s.19(1)(c))', effect: 'relief is calculated '
        + 'under reg.10(5) instead' },
    ],
    vatEffect: 'The tax attributable to the amount outstanding, A x B / (100 + B), B the rate applied to the supply, is '
      + 'claimed as if it were deductible tax for the taxable period of the claim (reg.10(9)).',
    reportingEffect: 'T2 in the period the claim is made.',
    interpretationNote: 'Enforced by claimBadDebtRelief from the facts a person states, on an invoice written off on '
      + 'the invoice basis. Hire purchase (reg.10(5)-(7)), an invoice with lines at more than one rate, and an invoice '
      + 'in another currency are refused. The as-made text matches the current consolidated view (TaxSource, '
      + 'checked 2026-10-04).',
  },
  {
    regulationNumber: '10',
    ruleKey: 'vat.bad_debt_recovered',
    ruleType: 'relief',
    topic: 'vat_reference',
    name: 'A relieved bad debt later recovered: tax on the amount recovered is due for the period of recovery (reg.10(10))',
    statementExcerpt: 'the amount so recovered is treated as inclusive of tax,',
    conditions: [],
    exceptions: [],
    vatEffect: 'The amount recovered is treated as inclusive of tax; the tax on it is due and payable for the taxable '
      + 'period in which it is recovered.',
    reportingEffect: 'T1 in the period the debt is recovered.',
    interpretationNote: 'Enforced by reverseBadDebtWriteOff: reversing a write-off restores the whole debt, so the '
      + 'whole relief claimed is charged again, dated the reversal.',
  },
];

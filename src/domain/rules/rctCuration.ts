/**
 * Curated rules for Relevant Contracts Tax (RCT) — the withholding regime on
 * payments under a "relevant contract" in construction, forestry and meat
 * processing (docs/statutes/rct/README.md: "a withholding rate, never a VAT
 * rate... two independent regimes"). Sourced from two ingested documents:
 *
 *  - TCA 1997 s.530 (legislation, as-enacted-1997) — Chapter 2's foundational
 *    definitions (relevant contract, relevant operations, construction/
 *    forestry/meat-processing operations). Still current: TDM 18-02-04 §1
 *    itself says "this document should be read in conjunction with sections
 *    530 to 530V" — the 2011 electronic-RCT sections were inserted
 *    *alongside* s.530, not in place of it.
 *  - Revenue TDM Part 18-02-04 (revenue_guidance) — "RCT for Principal
 *    Contractors", the only verbatim source this KB holds for the actual
 *    2011-restructured procedure (TCA 1997 ss.530A-530V have no 1997
 *    as-enacted page to fetch — they were inserted by Finance Act 2011 s.20,
 *    a different Act not yet ingested here; see
 *    docs/statutes/tca-1997/README.md "Priority sections not yet added").
 *    Tagged `revenue_guidance`, never `legislation` — this KB's source
 *    hierarchy (sourceHierarchy.ts) exists precisely so Revenue's own
 *    explanation of a statutory scheme is never confused with, or allowed to
 *    outrank, the statute itself once that statute is ingested.
 *
 * **What is deliberately NOT curated here, and why:**
 *  - The actual 0%/20%/35% deduction rate for a given payment. Unlike
 *    VATCA's zero/reduced VAT rates (a fixed rate stated in the Act, keyed
 *    off what is supplied), RCT's rate is not a fact stated anywhere in the
 *    legislation or guidance for a *given* transaction — it is an
 *    individualised determination Revenue issues per payment notification,
 *    based on the subcontractor's own tax-compliance history (TDM
 *    18-02-04 §6: "the appropriate rate is to be determined for
 *    subcontractors"). No keyword match, no transaction field, and no
 *    provision text can supply it. Curating a rule that guessed a rate here
 *    would be exactly the "silently repaired" failure AGENTS.md's
 *    invariant #7 forbids — so `rct.deduction_rate_not_determinable` below
 *    states that fact as the rule, rather than a number.
 *  - S.I. 651/2011 (the 2011 eRCT Regulations) is NOT used as a source at
 *    all: TDM 18-02-04 §14 records that it "were subsequently revoked and
 *    replaced by [S.I. 576/2012]... These regulations came into effect on
 *    24 December 2012", itself later amended by S.I. 412/2013 and S.I.
 *    5/2015 — none of which are ingested. Building a "current procedure"
 *    rule from a superseded 2011 instrument would misstate the law even
 *    though the file is genuinely verbatim (see docs/statutes/si-651-2011/
 *    README.md).
 *
 * As with `vatcaScheduleCuration.ts`, every condition here is a description
 * keyword match against what is, in substance, a legal list (which
 * industries/operations RCT actually covers) — an imperfect proxy, not a
 * determination, so `requiresGuidance` is always true.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/**
 * Shared with `transactionLookup.ts`'s 'rct' topic test, so the topic router
 * and every curated condition below agree on what counts as an RCT
 * candidate — a transaction description mentioning construction, forestry
 * or meat-processing work.
 */
export const RCT_SCOPE_RE =
  '\\b(construction|building site|renovat|demolition|scaffolding|groundwork|'
  + 'forestry|felling|logging|tree surgery|meat processing|slaughter|abattoir|'
  + 'subcontractor)\\b';

export type RctSourceKind = 'tca1997_s530' | 'tdm_18_02_04';

export interface CuratedRctRule {
  source: RctSourceKind;
  /** The provision's section number ("530") or, for the whole-document TDM, "full". */
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  taxEffect: string | null;
  accountingEffect: string | null;
  reportingEffect: string | null;
  requiresGuidance: boolean;
  interpretationNote: string;
}

export const RCT_CURATED_RULES: CuratedRctRule[] = [
  {
    source: 'tca1997_s530',
    sectionNumber: '530',
    ruleKey: 'rct.relevant_operations_scope',
    ruleType: 'definition',
    topic: 'rct',
    name: 'RCT scope: construction, forestry or meat-processing operations',
    statementExcerpt: 'the construction, alteration, repair, extension, demolition or dismantling of buildings or structures',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [
      {
        condition: 'the contract is a contract of employment rather than a "relevant contract" '
          + '(a contract for services between two independent parties)',
        effect: 'RCT does not apply at all — this is ordinary payroll, not a subcontractor payment',
      },
    ],
    taxEffect: 'If this payment is genuinely under a relevant contract for construction, forestry or meat '
      + 'processing operations, it is a candidate for RCT withholding — see rct.payment_notification_required '
      + 'and rct.deduction_rate_not_determinable for what that requires. This rule only flags scope; it does '
      + 'not confirm a relevant contract exists.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'The condition is a keyword match on the transaction description against the three '
      + 'industries s.530(1) defines ("construction operations", "forestry operations", "meat processing '
      + 'operations"), each itself a list of specific activities in the source text — not a reading of the '
      + 'actual contract. A transaction mentioning "renovation" is a candidate, not a confirmed relevant '
      + 'contract (it could be a DIY retail purchase with no subcontractor involved at all); a genuine '
      + 'relevant-contract payment that happens not to use any of these words would be missed. Flags for '
      + 'review; never classifies outright.',
  },
  {
    source: 'tdm_18_02_04',
    sectionNumber: 'full',
    ruleKey: 'rct.payment_notification_required',
    ruleType: 'procedure',
    topic: 'rct',
    name: 'RCT procedure: payment notification required before payment',
    statementExcerpt: 'Section 530C TCA 1997 provides that, immediately before a principal makes a\n'
      + 'relevant payment to a subcontractor, the principal must notify Revenue of their\n'
      + 'intention to make such a payment.',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [
      {
        condition: 'a persistent technology systems failure leaves the principal unable to submit the '
          + 'payment notification in advance',
        effect: 'the principal may make the payment without prior notification, but must deduct at the rate '
          + 'last notified for that subcontractor (or 35% if none), then submit a late payment notification '
          + 'immediately once the systems failure is rectified — a penalty otherwise applies',
      },
    ],
    taxEffect: 'A payment notification must be submitted to Revenue (via ROS) immediately before this '
      + 'payment is made — not after. Making the payment without one first (absent the systems-failure '
      + 'exception) exposes the principal to a civil penalty under TDM 18-02-04 §7, proportionate to the '
      + 'subcontractor\'s deduction rate.',
    accountingEffect: 'Do not post/pay this transaction as an ordinary supplier payment without confirming '
      + 'a payment notification (and resulting deduction authorisation) exists for it.',
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Same keyword-match caveat as rct.relevant_operations_scope: this flags a candidate '
      + 'RCT payment from its description, it does not verify the payer is actually a registered "principal" '
      + 'or that a relevant contract exists. Sourced from Revenue guidance (TDM 18-02-04), not the statute '
      + 'text of s.530C itself, which is not yet ingested (see this file\'s own header) — the TDM\'s '
      + 'restatement of the section is quoted verbatim, but the underlying legislative wording has not been '
      + 'independently checked against it.',
  },
  {
    source: 'tdm_18_02_04',
    sectionNumber: 'full',
    ruleKey: 'rct.deduction_rate_not_determinable',
    ruleType: 'rate',
    topic: 'rct',
    name: 'RCT deduction rate cannot be determined from transaction data alone',
    statementExcerpt: 'There are three rates of tax that can apply to subcontractors',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [],
    taxEffect: 'The applicable rate (zero, 20%, or 35%) is set by Revenue\'s own deduction authorisation, '
      + 'issued in response to the principal\'s payment notification, based on the subcontractor\'s '
      + 'tax-compliance history at that moment — it is never stated in the contract, invoice, or transaction '
      + 'description, and this system has no way to derive it. Do not default to any rate; the deduction '
      + 'authorisation reference for this specific payment must be obtained and recorded before the payment '
      + 'is finalised.',
    accountingEffect: 'Where tax is deducted, only the net amount is paid to the subcontractor; the deducted '
      + 'amount is a liability to Revenue, not part of the subcontractor\'s income to the payer.',
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Unlike every other curated rule in this knowledge base, this rule is not an '
      + 'imperfect proxy for a determinable fact — the rate genuinely cannot be determined from any data a '
      + 'transaction record could hold, by design of the RCT scheme itself (AGENTS.md invariant #7: "nothing '
      + 'is silently repaired" — a detected RCT-candidate transaction with no recorded deduction-authorisation '
      + 'reference is a review item, never a defaulted-to-zero or defaulted-to-20% assumption). '
      + 'requiresGuidance is always true and always will be for this rule.',
  },
];

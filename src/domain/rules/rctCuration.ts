/**
 * Curated rules for Relevant Contracts Tax (RCT) — the withholding regime on
 * payments under a "relevant contract" in construction, forestry and meat
 * processing (docs/statutes/rct/README.md: "a withholding rate, never a VAT
 * rate... two independent regimes"). Sourced from these ingested documents:
 *
 *  - TCA 1997 s.530 (legislation, as-enacted-1997) — Chapter 2's foundational
 *    definitions (relevant contract, relevant operations, construction/
 *    forestry/meat-processing operations). Still current: TDM 18-02-04 §1
 *    itself says "this document should be read in conjunction with sections
 *    530 to 530V" — the 2011 electronic-RCT sections were inserted
 *    *alongside* s.530, not in place of it.
 *  - TCA 1997 ss.530A, 530E, 530G, 530H, 530I (legislation, as-enacted-2011;
 *    issue #131) — the load-bearing rate-determination sections, inserted
 *    by Finance Act 2011 s.20. No LRC-revised TCA 1997 exists for them
 *    (every `revisedacts.lawreform.ie` URL for ss.530A-530V 404s — see
 *    docs/statutes/tca-1997/README.md), so these were fetched from the
 *    eISB as-enacted Finance Act 2011 s.20 page instead, the inserting
 *    Act's own text, split one file per inserted section. s.530F (the
 *    principal's own 35%-when-no-authorisation liability) is quoted in
 *    prose in `rct.rate_default_35pct` below but not separately ingested —
 *    it states no new figure of its own (the same "35 per cent" s.530E(1)(c)
 *    already states) — and, along with the other fifteen inserted sections
 *    (530B-D, 530J-V), exists verbatim in docs/statutes/tca-1997/ for a
 *    future pass: they cover registration, returns, assessment, penalties
 *    and record-keeping mechanics already described (at the TDM level) by
 *    `rct.payment_notification_required` etc., not the rate itself.
 *  - Revenue TDM Part 18-02-04 (revenue_guidance) — "RCT for Principal
 *    Contractors", still the only verbatim source this KB holds for the
 *    2011-restructured payment-notification *procedure* (ss.530B/530C are
 *    verbatim in docs/statutes/ too but not ingested here; the TDM's own
 *    restatement remains what backs `rct.payment_notification_required`).
 *  - Revenue TDM Part 18-02-05 (revenue_guidance) — "RCT for Subcontractors".
 *    Its §3.5 states, verbatim, Revenue's own published criteria for the
 *    zero/20%/35% rate tiers (compliance history, fixed place of business,
 *    record keeping) — now that ss.530G/530H are ingested, this KB also
 *    holds the actual statutory test the TDM restates; both are kept.
 *  - TDM 18-02-01 (Relevant Operations) and 18-02-02 (Who is a Principal
 *    Contractor), both listed in docs/statutes/rct/README.md, are NOT used
 *    as sources here: both are still paraphrased summaries in this repo (no
 *    page markers, no source hash) — see `rctIngestion.ts`'s own header.
 *
 * Every Revenue-guidance source here is tagged `revenue_guidance`, never
 * `legislation` — this KB's source hierarchy (sourceHierarchy.ts) exists
 * precisely so Revenue's own explanation of a statutory scheme is never
 * confused with, or allowed to outrank, the statute itself once ingested.
 *
 * **What is still deliberately NOT curated here, and why (narrowed, not
 * closed, by issue #131 — see `rct.deduction_rate_not_determinable`):**
 *  - *Which* of the three tiers (zero/standard/35%) applies to a *given*
 *    payment. The tiers themselves are now real, statute-backed facts
 *    (`rct.rate_zero`, `rct.rate_default_35pct`, and the standard-rate
 *    cross-reference `rct.rate_standard_reference`), but which one a
 *    specific subcontractor gets is still an individualised determination
 *    Revenue issues per payment notification (TCA 1997 s.530I), based on
 *    the subcontractor's own tax-compliance history — not a fact any
 *    transaction record, keyword match, or provision text can supply.
 *    Curating a rule that guessed *which* tier applies would be exactly the
 *    "silently repaired" failure AGENTS.md's invariant #7 forbids.
 *  - The numeric value of "the standard rate (within the meaning of section
 *    3)" that ss.530E(1)(b)/530H cross-reference. TCA 1997 s.3 itself is
 *    not ingested, so `rct.rate_standard_reference` below states no
 *    `numericValue` — it would otherwise be asserting a figure this KB has
 *    not independently verified from source text (currently 20%, per
 *    Revenue's own public guidance, but that is not curated as a verified
 *    fact here).
 *  - S.I. 651/2011 (the 2011 eRCT Regulations) is NOT used as a source at
 *    all: TDM 18-02-04 §14 records that it "were subsequently revoked and
 *    replaced by [S.I. 576/2012]... These regulations came into effect on
 *    24 December 2012", itself later amended by S.I. 412/2013 and S.I.
 *    5/2015 — none of which are ingested. Building a "current procedure"
 *    rule from a superseded 2011 instrument would misstate the law even
 *    though the file is genuinely verbatim (see docs/statutes/si-651-2011/
 *    README.md).
 *
 * As with `vatcaScheduleCuration.ts`, every scope condition here is a
 * description keyword match against what is, in substance, a legal list
 * (which industries/operations RCT actually covers) — an imperfect proxy,
 * not a determination, so `requiresGuidance` is always true.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

/** Matches the `irish_tax_rules.unit` column's enum (src/db/schema/irishRules.ts); not separately exported there. */
type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

/**
 * Shared with `transactionLookup.ts`'s 'rct' topic test, so the topic router
 * and every curated condition below agree on what counts as an RCT
 * candidate — a transaction description mentioning construction, forestry
 * or meat-processing work.
 */
export const RCT_SCOPE_RE =
  '\\b(construction|building site|renovat\\w*|demolition|scaffolding|groundwork|'
  + 'forestry|felling|logging|tree surgery|meat processing|slaughter|abattoir|'
  + 'subcontractor)\\b';
// `renovat\w*`, not `renovat` (issue #143 finding C): a bare `\brenovat\b`
// only matches the literal four-letter stem as its own whole word, which
// never occurs in real English — "renovation"/"renovate"/"renovating" all
// failed to match at all, missing exactly the construction-on-a-dwelling
// overlap this scope regex exists to catch.

export type RctSourceKind =
  | 'tca1997_s530' | 'tca1997_s530a' | 'tca1997_s530e' | 'tca1997_s530g'
  | 'tca1997_s530h' | 'tca1997_s530i' | 'tdm_18_02_04' | 'tdm_18_02_05' | 'tdm_18_02_11';

export interface CuratedRctRule {
  source: RctSourceKind;
  /** The provision's section number ("530", "530E", ...) or, for the whole-document TDM, "full". */
  sectionNumber: string;
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
    numericValue: null,
    unit: null,
    qualifier: null,
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
    source: 'tca1997_s530a',
    sectionNumber: '530A',
    ruleKey: 'rct.principal_obligation_scope',
    ruleType: 'definition',
    topic: 'rct',
    name: 'RCT principal scope: who must operate RCT (TCA 1997 s.530A)',
    statementExcerpt: 'carrying on a business that includes the erection of buildings or the development of '
      + 'land (within the meaning of section 639(1)) or the manufacture, treatment or extraction of materials '
      + 'for use, whether used or not, in construction operations',
    numericValue: null,
    unit: null,
    qualifier: 'one of seven limbs in s.530A(1) — also a contractor under another relevant contract (a), a '
      + 'meat-processing or forestry-materials business (b)(ii)/(iii), a person connected with such a company '
      + '(c), a local authority/public utility society/certain Housing Act 1966 body (d), a Minister of the '
      + 'Government (e), a statutory or Oireachtas-funded royal-charter board (f), or a gas/water/electricity/'
      + 'hydraulic power/dock/canal/railway undertaking (g) — RCT "principal" status is broader than the '
      + 'obvious construction-industry business',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [
      {
        condition: 'a person erects buildings or develops land only for their own use/occupation or that of '
          + 'their employees, in the ordinary course of a different business (s.530A(2))',
        effect: 'that person is not deemed a principal by reason of that fact alone',
      },
      {
        condition: 'a person connected with a s.530A(1)(b) company makes a payment solely for construction '
          + 'operations on buildings/land used or occupied by themselves or their employees, and does not '
          + 'themselves carry on a s.530A(1)(b)(i) business (s.530A(3))',
        effect: 'that person is deemed not to be a principal under s.530A(1)(c)',
      },
    ],
    taxEffect: 'RCT is not confined to construction-industry businesses in the ordinary sense: TCA 1997 '
      + 's.530A(1) also makes a local authority, a Minister of the Government, a statutory board or body, and '
      + 'any gas/water/electricity/dock/canal/railway undertaking a "principal" for RCT purposes when they '
      + 'make a relevant payment. A payer outside the obvious construction/forestry/meat-processing industries '
      + 'can still owe RCT withholding obligations.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Statute text (TCA 1997 s.530A), not TDM paraphrase — genuinely new ground: no prior '
      + 'curated rule in this KB stated who counts as a "principal" beyond the industries '
      + 'rct.relevant_operations_scope already covers. `conditions` is the same RCT-scope keyword match as '
      + 'every rule in this file; it does not itself verify the payer is one of s.530A(1)\'s seven limbs.',
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
    numericValue: null,
    unit: null,
    qualifier: null,
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
    // Re-sourced from TCA 1997 s.530I itself (issue #131) — previously only
    // the TDM's paraphrase of this fact was available.
    source: 'tca1997_s530i',
    sectionNumber: '530I',
    ruleKey: 'rct.deduction_rate_not_determinable',
    // 'other', not 'rate' (issue #143 finding H): this states that no rate
    // can be determined, not a rate figure — a consumer filtering
    // `ruleType === 'rate'` (e.g. transactionLookup.ts's VAT rate
    // exclusivity) must never mistake it for a competing VAT/RCT rate.
    ruleType: 'other',
    topic: 'rct',
    name: 'RCT deduction rate cannot be determined from transaction data alone',
    statementExcerpt: 'the Revenue Commissioners shall, from time to time, determine whether a subcontractor '
      + 'is a person to whom section 530G applies, a person to whom section 530H applies or a person to whom '
      + 'neither section 530G nor 530H applies',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [],
    taxEffect: 'The applicable rate (zero — rct.rate_zero, standard — rct.rate_standard_reference, or 35% — '
      + 'rct.rate_default_35pct) is set by Revenue\'s own determination under s.530I, made in response to the '
      + 'principal\'s payment notification and notified to the subcontractor, based on the subcontractor\'s '
      + 'tax-compliance history at that moment — it is never stated in the contract, invoice, or transaction '
      + 'description, and this system has no way to derive it. Do not default to any rate; the deduction '
      + 'authorisation reference for this specific payment must be obtained and recorded before the payment '
      + 'is finalised.',
    accountingEffect: 'Where tax is deducted, only the net amount is paid to the subcontractor; the deducted '
      + 'amount is a liability to Revenue, not part of the subcontractor\'s income to the payer.',
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Unlike almost every other curated rule in this knowledge base, this rule is not an '
      + 'imperfect proxy for a determinable fact — *which* tier applies genuinely cannot be determined from '
      + 'any data a transaction record could hold, by design of the RCT scheme itself (AGENTS.md invariant #7: '
      + '"nothing is silently repaired" — a detected RCT-candidate transaction with no recorded '
      + 'deduction-authorisation reference is a review item, never a defaulted-to-zero or defaulted-to-standard '
      + 'assumption). requiresGuidance is always true and always will be for this rule. Issue #131 narrowed '
      + 'this rule\'s scope rather than retiring it: the three tiers themselves are now curated as real facts '
      + '(rct.rate_zero, rct.rate_standard_reference, rct.rate_default_35pct) from the actual statute, but '
      + 'which one a given subcontractor gets remains Revenue\'s own case-by-case call under s.530I, appealable '
      + 'within 30 days — see rct.rate_determination_and_appeal_procedure.',
  },
  {
    source: 'tca1997_s530e',
    sectionNumber: '530E',
    ruleKey: 'rct.rate_zero',
    ruleType: 'rate',
    topic: 'rct',
    name: 'RCT zero rate',
    statementExcerpt: 'shall be zero where the Revenue Commissioners have made a determination that the '
      + 'subcontractor is a person to whom section 530G applies',
    numericValue: 0,
    unit: 'percent',
    qualifier: 'applies only once Revenue has made a s.530I determination that the subcontractor is a person '
      + 'to whom s.530G applies (see rct.zero_rate_subcontractor_criteria) — not a default or an entitlement a '
      + 'subcontractor can assert unilaterally',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [],
    taxEffect: 'Where Revenue has determined a subcontractor is a s.530G ("zero rate") person, a principal\'s '
      + 'relevant payment to them is deducted at 0% — the full payment is made without RCT withholding. See '
      + 'rct.deduction_rate_not_determinable: this system cannot itself tell which subcontractor has this '
      + 'determination.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'States the zero-rate figure itself, now backed by the actual statute (TCA 1997 '
      + 's.530E(1)(a)) rather than only Revenue\'s TDM paraphrase. `conditions` gates on RCT scope only — it '
      + 'does not and cannot assert that *this* subcontractor has the s.530G determination; it always surfaces '
      + 'alongside rct.rate_standard_reference and rct.rate_default_35pct as the three real possibilities, '
      + 'never picked between.',
  },
  {
    source: 'tca1997_s530e',
    sectionNumber: '530E',
    ruleKey: 'rct.rate_standard_reference',
    ruleType: 'rate',
    topic: 'rct',
    name: 'RCT standard rate (cross-references TCA 1997 s.3, not itself ingested)',
    statementExcerpt: 'shall be the standard rate (within the meaning of section 3) in force at the time of '
      + 'payment where the Revenue Commissioners have made a determination that the subcontractor is a person '
      + 'to whom section 530H applies',
    // Deliberately null, not 20 (this file's own header explains why): s.3
    // itself is not ingested, so no figure is asserted here.
    numericValue: null,
    unit: null,
    qualifier: 'the rate is "the standard rate (within the meaning of section 3)" — TCA 1997 s.3 is not '
      + 'ingested in this KB, so no numeric figure is curated here; Revenue currently publishes this as 20%',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [],
    taxEffect: 'Where Revenue has determined a subcontractor is a s.530H ("standard rate") person, a '
      + 'principal\'s relevant payment to them is deducted at the TCA 1997 s.3 standard rate in force at the '
      + 'time of payment (see rct.standard_rate_subcontractor_criteria). This KB does not independently verify '
      + 'that rate\'s current numeric value.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Deliberately states no `numericValue` — see this file\'s own header for why asserting '
      + '20% here would be curating a figure this KB has not verified from ingested source text. A human '
      + 'reviewer applying this rule must obtain the current s.3 standard rate independently.',
  },
  {
    source: 'tca1997_s530e',
    sectionNumber: '530E',
    ruleKey: 'rct.rate_default_35pct',
    ruleType: 'rate',
    topic: 'rct',
    name: 'RCT 35% default/no-authorisation rate',
    statementExcerpt: 'shall be 35 per cent where the Revenue Commissioners have made a determination that the '
      + 'subcontractor is a person to whom neither section 530G nor section 530H apply',
    numericValue: 35,
    unit: 'percent',
    qualifier: 'applies both as Revenue\'s own default determination (s.530E(1)(c), where a subcontractor is '
      + 'neither a s.530G nor a s.530H person) and, independently, as a principal\'s own liability under '
      + 's.530F(2)(a) whenever a relevant payment is made without a deduction authorisation at all — the two '
      + 'provisions state the same 35% figure for different triggers',
    conditions: [
      { field: 'description', operator: 'matches', value: RCT_SCOPE_RE },
    ],
    exceptions: [],
    taxEffect: '35% is both the deduction rate for a subcontractor Revenue has determined is neither zero- nor '
      + 'standard-rate, and — separately, under s.530F(2)(a) — the rate a principal becomes personally liable '
      + 'to pay Revenue on a relevant payment made with no deduction authorisation at all, plus a penalty of '
      + '€5,000 or the tax amount (whichever is lower) unless the payment is declared in the next RCT return '
      + '(s.530F(2)(b)) before its due date. This is the one figure in this rule set with a genuinely '
      + 'unconditional trigger: making an RCT-candidate payment with no authorisation on file is always exposed '
      + 'to this liability, regardless of the actual subcontractor\'s compliance history.',
    accountingEffect: 'A relevant payment made without a recorded deduction authorisation should be treated as '
      + 'exposing the principal to a 35% Revenue liability plus a possible penalty — not assumed safe merely '
      + 'because no RCT line was deducted at payment time.',
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'States the 35% figure itself, now backed by the actual statute (TCA 1997 s.530E(1)(c) '
      + 'and s.530F(2)(a)) rather than only Revenue\'s TDM paraphrase. Still declaratory (RCT-scope gated, no '
      + 'authorisation-presence field): this KB does not track whether a deduction authorisation was actually '
      + 'obtained for a given payment.',
  },
  {
    source: 'tca1997_s530g',
    sectionNumber: '530G',
    ruleKey: 'rct.zero_rate_subcontractor_criteria',
    ruleType: 'other',
    topic: 'rct',
    name: 'RCT zero-rate criteria (statute text, TCA 1997 s.530G)',
    statementExcerpt: 'has throughout the previous 3 years complied with all the obligations imposed by the '
      + 'Tax Acts, the Capital Gains Tax Acts and the Value-Added Tax Acts',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [
      {
        condition: 'the Revenue Commissioners are satisfied, in all the circumstances, that a matter which '
          + 'would otherwise disqualify the person ought to be disregarded (s.530G(3))',
        effect: 'that specific shortfall does not by itself prevent the zero-rate determination',
      },
    ],
    taxEffect: 'TCA 1997 s.530G(1): a person qualifies for the zero rate only if Revenue is satisfied they are '
      + '(or are about to become) a subcontractor engaged in relevant operations, carry on business from a '
      + 'fixed place in a permanent building with the equipment/stock/facilities the business needs, properly '
      + 'keep the records s.886(2) requires, and have throughout the previous 3 years fully complied with all '
      + 'Tax Acts/CGT Acts/VAT Acts obligations (payment, return delivery, supplying information on request) — '
      + 'themselves or (for a partnership/company) every partner/director/15%+ shareholder. s.530G(2) excludes '
      + 'a partnership, company, or proprietary director/employee where that compliance test is not met '
      + 'throughout the group.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Supersedes `rct.subcontractor_compliance_criteria` as the load-bearing source for the '
      + 'zero-rate test — that rule (Revenue TDM 18-02-05, revenue_guidance) restates this same test but this '
      + 'one is the actual statute (legislation), which sourceHierarchy.ts treats as authoritative over it. '
      + 'Still descriptive, not evaluative: none of "3 years of compliance history", "fixed place of business", '
      + 'or "proper record keeping" is data a transaction record carries, so `conditions` is deliberately '
      + 'empty; this always surfaces alongside rct.deduction_rate_not_determinable, never instead of it.',
  },
  {
    source: 'tca1997_s530h',
    sectionNumber: '530H',
    ruleKey: 'rct.standard_rate_subcontractor_criteria',
    ruleType: 'other',
    topic: 'rct',
    name: 'RCT standard-rate criteria (statute text, TCA 1997 s.530H)',
    statementExcerpt: 'has throughout the previous 3 years complied substantially with the obligations imposed '
      + 'by the Tax Acts, the Capital Gains Tax Acts and the Value-Added Tax Acts',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    taxEffect: 'TCA 1997 s.530H(1): the same fixed-place-of-business, record-keeping and subcontractor-status '
      + 'criteria as the zero rate (rct.zero_rate_subcontractor_criteria), but only *substantial* — not full — '
      + '3-year compliance is required, and the person must not already be a s.530G person. s.530H(2) lets '
      + 'Revenue take into account "the extent to which any non-compliance is being addressed". s.530H(3) '
      + 'excludes a partnership where the group test is not met, and excludes anyone where Revenue forms the '
      + 'opinion that standard-rate deductions would leave that year\'s income tax liability unpaid.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Supersedes `rct.subcontractor_compliance_criteria` as the load-bearing source for the '
      + 'standard-rate test, the same way rct.zero_rate_subcontractor_criteria does for the zero rate — real '
      + 'statute (legislation) rather than only Revenue\'s TDM restatement of it. Still descriptive, not '
      + 'evaluative, for the same reason: none of this is data a transaction record carries.',
  },
  {
    source: 'tca1997_s530i',
    sectionNumber: '530I',
    ruleKey: 'rct.rate_determination_and_appeal_procedure',
    ruleType: 'procedure',
    topic: 'rct',
    name: 'RCT rate determination and appeal procedure (TCA 1997 s.530I)',
    statementExcerpt: 'a subcontractor who is aggrieved by the determination of the Revenue Commissioners may, '
      + 'by notice in writing given to the Revenue Commissioners within 30 days of the date of the '
      + 'determination, appeal to the Appeal Commissioners',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    taxEffect: 'TCA 1997 s.530I: Revenue determines, from time to time, which of the three tiers a '
      + 'subcontractor falls into and notifies them of it. A subcontractor aggrieved by that determination may '
      + 'appeal to the Appeal Commissioners within 30 days of notification; pending an appeal, Revenue may '
      + 'still issue a deduction authorisation on the existing determination, which remains valid and binding '
      + 'on the principal regardless of the appeal\'s outcome so far.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'Procedural context for rct.deduction_rate_not_determinable: explains *why* the rate '
      + 'cannot be looked up here (it is Revenue\'s own determination, not a fixed statutory fact), and gives a '
      + 'human reviewer the actual appeal mechanism if a subcontractor disputes their tier. `conditions` is '
      + 'deliberately empty, matching the other statute-sourced descriptive rules in this file.',
  },
  {
    source: 'tdm_18_02_05',
    sectionNumber: 'full',
    ruleKey: 'rct.subcontractor_compliance_criteria',
    ruleType: 'other',
    topic: 'rct',
    name: 'RCT rate criteria: 3-year tax compliance history, fixed place of business, record keeping',
    statementExcerpt: 'Subcontractor has throughout the previous 3 years complied with all the obligations\n'
      + 'imposed by the Tax Acts, the Capital Gains Tax Acts and the Value-Added Tax Acts, in\nrelation to:',
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [
      {
        condition: 'the Revenue Commissioners are satisfied the person will disregard a requirement in all '
          + 'the circumstances (sections 530G/530H "Revenue disregard")',
        effect: 'that specific requirement (e.g. a compliance or record-keeping shortfall) does not by itself '
          + 'prevent the zero or standard rate',
      },
    ],
    taxEffect: 'Per TDM 18-02-05 §3.5, Revenue\'s own published criteria for the zero rate require: the '
      + 'subcontractor is (or is about to become) engaged in relevant operations; a fixed place of business '
      + 'in a permanent building with the equipment/stock/facilities the business needs; proper record '
      + 'keeping (section 886(2)); and full compliance with all Tax Acts/CGT Acts/VAT Acts obligations '
      + '(payment, filing, supplying information) throughout the previous 3 years. The standard (20%) rate '
      + 'uses the same criteria but requires only *substantial* (not full) 3-year compliance, taking into '
      + 'account "the extent to which any non-compliance is being addressed". The 35% rate applies by default '
      + 'wherever the subcontractor is unknown/unregistered, or does not meet either set of criteria, or '
      + 'Revenue considers standard-rate deductions would leave the year\'s income tax liability unpaid.',
    accountingEffect: null,
    reportingEffect: null,
    requiresGuidance: true,
    interpretationNote: 'This is descriptive, not evaluative — it exists to give a human reviewer the real '
      + 'criteria Revenue applies (rather than nothing), never to let this system compute a rate from them. '
      + 'None of "3 years of compliance history", "fixed place of business", or "proper record keeping" is '
      + 'data a transaction record carries, so `conditions` is deliberately empty; this rule always surfaces '
      + 'alongside rct.deduction_rate_not_determinable, never instead of it. TCA 1997 ss.530E/530G/530H are '
      + 'now independently ingested and curated above (rct.rate_zero, rct.rate_standard_reference, '
      + 'rct.rate_default_35pct, rct.zero_rate_subcontractor_criteria, '
      + 'rct.standard_rate_subcontractor_criteria) — this rule is kept for its own citable text, but the '
      + 'statute-sourced rules now outrank it under sourceHierarchy.ts.',
  },
];

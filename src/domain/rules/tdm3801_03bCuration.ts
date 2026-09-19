/**
 * Curated rule for Revenue TDM Part 38-01-03b's "Exclusion from Mandatory
 * Electronic Filing and Payment of Tax" guidance.
 *
 * Closes a gap `si156Curation.ts` explicitly flagged: S.I. 156/2012 reg.5's
 * actual "capacity" exclusion criteria are not restated anywhere in this KB,
 * because the local si-156-2012 transcript only summarises regs 5-9 rather
 * than quoting them ("as in the official instrument"). This TDM is Revenue's
 * own current guidance on that same exclusion — a different source, lower in
 * the source hierarchy than the Regulation itself (`revenue_guidance`, not
 * `legislation` — see `sourceHierarchy.ts`), but genuinely verbatim and
 * citable in its own right, and it states both the application procedure
 * (apply in writing to your local tax office) and the "capacity" definition
 * the Regulation's own text was never available here to confirm.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export interface CuratedTdm3801_03bRule {
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

export const TDM_38_01_03B_CAPACITY_EXCLUSION_RULE: CuratedTdm3801_03bRule = {
  ruleKey: 'vat.mandatory_electronic_filing_capacity_exclusion',
  ruleType: 'procedure',
  topic: 'vat',
  name: 'Exclusion from mandatory electronic VAT filing/payment: capacity test and application procedure',
  statementExcerpt: 'If you do not have the capacity to make returns and payments electronically, you can apply to be\n'
    + 'excluded from the obligation to do so. Revenue may exclude a taxpayer from their obligation to\n'
    + 'pay and file electronically, if Revenue is satisfied that the taxpayer does not have the capacity* to\n'
    + 'do so. If you consider that you qualify for an exclusion you can apply in writing stating your\n'
    + 'reason(s) to your local tax office.\n'
    + '* Capacity means sufficient access to the Internet, by which either or both a specified return or\n'
    + 'the payment of any specified liabilities may be made by electronic means and, in the case of an\n'
    + 'individual, also means not prevented by reason of age, or mental or physical infirmity from either\n'
    + 'or both making a specified return or paying any specified liabilities by electronic means.',
  conditions: [
    { field: 'vatRegistered', operator: 'equals', value: 'true' },
  ],
  exceptions: [],
  vatEffect: 'The mandatory-electronic-filing obligation (S.I. 156/2012 reg.4) is not absolute: a taxpayer who '
    + 'lacks "capacity" — sufficient internet access, or (for an individual) is prevented by age or mental/'
    + 'physical infirmity from filing/paying electronically — can apply in writing to their local tax office to '
    + 'be excluded from it. This is Revenue guidance on the exclusion, not the Regulation\'s own text (which this '
    + 'KB does not hold verbatim — see si156Curation.ts), but it is a genuinely verbatim, current statement of '
    + 'the same exclusion from a lower-ranked but still citable source.',
  reportingEffect: 'A paper VAT filing from an accountable person is only a valid alternative to ROS where '
    + 'Revenue has actually granted a written capacity exclusion — this KB cannot itself verify whether one has '
    + 'been granted.',
  interpretationNote: 'This rule only flags the exclusion as a real, applyable-for procedure; it cannot verify '
    + 'whether a given business has actually applied for or been granted one, which is external state (a local '
    + 'tax office decision) this KB has no access to. It shares its topic and vatRegistered condition with '
    + 'vat.mandatory_electronic_filing so the two are always surfaced together.',
};

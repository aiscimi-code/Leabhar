/**
 * Curated rules for S.I. 156/2012 (Tax Returns and Payments (Mandatory
 * Electronic Filing and Payment of Tax) Regulations 2012).
 *
 * Only Regulation 4 (VAT-registered persons must file returns and pay by
 * electronic means) is curated. It is a compliance/procedure fact, not a tax
 * treatment: it does not change what a business owes, only how it must
 * submit and pay. There is no numeric figure to state and so no stale-figure
 * risk.
 *
 * Regulation 5 is curated separately as
 * `vat.mandatory_electronic_filing_capacity_exclusion` (#709). The exclusion
 * is this regulation, in force from 1 June 2012 (reg.1(2)), not TDM
 * 38-01-03b's May 2026 revision date. The TDM passage stays guidance.
 * Version 1 of that key remains the released TDM version; this regulation
 * is version 2 and does not rewrite version 1. The Regulation 4 exception
 * text is unchanged: it is part of the released version's content.
 */
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

export interface CuratedSi156Rule {
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

export const SI_156_CURATED_RULES: CuratedSi156Rule[] = [
  {
    regulationNumber: '4',
    ruleKey: 'vat.mandatory_electronic_filing',
    ruleType: 'procedure',
    topic: 'vat',
    name: 'VAT-accountable persons must file returns and pay VAT by electronic means',
    statementExcerpt: 'that specified person shall, on and from—\n\n(i) where subparagraph (a) applies, 1 June 2012, or\n\n'
      + '(ii) where subparagraph (b) applies, the date the specified person becomes an accountable person,\n\n'
      + 'make any specified return that is required to be made by or subsequent to that date, by or on behalf of '
      + 'that specified person, by electronic means and in accordance with Chapter 6 of Part 38 of the Principal Act.',
    conditions: [
      { field: 'vatRegistered', operator: 'equals', value: 'true' },
    ],
    exceptions: [
      {
        condition: 'the person is excluded under Regulation 5 (a "capacity" exclusion — insufficient internet '
          + 'access, or an individual prevented by age or infirmity from filing/paying electronically)',
        effect: 'the electronic-filing/payment obligation does not apply to that person; Regulation 5\'s own '
          + 'exclusion criteria are not curated here (see si156Parser.ts — this local file only summarises regs '
          + '5-9, it does not quote them), so this KB can flag the exception exists but cannot itself decide it',
      },
    ],
    vatEffect: 'A VAT-registered (accountable) person cannot file a VAT3 or pay VAT by cheque/paper as a matter '
      + 'of choice — Revenue Online Service (ROS) or another electronic channel is mandatory from the date the '
      + 'person became accountable (or 1 June 2012, if already accountable on that date), unless a Regulation 5 '
      + 'capacity exclusion applies.',
    reportingEffect: 'A paper VAT return or payment from an accountable person with no recorded capacity '
      + 'exclusion is a compliance exception this KB should flag, not a valid alternative filing method.',
    interpretationNote: 'The `vatRegistered` condition only tells this KB the business is VAT-registered; it '
      + 'cannot verify whether Revenue has actually granted a Regulation 5 capacity exclusion, which is external '
      + 'state this KB has no access to. Treat every VAT-registered person as subject to the electronic-filing '
      + 'obligation unless a human confirms an exclusion is in place.',
  },
];

/**
 * Regulation 5, the capacity exclusion. Kept out of `SI_156_CURATED_RULES`
 * so the Regulation 4 rule, whose released version must not change, is
 * derived as before. Derived after the TDM version so this is version 2 (#709).
 */
export const SI_156_CAPACITY_EXCLUSION: CuratedSi156Rule = {
  regulationNumber: '5',
  ruleKey: 'vat.mandatory_electronic_filing_capacity_exclusion',
  ruleType: 'procedure',
  topic: 'vat',
  name: 'Exclusion from mandatory electronic filing and payment on grounds of capacity',
  statementExcerpt: "5. (1) A specified person may, by notifying the Commissioners in writing, request to be excluded from the provisions of these Regulations on the grounds that the specified person does not have the capacity to make a specified return or pay the specified tax liabilities by electronic means and the notification shall include all information relevant to the consideration by the Commissioners of the request.\n\n(2) Where the Commissioners receive a notification from a specified person in accordance with paragraph (1) or where the Commissioners otherwise consider it appropriate, they may exclude the specified person from the provisions of these Regulations only if they are satisfied that, in all of the circumstances, the specified person could not reasonably be expected to have the capacity to make a specified return or to make a payment of specified tax liabilities by electronic means.\n\n(3) A decision to exclude a specified person from the provisions of these Regulations by the Commissioners in accordance with paragraph (2) may be made at any time but where a notification has been received from a specified person in accordance with paragraph (1) the decision shall be made within 30 days of receipt of the notification, and the Commissioners shall, in all cases, notify the specified person in writing of the decision.",
  conditions: [
    { field: 'vatRegistered', operator: 'equals', value: 'true' },
  ],
  exceptions: [],
  vatEffect: 'S.I. 156/2012 reg.5: the Commissioners may exclude a specified person from these Regulations '
    + 'only if satisfied that the person could not reasonably be expected to have the capacity to file or pay '
    + 'by electronic means. Capacity is defined in reg.2(1). The exclusion is applied for in writing; this rule '
    + 'cannot tell whether one has been granted.',
  reportingEffect: 'A paper VAT filing from an accountable person is an alternative to electronic filing only '
    + 'where the Commissioners have excluded that person under Regulation 5.',
  interpretationNote: 'The start date is 1 June 2012, Regulation 1(2), the same commencement as '
    + 'vat.mandatory_electronic_filing. The May 2026 date on version 1 is the TDM revision date and is not '
    + "the exclusion's start (#709). Revenue TDM 38-01-03b explains the test; it does not originate the rule.",
};

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
 * Regulation 5 (capacity exclusions — the carve-out for a person genuinely
 * unable to file electronically) is **not** curated: `si156Parser.ts`'s
 * header explains that this local file only summarises regs 5-9 in a single
 * editorial sentence rather than quoting their text, so the actual exclusion
 * criteria are not available verbatim here. The curated rule's own
 * `exceptions` records the *fact* that an exclusion regime exists, without
 * asserting what specifically qualifies for it — asserting that would be
 * inventing text this KB does not hold.
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

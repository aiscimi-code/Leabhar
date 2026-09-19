/**
 * Curated rules for the CURRENT VAT rates, from VATCA 2010 s.46 in its
 * LRC-revised form (docs/statutes/vatca-2010-revised/s046.md) —
 * deliberately never from the as-enacted text `vatcaCuration.ts` reads.
 *
 * `vatcaCuration.ts`'s own header explains why s.46 was left uncurated
 * there: the as-enacted text states 21%/13.5%/4.8%/0% as they stood in
 * 2010, and the standard rate has since changed (23% today) by later
 * Finance Acts not ingested — "curating that figure as a live rule would
 * let a current transaction resolve against a stale rate with no signal
 * that it is wrong". This file exists because that reasoning no longer
 * applies: the LRC-revised text is the *current* wording, kept up to date
 * by the Law Reform Commission itself, not a frozen 2010 snapshot. Ingesting
 * it (`vatcaRevisedIngestion.ts`) as its own source — never merged with the
 * as-enacted text — is what makes curating s.46 safe now.
 *
 * Unlike every other curated VATCA rule so far, these rules carry a real
 * `numericValue`/`unit: 'percent'`: the rate is a plain fact stated in the
 * text, not a legal test to map onto `TransactionContext` fields (that
 * categorisation work is what `vatcaScheduleCuration.ts`'s Schedule 2/3
 * rules already do). `conditions` is empty for the same reason
 * `vat.charge_general` (s.3) has none in `vatcaCuration.ts`: this states a
 * rate exists, not a condition to evaluate against a transaction.
 *
 * `effectiveFrom` for the standard-rate rule (2021-03-01) is not a guess:
 * s.46(1A)'s own text states a temporary substitution of "21 per cent" for
 * "23 per cent" running only "from 1 September 2020 to 28 February 2021" —
 * which is itself proof, straight from the statute's own words, that 23%
 * applies immediately outside that window, including from 1 March 2021.
 * The 13.5%/4.8% rules carry no comparable textual evidence of an exact
 * commencement date, so their `effectiveFrom` is the date this KB last
 * confirmed them against the (continuously-updated) LRC text, not a claim
 * about how long they have actually been in force — see each rule's own
 * `interpretationNote`.
 *
 * Deliberately NOT curated here: the temporary/narrow 9% sub-rates in
 * paragraphs (ca)/(caa)/(cab)/(cac)/(cb), each scoped to specific Schedule 3
 * items during a specific date window (one of which, (cac), is in force at
 * the time of writing). Modelling five separate date-boxed rates correctly
 * needs the same care as the headline rates and is left for a future pass
 * rather than rushed through here.
 */
import type { IrishRuleType } from '@/db/schema';

export interface CuratedVatcaRevisedRule {
  citation: string;
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  topic: string;
  name: string;
  statementExcerpt: string;
  extractedFact: string;
  numericValue: number;
  unit: 'percent';
  qualifier: string | null;
  vatEffect: string;
  effectiveFrom: string;
  interpretationNote: string;
}

export const VATCA_REVISED_CURATED_RULES: CuratedVatcaRevisedRule[] = [
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_standard_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current standard VAT rate: 23%',
    statementExcerpt: '23 per\ncent\nof the amount on which tax is\nchargeable',
    extractedFact: '23 per cent',
    numericValue: 23, // plain percent number, matching factExtractor.ts's own convention (not basis points)
    unit: 'percent',
    qualifier: 'the rate under paragraph (a), the default rate outside the zero/reduced/livestock cases in the other paragraphs',
    vatEffect: 'The standard VAT rate is 23%, chargeable on a supply of goods or services, an intra-Community '
      + 'acquisition, or an importation, unless a zero rate (Schedule 2), reduced rate (Schedule 3), one of the '
      + 'narrower temporary 9% carve-outs, or the 4.8% livestock rate applies instead.',
    effectiveFrom: '2021-03-01',
    interpretationNote: 'Supersedes VATCA_CURATED_RULES\' deliberate non-curation of the as-enacted s.46 (2010: '
      + '21%). This rule has no `conditions`: it is the fallback rate, not a test — a transaction only reaches it '
      + 'when no zero-rate (Schedule 2), reduced-rate (Schedule 3), or other specific-rate rule already matched.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_reduced_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current reduced VAT rate: 13.5%',
    statementExcerpt: '13.5 per cent of the\namount on which tax is chargeable in relation to goods or services of a kind\nspecified in',
    extractedFact: '13.5 per cent',
    numericValue: 13.5,
    unit: 'percent',
    qualifier: 'the general reduced rate under paragraph (c), for goods/services of a kind specified in Schedule 3 '
      + '(subject to the narrower 9% carve-outs in the same subsection for specific Schedule 3 items)',
    vatEffect: 'The general reduced VAT rate is 13.5%, applying to goods/services of a kind specified in Schedule 3 '
      + '(see vatcaScheduleCuration.ts for which specific paragraphs are curated), except where one of the '
      + 'narrower temporary 9% carve-outs applies instead.',
    effectiveFrom: '2010-11-01',
    interpretationNote: 'No comparable textual evidence exists (unlike the standard rate\'s s.46(1A)) pinning an '
      + 'exact commencement date for 13.5% distinct from the Act\'s own 2010 enactment; the source text as '
      + 'currently retrieved states 13.5% with no stated historical change, so the Act\'s own commencement date '
      + 'is used pending closer verification, not asserted as independently confirmed.',
  },
  {
    citation: '2010 Act 31 s.46',
    sectionNumber: '46',
    ruleKey: 'vat.rate_livestock_current',
    ruleType: 'rate',
    topic: 'vat',
    name: 'Current livestock VAT rate: 4.8%',
    statementExcerpt: '4.8 per cent of\nthe amount on which tax is chargeable in relation to the supply of livestock',
    extractedFact: '4.8 per cent',
    numericValue: 4.8,
    unit: 'percent',
    qualifier: 'paragraph (d), the supply of livestock',
    vatEffect: 'A special 4.8% VAT rate applies to the supply of livestock.',
    effectiveFrom: '2010-11-01',
    interpretationNote: 'Same caveat as vat.rate_reduced_current: no textual evidence of a commencement date '
      + 'distinct from the Act\'s own 2010 enactment is present in this section, so that date is used as a '
      + 'placeholder pending closer verification.',
  },
];

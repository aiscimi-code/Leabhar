import type { CuratedIncomeTaxRule } from './incomeTaxCuration';

/** The citation of S.I. 312/1996 art. 92's source (catalogue/si-312-1996/art92.json). */
export const SI_312_1996_ART92_CITATION = 'S.I. 312/1996 s.92';

/**
 * The prescribed amount below which a self-employed contributor is excepted
 * (SWCA 2005 Sch. 1 Part 3 para. 3). Not in s.21 — that is why the collected
 * SWCA sections never had it.
 */
export const PRSI_CLASS_S_DISREGARD_RULE: CuratedIncomeTaxRule = {
  citation: SI_312_1996_ART92_CITATION,
  sectionNumber: '92',
  ruleKey: 'prsi.class_s_disregard',
  ruleType: 'threshold',
  name: 'PRSI Class S: no contribution below the €5,000 prescribed amount',
  statementExcerpt: 'shall be €5,000 in a contribution year.',
  numericValue: 500_000,
  unit: 'eur_minor',
  effectiveFrom: '2011-01-01',
  effectiveTo: null,
  interpretationNote: 'S.I. 312/1996 art. 92: the prescribed amount for SWCA 2005 Sch. 1 Part 3 para. 3 is '
    + '€5,000 in a contribution year. Substituted from 1 January 2011 by S.I. 684/2010 art. 6. Below this '
    + 'amount a self-employed contributor is excepted and no Class S (including the €650 minimum) is payable.',
};

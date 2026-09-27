import { describe, it, expect } from 'vitest';
import { ctDecisions } from '@/db/schema';
import { CT_SUBJECT_TYPES, isCtSubjectType, recordCtDecision as fromSubjects, CtDecisionError } from './subjects';
import { recordCtDecision as fromComputation, CtDecisionError as ErrorFromComputation } from './computation';

describe('ct decision subjects', () => {
  it('are one list: the schema enum, the choice map and the action allow-list agree', () => {
    // A subject the computations can offer but the year-end action refuses is
    // a decision nobody can record (#509's trading_company, #511's elections).
    expect([...CT_SUBJECT_TYPES].sort()).toEqual([...ctDecisions.subjectType.enumValues].sort());
    for (const subject of ['trading_company', 'basis_election', 'allowance_loss_election']) {
      expect(isCtSubjectType(subject)).toBe(true);
    }
    expect(isCtSubjectType('not_a_subject')).toBe(false);
  });

  it('are defined once: the computation re-exports the same functions and error class', () => {
    expect(fromComputation).toBe(fromSubjects);
    expect(ErrorFromComputation).toBe(CtDecisionError);
  });
});

import { describe, it, expect } from 'vitest';
import { evaluateCondition, evaluateAllConditions } from './conditionEval';

describe('evaluateCondition', () => {
  it('contains is normalised (case/whitespace-insensitive)', () => {
    const r = evaluateCondition(
      { field: 'description', operator: 'contains', value: 'vercel inc' },
      { description: 'CARD PAYMENT VERCEL INC.' },
    );
    expect(r.passed).toBe(true);
  });

  it('numeric gt/lt/between compare correctly', () => {
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 500 }, { amount: 600 }).passed).toBe(true);
    expect(evaluateCondition({ field: 'amount', operator: 'lt', value: 500 }, { amount: 600 }).passed).toBe(false);
    expect(evaluateCondition({ field: 'amount', operator: 'between', value: [100, 200] }, { amount: 150 }).passed).toBe(true);
  });

  it('is_null passes for missing/empty, fails for present', () => {
    expect(evaluateCondition({ field: 'x', operator: 'is_null', value: null }, {}).passed).toBe(true);
    expect(evaluateCondition({ field: 'x', operator: 'is_null', value: null }, { x: 'set' }).passed).toBe(false);
  });

  it('a missing field fails every non-is_null operator, never matches by accident', () => {
    const r = evaluateCondition({ field: 'supplierCountry', operator: 'equals', value: 'US' }, {});
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/empty/);
  });

  it('an invalid regex in "matches" fails safely rather than matching everything', () => {
    const r = evaluateCondition({ field: 'x', operator: 'matches', value: '(unclosed' }, { x: 'anything' });
    expect(r.passed).toBe(false);
  });

  it('a custom label function is used in the detail message', () => {
    const r = evaluateCondition(
      { field: 'supplierCountry', operator: 'equals', value: 'IE' },
      { supplierCountry: 'US' },
      (f) => (f === 'supplierCountry' ? 'The supplier country' : `"${f}"`),
    );
    expect(r.detail).toContain('The supplier country');
  });
});

describe('evaluateAllConditions', () => {
  it('requires every condition to pass (AND)', () => {
    const { allPassed } = evaluateAllConditions(
      [
        { field: 'a', operator: 'equals', value: '1' },
        { field: 'b', operator: 'equals', value: '2' },
      ],
      { a: '1', b: '3' },
    );
    expect(allPassed).toBe(false);
  });

  it('an empty condition list does not pass by this evaluator\'s own default (callers decide the empty-list policy)', () => {
    const { allPassed } = evaluateAllConditions([], { a: '1' });
    expect(allPassed).toBe(false);
  });
});

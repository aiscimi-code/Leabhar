import { describe, it, expect } from 'vitest';
import { classSPrsiMinor } from './classSPrsi';

describe('classSPrsiMinor (#487)', () => {
  const rate = 420;
  const minimum = 65_000;
  const disregard = 500_000;

  it('charges nothing below the €5,000 prescribed amount', () => {
    expect(classSPrsiMinor(300_000, rate, minimum, disregard)).toBe(0);
    expect(classSPrsiMinor(499_999, rate, minimum, disregard)).toBe(0);
  });

  it('applies the €650 floor at and just above the prescribed amount', () => {
    expect(classSPrsiMinor(500_000, rate, minimum, disregard)).toBe(65_000);
    expect(classSPrsiMinor(600_000, rate, minimum, disregard)).toBe(65_000);
  });

  it('charges 4.2% once that exceeds the €650 floor', () => {
    expect(classSPrsiMinor(6_000_000, rate, minimum, disregard)).toBe(252_000);
  });
});

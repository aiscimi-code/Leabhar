import { describe, it, expect } from 'vitest';
import { classSPrsiMinor } from './classSPrsi';

describe('classSPrsiMinor (#487)', () => {
  const whole = (incomeMinor: number) => [{ incomeMinor, rateBasisPoints: 420 }];
  const minimum = 65_000;
  const disregard = 500_000;

  it('charges nothing below the €5,000 prescribed amount', () => {
    expect(classSPrsiMinor(whole(300_000), minimum, disregard)).toBe(0);
    expect(classSPrsiMinor(whole(499_999), minimum, disregard)).toBe(0);
  });

  it('applies the €650 floor at and just above the prescribed amount', () => {
    expect(classSPrsiMinor(whole(500_000), minimum, disregard)).toBe(65_000);
    expect(classSPrsiMinor(whole(600_000), minimum, disregard)).toBe(65_000);
  });

  it('charges 4.2% once that exceeds the €650 floor', () => {
    expect(classSPrsiMinor(whole(6_000_000), minimum, disregard)).toBe(252_000);
  });

  it('charges each part of a year split by a rate change at its own rate (#711)', () => {
    // €60,000 for 2026: nine months at 4.2%, three at 4.35%.
    const parts = [{ incomeMinor: 4_500_000, rateBasisPoints: 420 }, { incomeMinor: 1_500_000, rateBasisPoints: 435 }];
    expect(classSPrsiMinor(parts, minimum, disregard)).toBe(189_000 + 65_250);
  });

  it('tests the floor and the prescribed amount on the whole year, not each part', () => {
    // €12,000 split 9:3: 4.2% of €9,000 plus 4.35% of €3,000 is €508.50, under €650.
    const parts = [{ incomeMinor: 900_000, rateBasisPoints: 420 }, { incomeMinor: 300_000, rateBasisPoints: 435 }];
    expect(classSPrsiMinor(parts, minimum, disregard)).toBe(65_000);
    // €6,000 split 9:3: neither part reaches €5,000, but the year does.
    expect(classSPrsiMinor([{ incomeMinor: 450_000, rateBasisPoints: 420 }, { incomeMinor: 150_000, rateBasisPoints: 435 }],
      minimum, disregard)).toBe(65_000);
  });
});

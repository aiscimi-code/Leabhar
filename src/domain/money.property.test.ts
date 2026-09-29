import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  asMinor, MoneyError, add, subtract, negate, vatFromNet, vatFromGross, netFromGross,
  multiplyRational, BASIS_POINTS_SCALE,
} from './money';

/**
 * Property tests for the money primitives (#597). These complement the
 * example-based suite in money.test.ts: they check the AGENTS.md invariants
 * across generated inputs instead of the cases someone thought to write down.
 */
describe('money properties (#597)', () => {
  it('asMinor rejects any non-integer, non-finite, or unsafe input', () => {
    fc.assert(fc.property(fc.double({ noNaN: false }), (n) => {
      const ok = Number.isFinite(n) && Number.isInteger(n) && Number.isSafeInteger(n);
      if (ok) {
        expect(asMinor(n)).toBe(n);
      } else {
        expect(() => asMinor(n)).toThrow(MoneyError);
      }
    }), { numRuns: 200 });
  });

  it('asMinor accepts every safe integer, including negatives and zero', () => {
    fc.assert(fc.property(fc.maxSafeInteger(), (n) => {
      expect(asMinor(n)).toBe(n);
    }), { numRuns: 100 });
  });

  it('add is commutative and has zero as identity', () => {
    const amt = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
    fc.assert(fc.property(amt, amt, (a, b) => {
      expect(add(a, b)).toBe(add(b, a));
      expect(add(a, 0)).toBe(a);
    }), { numRuns: 100 });
  });

  it('subtract(a, b) equals add(a, negate(b))', () => {
    const amt = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
    fc.assert(fc.property(amt, amt, (a, b) => {
      expect(subtract(a, b)).toBe(add(a, negate(b)));
    }), { numRuns: 100 });
  });

  it('net + VAT extracted from a gross amount reconstructs that gross', () => {
    const rate = fc.constantFrom(0, 90, 480, 1350, 2300, 2100);
    const gross = fc.integer({ min: 0, max: 100_000_000 });
    fc.assert(fc.property(gross, rate, (g, r) => {
      expect(netFromGross(g, r) + vatFromGross(g, r)).toBe(g);
    }), { numRuns: 200 });
  });

  it('vatFromNet equals multiplyRational at the basis-point scale', () => {
    const net = fc.integer({ min: 0, max: 50_000_000 });
    const rate = fc.integer({ min: 0, max: 10_000 });
    fc.assert(fc.property(net, rate, (n, r) => {
      expect(vatFromNet(n, r)).toBe(multiplyRational(n, r, BASIS_POINTS_SCALE));
    }), { numRuns: 100 });
  });
});

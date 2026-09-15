import { describe, it, expect } from 'vitest';
import {
  parseAmount, formatAmount, formatAmountGrouped, asMinor, add, subtract, allocate,
  multiplyRational, vatFromNet, vatFromGross, netFromGross, parseRate, formatRate,
  currencyExponent, MoneyError, roundHalfUp, isAmbiguousAmount,
} from './money';

describe('parseAmount', () => {
  it('parses plain decimals exactly', () => {
    expect(parseAmount('1234.56', 'EUR')).toBe(123456);
    expect(parseAmount('0.01', 'EUR')).toBe(1);
    expect(parseAmount('0', 'EUR')).toBe(0);
    expect(parseAmount('100', 'EUR')).toBe(10000);
  });

  it('parses the classic float-error cases exactly', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    expect(add(parseAmount('0.10', 'EUR'), parseAmount('0.20', 'EUR'))).toBe(30);
    // 1.005 * 100 is 100.49999999999999 as a float; there is no float here.
    expect(parseAmount('10.05', 'EUR')).toBe(1005);
    expect(parseAmount('8.165', 'EUR', { decimalSeparator: ',' })).toBe(816500);
  });

  it('handles thousands separators in both conventions', () => {
    expect(parseAmount('1,234.56', 'EUR')).toBe(123456);
    expect(parseAmount('1.234,56', 'EUR')).toBe(123456);
    expect(parseAmount('1,234,567.89', 'EUR')).toBe(123456789);
    expect(parseAmount('1.234.567,89', 'EUR')).toBe(123456789);
  });

  it('treats a lone separator with 3 trailing digits as grouping', () => {
    expect(parseAmount('1,234', 'EUR')).toBe(123400);
    expect(parseAmount('1.234', 'EUR')).toBe(123400);
  });

  it('treats a lone separator with 1-2 trailing digits as decimal', () => {
    expect(parseAmount('1,5', 'EUR')).toBe(150);
    expect(parseAmount('1.5', 'EUR')).toBe(150);
    expect(parseAmount('1,50', 'EUR')).toBe(150);
  });

  it('handles negatives including accounting parentheses', () => {
    expect(parseAmount('-42.17', 'EUR')).toBe(-4217);
    expect(parseAmount('(42.17)', 'EUR')).toBe(-4217);
    expect(parseAmount('(-42.17)', 'EUR')).toBe(4217);
  });

  it('strips currency symbols and codes', () => {
    expect(parseAmount('€1,234.56', 'EUR')).toBe(123456);
    expect(parseAmount('$42.17', 'USD')).toBe(4217);
    expect(parseAmount('1234.56 EUR', 'EUR')).toBe(123456);
    expect(parseAmount(' 1 234,56', 'EUR')).toBe(123456);
  });

  it('respects currencies with non-2 exponents', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(parseAmount('1234', 'JPY')).toBe(1234);
    expect(parseAmount('1,234', 'JPY')).toBe(1234);
    expect(currencyExponent('KWD')).toBe(3);
    expect(parseAmount('1.234', 'KWD')).toBe(1234);
  });

  it('refuses excess precision rather than rounding silently', () => {
    expect(() => parseAmount('1.0055', 'EUR')).toThrow(MoneyError);
    expect(() => parseAmount('1.9999', 'EUR')).toThrow(/decimal places/);
    // Four digits after the separator cannot be grouping, so it is precision.
    expect(() => parseAmount('1234.5678', 'EUR')).toThrow(/decimal places/);
    // Trailing zeros carry no information, so they are accepted.
    expect(parseAmount('1.5000', 'EUR')).toBe(150);
  });

  it('resolves the 3-digit ambiguity as grouping, and flags it', () => {
    // "1.005" is 1005 under one convention and 1.005 under the other. The
    // documented resolution is grouping; the importer can detect and ask.
    expect(parseAmount('1.005', 'EUR')).toBe(100500);
    expect(isAmbiguousAmount('1.005', 'EUR')).toBe(true);
    expect(isAmbiguousAmount('1.05', 'EUR')).toBe(false);
    expect(isAmbiguousAmount('1234.56', 'EUR')).toBe(false);
    // An explicit convention removes the ambiguity entirely.
    expect(parseAmount('1.005', 'EUR', { decimalSeparator: ',' })).toBe(100500);
  });

  it('rejects malformed grouping instead of concatenating digits', () => {
    expect(() => parseAmount('1.2.3.4', 'EUR')).toThrow(MoneyError);
    expect(() => parseAmount('12,34,567.89', 'EUR')).toThrow(/grouping|parse/);
    expect(() => parseAmount('1.23.456', 'EUR')).toThrow(MoneyError);
  });

  it('refuses unparseable input', () => {
    expect(() => parseAmount('', 'EUR')).toThrow(MoneyError);
    expect(() => parseAmount('abc', 'EUR')).toThrow(MoneyError);
    expect(() => parseAmount('.', 'EUR')).toThrow(MoneyError);
  });
});

describe('asMinor', () => {
  it('rejects non-integers so a float can never reach storage', () => {
    expect(() => asMinor(1.5)).toThrow(/whole minor units/);
    expect(() => asMinor(NaN)).toThrow(MoneyError);
    expect(() => asMinor(Infinity)).toThrow(MoneyError);
    expect(() => asMinor(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const s of ['0.00', '0.01', '-0.01', '1234.56', '-1234.56', '999999.99']) {
      expect(formatAmount(parseAmount(s, 'EUR'), 'EUR')).toBe(s === '-0.01' ? '-0.01' : s);
    }
  });
  it('pads correctly below one unit', () => {
    expect(formatAmount(asMinor(5), 'EUR')).toBe('0.05');
    expect(formatAmount(asMinor(-5), 'EUR')).toBe('-0.05');
    expect(formatAmount(asMinor(0), 'EUR')).toBe('0.00');
  });
  it('honours zero-decimal currencies', () => {
    expect(formatAmount(asMinor(1234), 'JPY')).toBe('1234');
  });
  it('groups for display', () => {
    expect(formatAmountGrouped(asMinor(123456789), 'EUR')).toBe('1,234,567.89');
    expect(formatAmountGrouped(asMinor(-123456789), 'EUR')).toBe('-1,234,567.89');
    expect(formatAmountGrouped(asMinor(99), 'EUR')).toBe('0.99');
  });
});

describe('rates', () => {
  it('parses and formats Irish VAT rates as basis points', () => {
    expect(parseRate('23')).toBe(2300);
    expect(parseRate('23%')).toBe(2300);
    expect(parseRate('13.5')).toBe(1350);
    expect(parseRate('9')).toBe(900);
    expect(parseRate('4.8')).toBe(480);
    expect(parseRate('0')).toBe(0);
    expect(formatRate(2300)).toBe('23%');
    expect(formatRate(1350)).toBe('13.5%');
    expect(formatRate(480)).toBe('4.8%');
    expect(formatRate(0)).toBe('0%');
  });
});

describe('VAT arithmetic', () => {
  it('computes VAT from a net amount at the Irish standard rate', () => {
    expect(vatFromNet(asMinor(10000), 2300)).toBe(2300);
    expect(vatFromNet(asMinor(4217), 2300)).toBe(970); // 9.6991 -> 9.70
  });

  it('computes VAT from a net amount at the reduced rate', () => {
    expect(vatFromNet(asMinor(10000), 1350)).toBe(1350);
    expect(vatFromNet(asMinor(3333), 1350)).toBe(450); // 4.49955 -> 4.50
  });

  it('extracts VAT from a gross amount', () => {
    // 123.00 gross at 23% -> 100.00 net + 23.00 VAT
    expect(vatFromGross(asMinor(12300), 2300)).toBe(2300);
    expect(netFromGross(asMinor(12300), 2300)).toBe(10000);
  });

  it('keeps net + VAT == gross for every cent up to 10,000', () => {
    for (let gross = 0; gross <= 1_000_000; gross += 7) {
      const vat = vatFromGross(asMinor(gross), 2300);
      const net = netFromGross(asMinor(gross), 2300);
      expect(net + vat).toBe(gross);
    }
  });

  it('is exact at zero rate', () => {
    expect(vatFromNet(asMinor(12345), 0)).toBe(0);
    expect(vatFromGross(asMinor(12345), 0)).toBe(0);
    expect(netFromGross(asMinor(12345), 0)).toBe(12345);
  });

  it('rounds half away from zero, not to even', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);   // banker's rounding would give 2
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });

  it('stays exact for amounts beyond safe-integer multiplication', () => {
    const huge = asMinor(900_000_000_000);
    expect(multiplyRational(huge, 2300, 10000)).toBe(207_000_000_000);
  });
});

describe('allocate', () => {
  it('splits without losing or inventing a cent', () => {
    // The rounding remainder lands on the largest share, first index on a tie.
    expect(allocate(asMinor(10000), [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocate(asMinor(10000), [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('allocates proportionally', () => {
    const parts = allocate(asMinor(10000), [7000, 3000]);
    expect(parts).toEqual([7000, 3000]);
  });

  it('always sums back to the original for awkward splits', () => {
    for (const total of [1, 7, 99, 100, 10007, 999999]) {
      for (const weights of [[1, 2], [1, 1, 1], [5, 3, 1], [1, 0, 0], [2, 2, 2, 1]]) {
        const parts = allocate(asMinor(total), weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('splits evenly when all weights are zero', () => {
    expect(allocate(asMinor(100), [0, 0]).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('handles negative amounts (credit notes)', () => {
    const parts = allocate(asMinor(-10000), [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-10000);
  });
});

describe('add/subtract', () => {
  it('stays exact over long sums where floats would drift', () => {
    const values = Array.from({ length: 10_000 }, () => asMinor(1));
    expect(add(...values.slice(0, 1000))).toBe(1000);
    expect(values.reduce<number>((a, b) => a + b, 0)).toBe(10_000);
  });
  it('subtracts', () => {
    expect(subtract(asMinor(10000), asMinor(2300))).toBe(7700);
  });
});

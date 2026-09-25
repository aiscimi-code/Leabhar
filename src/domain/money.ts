/**
 * Money primitives.
 *
 * Invariant #1 from docs/DOMAIN_MODEL.md: every monetary value in this system
 * is a whole number of minor units carried alongside an explicit currency.
 * There is no floating point arithmetic in the accounting path.
 *
 * `number` is used as the storage type because a JS safe integer reaches
 * 9.007e15, i.e. ~90 trillion euro in cents. That is comfortably beyond the
 * range of a small company's books, and it keeps SQLite INTEGER columns and
 * JSON serialisation simple. The type brand below stops a raw float being
 * passed where minor units are expected.
 */

export type Minor = number & { readonly __brand: 'Minor' };

export class MoneyError extends Error {}

/** Currencies whose minor unit is not 1/100. Extend as needed. */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0, KRW: 0, ISK: 0, CLP: 0, VND: 0, XOF: 0, XAF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

export function minorUnitsPerUnit(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** Assert-and-brand. Use at every boundary where an untrusted number arrives. */
export function asMinor(value: number): Minor {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Amount is not a finite number: ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be whole minor units, received ${value}. ` +
        'Use parseAmount() or toMinor() to convert a decimal amount.',
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount exceeds safe integer range: ${value}`);
  }
  return value as Minor;
}

export const ZERO = asMinor(0);

/**
 * Parse a decimal string into minor units exactly, without ever building a
 * float. "1234.56" -> 123456. This is the only sanctioned way to turn text
 * from a CSV, a PDF or a form field into money.
 */
export interface ParseAmountOptions {
  /**
   * Which character is the decimal separator in this source. Supplied by the
   * bank-import column mapping when the file's convention is known. When
   * omitted, the heuristic in `normaliseSeparators` applies.
   */
  decimalSeparator?: '.' | ',';
}

/**
 * Parse a decimal string into minor units exactly, without ever building a
 * float. "1234.56" -> 123456. This is the only sanctioned way to turn text
 * from a CSV, a PDF or a form field into money.
 */
export function parseAmount(
  input: string,
  currency: string,
  options: ParseAmountOptions = {},
): Minor {
  const exponent = currencyExponent(currency);
  let text = input.trim();
  if (text === '') throw new MoneyError('Empty amount');

  // Accounting-style negatives: (1,234.56)
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Strip currency symbols, codes and spaces (including non-breaking/narrow).
  text = text.replace(/[\u00A0\u202F\s]/g, '');
  text = text.replace(/^[^\d+\-.,]+/, '').replace(/[^\d.,]+$/, '');

  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith('+')) { text = text.slice(1); }

  text = normaliseSeparators(text, exponent, options.decimalSeparator);

  if (!/^\d*(\.\d*)?$/.test(text) || text === '' || text === '.') {
    throw new MoneyError(`Cannot parse amount: ${JSON.stringify(input)}`);
  }

  const [whole = '', frac = ''] = text.split('.');
  if (frac.length > exponent) {
    // More precision than the currency has. Refuse rather than round silently:
    // invariant #7 says nothing is silently repaired.
    const significant = frac.slice(exponent).replace(/0+$/, '');
    if (significant !== '') {
      throw new MoneyError(
        `Amount ${JSON.stringify(input)} has more decimal places than ${currency} ` +
          `supports (${exponent}). Round it deliberately before storing.`,
      );
    }
  }

  const padded = (frac + '0'.repeat(exponent)).slice(0, exponent);
  const digits = (whole === '' ? '0' : whole) + padded;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount out of range: ${input}`);
  }
  return asMinor(negative ? -value : value);
}

/** Does this text look like valid digit grouping for the given separator? */
function isGrouped(text: string, separator: string): boolean {
  const escaped = separator === '.' ? '\\.' : separator;
  return new RegExp(`^\\d{1,3}(${escaped}\\d{3})+$`).test(text);
}

/**
 * Decide which of "." and "," is the decimal separator and remove grouping.
 *
 * The genuinely ambiguous case is a single separator with exactly three digits
 * after it: "1.005" is 1005 under one convention and 1.005 under the other.
 * This resolves it as *grouping*, which is the dominant convention in bank
 * exports, but only when the digits before the separator also form a valid
 * leading group. Callers that know better pass `decimalSeparator`, and
 * `isAmbiguousAmount` lets an importer warn the user instead of guessing.
 */
function normaliseSeparators(
  text: string,
  exponent: number,
  decimalSeparator?: '.' | ',',
): string {
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');

  if (lastDot === -1 && lastComma === -1) return text;

  if (decimalSeparator) {
    const groupChar = decimalSeparator === '.' ? ',' : '.';
    const stripped = text.split(groupChar).join('');
    if (stripped.split(decimalSeparator).length > 2) {
      throw new MoneyError(`Multiple decimal separators in: ${text}`);
    }
    return stripped.replace(decimalSeparator, '.');
  }

  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal point; the other groups.
    const decimalChar = lastDot > lastComma ? '.' : ',';
    const groupChar = decimalChar === '.' ? ',' : '.';
    const [head = '', ...rest] = text.split(decimalChar);
    if (rest.length > 1) throw new MoneyError(`Multiple decimal separators in: ${text}`);
    if (head.includes(groupChar) && !isGrouped(head, groupChar)) {
      throw new MoneyError(`Malformed digit grouping in: ${text}`);
    }
    return `${head.split(groupChar).join('')}.${rest[0] ?? ''}`;
  }

  const sep = lastDot !== -1 ? '.' : ',';
  const occurrences = text.split(sep).length - 1;

  if (occurrences > 1) {
    // Repeated separators can only be grouping, and must be well formed.
    if (!isGrouped(text, sep)) throw new MoneyError(`Cannot parse amount: ${text}`);
    return text.split(sep).join('');
  }

  const after = text.length - text.lastIndexOf(sep) - 1;

  // Three digits after the separator is grouping — unless this currency has
  // three decimal places, in which case it is precision, not grouping.
  if (after === 3 && exponent !== 3 && isGrouped(text, sep)) {
    return text.split(sep).join('');
  }
  return text.replace(sep, '.');
}

/**
 * True when the text could be read as either grouping or a decimal point.
 * The bank importer uses this to ask rather than assume.
 */
export function isAmbiguousAmount(input: string, currency: string): boolean {
  const text = input.trim().replace(/[\u00A0\u202F\s]/g, '').replace(/[^\d.,]/g, '');
  const dots = text.split('.').length - 1;
  const commas = text.split(',').length - 1;
  if (dots + commas !== 1) return false;
  const sep = dots === 1 ? '.' : ',';
  const after = text.length - text.lastIndexOf(sep) - 1;
  if (after !== 3) return false;
  return isGrouped(text, sep) && currencyExponent(currency) === 3
    ? true
    : isGrouped(text, sep);
}

/** Minor units -> plain decimal string. No symbol, no grouping. */
export function formatAmount(minor: Minor | number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const frac = exponent === 0 ? '' : '.' + digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${frac}`;
}

/** Display form with thousands separators, e.g. "1,234.56". */
export function formatAmountGrouped(minor: Minor | number, currency: string): string {
  const plain = formatAmount(minor, currency);
  const negative = plain.startsWith('-');
  const body = negative ? plain.slice(1) : plain;
  const [whole = '0', frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? '.' + frac : ''}`;
}

export function add(...values: Array<Minor | number>): Minor {
  return asMinor(values.reduce<number>((a, b) => a + b, 0));
}

export function subtract(a: Minor | number, b: Minor | number): Minor {
  return asMinor(a - b);
}

export function negate(a: Minor | number): Minor {
  return asMinor(-a);
}

export function absolute(a: Minor | number): Minor {
  return asMinor(Math.abs(a));
}

export function sum(values: Array<Minor | number>): Minor {
  return add(...values);
}

/**
 * Round half away from zero. Chosen over banker's rounding because it is what
 * Irish VAT arithmetic and invoice totals conventionally use, and because it is
 * the behaviour a user checking the figure by hand will expect.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new MoneyError(`Cannot round ${value}`);
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Multiply money by an exact rational. Used for VAT (rate as basis points) and
 * FX (rate as numerator/denominator). Keeping the rate rational rather than a
 * float is what makes the result reproducible and auditable.
 */
export function multiplyRational(
  amount: Minor | number,
  numerator: number,
  denominator: number,
): Minor {
  if (denominator === 0) throw new MoneyError('Division by zero');
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new MoneyError('Rate numerator and denominator must be integers');
  }
  const product = amount * numerator;
  if (!Number.isSafeInteger(product)) {
    // Fall back to BigInt so large amounts x large rates stay exact.
    const big = (BigInt(amount) * BigInt(numerator));
    const den = BigInt(denominator);
    const q = big / den;
    const r = big % den;
    const twice = (r < 0n ? -r : r) * 2n;
    const roundUp = twice >= (den < 0n ? -den : den);
    const sign = (big < 0n) !== (den < 0n) ? -1n : 1n;
    const result = roundUp ? q + sign : q;
    const asNumber = Number(result);
    if (!Number.isSafeInteger(asNumber)) throw new MoneyError('Result out of range');
    return asMinor(asNumber);
  }
  return asMinor(roundHalfUp(product / denominator));
}

/**
 * A decimal exchange rate as typed ("0.92", up to six places) as an exact
 * integer fraction, so no float reaches a posting. Null when it is not a
 * positive decimal.
 */
export function parseDecimalRate(input: string): { numerator: number; denominator: number } | null {
  const text = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole = '0', frac = ''] = text.split('.');
  const denominator = 10 ** frac.length;
  const numerator = Number(whole) * denominator + (frac ? Number(frac) : 0);
  return numerator > 0 ? { numerator, denominator } : null;
}

/** VAT rates are stored as integer basis points: 23% is 2300. */
export const BASIS_POINTS_SCALE = 10_000;

export function vatFromNet(net: Minor | number, rateBasisPoints: number): Minor {
  return multiplyRational(net, rateBasisPoints, BASIS_POINTS_SCALE);
}

/** Extract the VAT contained in a VAT-inclusive (gross) amount. */
export function vatFromGross(gross: Minor | number, rateBasisPoints: number): Minor {
  return multiplyRational(gross, rateBasisPoints, BASIS_POINTS_SCALE + rateBasisPoints);
}

export function netFromGross(gross: Minor | number, rateBasisPoints: number): Minor {
  return subtract(gross, vatFromGross(gross, rateBasisPoints));
}

export function formatRate(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = Math.abs(basisPoints % 100);
  if (frac === 0) return `${whole}%`;
  return `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}%`;
}

export function parseRate(input: string): number {
  const text = input.trim().replace(/%$/, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new MoneyError(`Cannot parse rate: ${JSON.stringify(input)}`);
  }
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const bp = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return text.startsWith('-') ? -bp : bp;
}

/**
 * Split an amount across n parts without losing or inventing a cent.
 * Used when apportioning a payment across invoice lines, or VAT across a
 * part-paid invoice on the cash receipts basis.
 */
export function allocate(amount: Minor | number, weights: number[]): Minor[] {
  if (weights.length === 0) throw new MoneyError('No weights to allocate across');
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) {
    // Even split when all weights are zero.
    return allocate(amount, weights.map(() => 1));
  }
  const results: number[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length; i++) {
    const share = multiplyRational(amount, weights[i]!, total);
    results.push(share);
    allocated += share;
  }
  // Push the rounding remainder onto the largest share so the parts sum
  // exactly. Ties break to the first index, making the split deterministic.
  const remainder = (amount as number) - allocated;
  if (remainder !== 0) {
    let target = 0;
    for (let i = 1; i < results.length; i++) {
      if (Math.abs(results[i]!) > Math.abs(results[target]!)) target = i;
    }
    results[target] = results[target]! + remainder;
  }
  return results.map(asMinor);
}

export function assertSameCurrency(a: string, b: string, context: string): void {
  if (a.toUpperCase() !== b.toUpperCase()) {
    throw new MoneyError(`Currency mismatch in ${context}: ${a} vs ${b}`);
  }
}

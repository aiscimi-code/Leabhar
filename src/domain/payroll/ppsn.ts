/**
 * PPSN validation (issue #524).
 *
 * A personal public service number is seven digits, a check character, and
 * optionally a second letter (A–I, or W). The check character is the
 * weighted sum of the digits (weights 8 down to 2) plus nine times the
 * second letter's value (A=1 … I=9, W or none = 0), modulo 23, mapped to
 * a letter (0 = W, 1 = A … 22 = V).
 *
 * The employer "shall take all reasonable measures to establish that the
 * number furnished is in fact the personal public service number of that
 * employee" (S.I. 345/2018 reg.17(1)). A number that fails its own check
 * character is not one, so it is refused rather than stored.
 */

export class PpsnError extends Error {}

const PPSN_RE = /^(\d{7})([A-W])([A-IW]?)$/;

/** Upper case, spaces and hyphens removed. */
export function normalisePpsn(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

const letterValue = (c: string) => (c === '' || c === 'W' ? 0 : c.charCodeAt(0) - 64);

/** The check character the seven digits and second letter require. */
export function ppsnCheckCharacter(digits: string, secondLetter: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * (8 - i);
  sum += letterValue(secondLetter) * 9;
  const r = sum % 23;
  return r === 0 ? 'W' : String.fromCharCode(64 + r);
}

export function isValidPpsn(input: string): boolean {
  const m = PPSN_RE.exec(normalisePpsn(input));
  if (!m) return false;
  return ppsnCheckCharacter(m[1]!, m[3]!) === m[2];
}

/** The normalised PPSN, or a refusal saying why it is not one. */
export function requireValidPpsn(input: string): string {
  const ppsn = normalisePpsn(input);
  if (!PPSN_RE.test(ppsn)) {
    throw new PpsnError(`"${input}" is not a PPSN: it is seven digits, a check letter, and sometimes a second letter (1234567T, 1234567TW).`);
  }
  if (!isValidPpsn(ppsn)) {
    throw new PpsnError(`"${input}" fails the PPSN check character, so it is not a real PPSN. Check it against the employee's own documents.`);
  }
  return ppsn;
}

import { multiplyRational } from '../money';

/** Part of a contribution year's reckonable income and the Class S rate in force for it. */
export interface ClassSPart {
  incomeMinor: number;
  rateBasisPoints: number;
}

/**
 * Class S self-employment PRSI for a year of assessment (#487). Each part of
 * the year is charged at its own rate (#711); the €650 minimum and the
 * prescribed amount are tested on the whole year's income.
 * Rate and €650 minimum: SWCA 2005 s.21(1)(a).
 * Prescribed amount: S.I. 312/1996 art. 92 (SWCA 2005 Sch. 1 Part 3 para. 3).
 */
export function classSPrsiMinor(
  parts: ClassSPart[],
  minimumMinor: number,
  disregardMinor: number,
): number {
  const profitMinor = parts.reduce((s, p) => s + p.incomeMinor, 0);
  if (profitMinor <= 0) return 0;
  if (profitMinor < disregardMinor) return 0;
  const charged = parts.reduce((s, p) => s + multiplyRational(p.incomeMinor, p.rateBasisPoints, 10_000), 0);
  return charged > minimumMinor ? charged : minimumMinor;
}

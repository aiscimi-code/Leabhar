import { multiplyRational } from '../money';

/**
 * Class S self-employment PRSI for a year of assessment (#487).
 * Rate and €650 minimum: SWCA 2005 s.21(1)(a).
 * Prescribed amount: S.I. 312/1996 art. 92 (SWCA 2005 Sch. 1 Part 3 para. 3).
 */
export function classSPrsiMinor(
  profitMinor: number,
  rateBasisPoints: number,
  minimumMinor: number,
  disregardMinor: number,
): number {
  if (profitMinor <= 0) return 0;
  if (profitMinor < disregardMinor) return 0;
  const charged = multiplyRational(profitMinor, rateBasisPoints, 10_000);
  return charged > minimumMinor ? charged : minimumMinor;
}

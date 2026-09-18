/**
 * Resolve a provision's verbatim effective-date clue (as extracted by
 * `parseEffectiveClue` in `statuteParser.ts`) to an ISO date, deterministically
 * and without guessing beyond what the clue states.
 *
 * This never invents a date: a clue this function cannot parse falls back to
 * the caller-supplied source date (e.g. the Act's own enactment date), and the
 * verbatim clue string is always kept alongside (`irish_tax_rules.qualifier`)
 * so a reader can check the resolution against the source wording.
 */
const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function resolveEffectiveDate(clue: string | null, fallbackIsoDate: string): string {
  if (!clue) return fallbackIsoDate;

  const yearOfAssessment = clue.match(/year of assessment (\d{4})/i);
  if (yearOfAssessment) return `${yearOfAssessment[1]}-01-01`;

  const explicitDate = clue.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (explicitDate) {
    const [, day, monthName, year] = explicitDate;
    const month = MONTHS[(monthName ?? '').toLowerCase()];
    if (month) return `${year}-${month}-${String(day).padStart(2, '0')}`;
  }

  return fallbackIsoDate;
}

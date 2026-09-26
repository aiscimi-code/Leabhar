/**
 * Which rate a Schedule 3 supply bears on a given date (issue #205).
 *
 * Schedule 3 lists the supplies; it does not say which rate. s.46(1)(c)
 * charges them at 13.5%, "subject to" clauses (ca) to (cb), which put named
 * paragraphs at 9% — some permanently, some for a stated period. So the rate
 * for a Schedule 3 paragraph is a function of the paragraph and the date,
 * read here from the statute text:
 *
 * - LRC revised s.46 (docs/statutes/vatca-2010-revised/s046.md; its footnotes
 *   F99–F105 date each clause);
 * - Finance Act 2024 s.79(a) (docs/statutes/finance-act-2024), which records
 *   that (ca) read "paragraphs 7(a), 7A and 12" until 31 December 2024;
 * - Finance Act 2025 s.71 (docs/statutes/_inbox/A), which from 1 July 2026
 *   substitutes a new (cb): 9% for paragraphs 3(1), 3(3) and 13(3), with no
 *   end date. The LRC revised s.46 does not yet show it.
 *
 * Before 1 January 2025 the list in (ca) is known only as it stood on the
 * last day ("7(a), 7A and 12"); when that list took effect, and what (ca)
 * listed earlier (it has covered other paragraphs since 2011), is not in the
 * repository. A Schedule 3 line dated before then, and not inside a dated
 * clause, therefore gets no rate: it is flagged, never assumed to be 13.5%.
 */

export type ScheduleRateCode = 'IE_RED' | 'IE_SECOND_RED';

export interface ScheduleRate {
  code: ScheduleRateCode | null;
  /** The provision that sets the rate, e.g. "VATCA 2010 s.46(1)(caa)". */
  provision: string;
  /** Why no rate could be given, when `code` is null. */
  gap?: string;
}

interface SecondReducedWindow {
  refs: string[];
  from: string;
  to: string | null;
  provision: string;
}

/** The 9% clauses, each with the Schedule 3 references and period it states. */
export const SECOND_REDUCED_WINDOWS: SecondReducedWindow[] = [
  { refs: ['3(1)', '3(3)', '13(3)'], from: '2026-07-01', to: null, provision: 'Finance Act 2025 s.71 (s.46(1)(cb) as substituted)' },
  {
    refs: ['3(1)', '3(3)', '7(b)', '7(c)', '7(d)', '7(e)', '8', '11', '13(3)'],
    from: '2020-11-01', to: '2023-08-31', provision: 'VATCA 2010 s.46(1)(cb)',
  },
  { refs: ['17(2)', '17(3)'], from: '2022-05-01', to: '2030-12-31', provision: 'VATCA 2010 s.46(1)(caa)' },
  { refs: ['9A'], from: '2025-10-08', to: '2025-11-25', provision: 'VATCA 2010 s.46(1)(cab)' },
  { refs: ['9B(2)', '9B(3)'], from: '2025-11-26', to: '2030-12-31', provision: 'VATCA 2010 s.46(1)(cac)' },
  { refs: ['7(a)', '7A', '12', '12A'], from: '2025-01-01', to: null, provision: 'VATCA 2010 s.46(1)(ca)' },
];

/** From this date the (ca) list is known ("paragraphs 7(a), 7A, 12 and 12A", F101). */
export const CA_LIST_KNOWN_FROM = '2025-01-01';

/** Does a rule's reference ("8(2)", "17(3)") fall within a listed one ("8", "17(3)")? */
export function withinReference(ref: string, listed: string): boolean {
  return ref === listed || ref.startsWith(`${listed}(`);
}

export function scheduleThreeRate(ref: string, onDate: string): ScheduleRate {
  for (const w of SECOND_REDUCED_WINDOWS) {
    if (onDate < w.from || (w.to !== null && onDate > w.to)) continue;
    if (w.refs.some((listed) => withinReference(ref, listed))) {
      return { code: 'IE_SECOND_RED', provision: w.provision };
    }
  }
  if (onDate >= CA_LIST_KNOWN_FROM) return { code: 'IE_RED', provision: 'VATCA 2010 s.46(1)(c)' };
  return {
    code: null,
    provision: 'VATCA 2010 s.46(1)(c) and (ca)',
    gap: `Before ${CA_LIST_KNOWN_FROM}, s.46(1)(ca) put a list of Schedule 3 paragraphs at 9% whose history is not in `
      + 'the repository (Finance Act 2024 s.79(a) shows only that it read "paragraphs 7(a), 7A and 12" immediately '
      + `before). Whether paragraph ${ref} was then at 13.5% or 9% cannot be confirmed from the sources.`,
  };
}

/**
 * Deterministic parser for a single TCA 1997 section as inserted by Finance
 * Act 2011 s.20 (the 2011 electronic-RCT restructuring: ss.530A-530V), each
 * extracted verbatim into its own file under docs/statutes/tca-1997/ —
 * `s530A.md` through `s530V.md`.
 *
 * A different source-page structure from `tca1997SectionParser.ts`'s
 * `s530.md` (the pre-2011, as-enacted-1997 section): there is no LRC-revised
 * TCA 1997 for ss.530A-530V (every revisedacts.lawreform.ie URL for them
 * 404s — see docs/statutes/tca-1997/README.md and issue #131's own
 * comment thread), so these were fetched from the eISB *as-enacted Finance
 * Act 2011 s.20* page instead — the inserting Act's own text, which quotes
 * each new section in full. That source has no Chapter marker or leading
 * amendment-citation bracket (`s530.md`'s own "[FA70 s17(1)...]" convention)
 * to strip, and its section-opening line is NOT alone on its own line the
 * way `s530.md`'s bare "530." is — it reads "530A.— (1) ..." with the first
 * subsection inline on the same line as the section number.
 *
 * Layout (verified against s530A.md, s530E.md, s530G.md, s530I.md): front
 * matter, a `# TCA 1997 s.530X (as inserted by FA 2011 s.20)` title, the
 * section's own marginal heading on the next non-blank line (sometimes
 * prefixed with FA 2011 s.20's own opening left-quotation-mark character,
 * only on the very first inserted section, 530A, since it marks the start
 * of the whole quoted insertion — stripped here, not treated as wording),
 * then the section itself opening as `"530X.— (1) ..."` and running to the
 * end of the file (each file holds exactly one section).
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedFinanceAct2011RctSection {
  /** e.g. "530A". */
  sectionNumber: string;
  /** The section's own marginal heading, e.g. "Rates of tax." */
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

const FRONT_MATTER_RE = /^---\n[\s\S]*?\n---\n/;
const TITLE_LINE_RE = /^#\s+.*$/m;
/** The section-opening line, e.g. "530A.— (1)  Subject to..." — the section
 *  number and first subsection share one line, unlike s530.md's bare "530." */
const SECTION_OPEN_RE = /^(\d{1,3}[A-Z])\.—/;
/** FA 2011 s.20's own opening quotation mark for the whole quoted insertion
 *  (appears only on s.530A's heading) — punctuation from the amending Act's
 *  own text, not part of the inserted section's wording. */
const LEADING_QUOTE_RE = /^[“"]/;

export function parseFinanceAct2011RctSection(source: string): ParsedFinanceAct2011RctSection {
  const fmMatch = source.match(FRONT_MATTER_RE);
  const afterFrontMatter = fmMatch ? fmMatch[0].length : 0;
  const titleMatch = TITLE_LINE_RE.exec(source.slice(afterFrontMatter));
  if (!titleMatch) throw new Error('parseFinanceAct2011RctSection: no "# TCA 1997 s.530X" title line found');
  const afterTitleOffset = afterFrontMatter + titleMatch.index + titleMatch[0].length;

  const lines = source.split('\n');
  const titleLineIndex = source.slice(0, afterTitleOffset).split('\n').length - 1;

  let headingLineIdx = -1;
  let lineIdx = titleLineIndex + 1;
  for (; lineIdx < lines.length; lineIdx++) {
    if ((lines[lineIdx] ?? '').trim() === '') continue;
    headingLineIdx = lineIdx;
    break;
  }
  if (headingLineIdx === -1) throw new Error('parseFinanceAct2011RctSection: no heading line found');
  const heading = (lines[headingLineIdx] ?? '').trim().replace(LEADING_QUOTE_RE, '').trim();

  let sectionLineIdx = -1;
  for (lineIdx = headingLineIdx + 1; lineIdx < lines.length; lineIdx++) {
    const line = (lines[lineIdx] ?? '').trim();
    if (line === '') continue;
    if (SECTION_OPEN_RE.test(line)) { sectionLineIdx = lineIdx; break; }
    throw new Error(`parseFinanceAct2011RctSection: expected section-opening line, found "${line}"`);
  }
  if (sectionLineIdx === -1) {
    throw new Error('parseFinanceAct2011RctSection: no section-opening line (e.g. "530A.— (1) ...") found');
  }

  const sectionNumber = SECTION_OPEN_RE.exec((lines[sectionLineIdx] ?? '').trim())![1]!;

  const bodyLines = lines.slice(sectionLineIdx);
  while (bodyLines.length && bodyLines.at(-1)!.trim() === '') bodyLines.pop();
  const provisionText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  const sourceStart = offsets[sectionLineIdx] ?? 0;
  const lastLineIdx = sectionLineIdx + bodyLines.length - 1;
  const lastLine = lines[lastLineIdx] ?? '';
  const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

  return {
    sectionNumber,
    heading,
    provisionText,
    sourceStart,
    sourceEnd,
    category: categoriseProvision(heading, provisionText),
  };
}

export function parseFinanceAct2011RctSectionFile(path: string): ParsedFinanceAct2011RctSection {
  return parseFinanceAct2011RctSection(readFileSync(path, 'utf8'));
}

/** e.g. tca1997RctSectionMdPath('530A') -> .../docs/statutes/tca-1997/s530A.md */
export function tca1997RctSectionMdPath(sectionNumber: string): string {
  return new URL(`../../../docs/statutes/tca-1997/s${sectionNumber}.md`, import.meta.url).pathname;
}

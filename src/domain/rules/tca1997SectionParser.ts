/**
 * Deterministic parser for a single Taxes Consolidation Act 1997 section, as
 * extracted verbatim (as-enacted 1997 text) into its own file under
 * docs/statutes/tca-1997/ — one file per section, unlike VATCA 2010 or the
 * Finance Act 2024's single converted Markdown covering every section (there
 * is no LRC-revised TCA 1997 to fetch as one document; see
 * docs/statutes/tca-1997/README.md).
 *
 * Layout (verified against docs/statutes/tca-1997/s530.md): front matter, a
 * `# TCA 1997 s.NNN` title, then a marginal Chapter marker + Chapter title
 * (e.g. "CHAPTER 2" / "Payments to subcontractors in certain industries"),
 * then the section's own marginal heading (e.g. "Interpretation (Chapter
 * 2)."), a single leading `[...]` amendment-history citation bracket (the
 * Acts that have touched this section since 1997 — editorial, not statutory
 * text, dropped the same way vatcaScheduleParser.ts drops LRC's own footnote
 * brackets), then the section itself opening as a bare `NNN.` on its own
 * line and running to the end of the file (each file holds exactly one
 * section, so there is no "next section" to slice up to).
 *
 * Verified against s530.md only; reuse for a sibling tca-1997/*.md file
 * needs the same check before trusting it — see the parser test.
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedTcaSection {
  /** e.g. "530". Leading section number only. */
  sectionNumber: string;
  /** e.g. "CHAPTER 2: Payments to subcontractors in certain industries", when the source states one. */
  chapter: string | null;
  /** The section's own marginal heading, e.g. "Interpretation (Chapter 2)." */
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

const FRONT_MATTER_RE = /^---\n[\s\S]*?\n---\n/;
const TITLE_LINE_RE = /^#\s+.*$/m;
const SECTION_OPEN_RE = /^(\d{1,3}[A-Z]?)\.\s*$/;
const CHAPTER_RE = /^CHAPTER\s+\d+\s*$/;
/** The Acts that amended this section, printed as a single leading bracket
 *  (e.g. "[FA70 s17(1) and (13); FA72 Sch1 PtIII par4; ...]") — an editorial
 *  citation history, not part of the 1997 enacted wording itself. */
const CITATION_BRACKET_RE = /^\[.*\]$/;

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

export function parseTca1997Section(source: string): ParsedTcaSection {
  const fmMatch = source.match(FRONT_MATTER_RE);
  const afterFrontMatter = fmMatch ? fmMatch[0].length : 0;
  const titleMatch = TITLE_LINE_RE.exec(source.slice(afterFrontMatter));
  if (!titleMatch) throw new Error('parseTca1997Section: no "# TCA 1997 s.N" title line found');
  const afterTitleOffset = afterFrontMatter + titleMatch.index + titleMatch[0].length;

  const lines = source.split('\n');
  const offsets = lineOffsets(source);
  const titleLineIndex = source.slice(0, afterTitleOffset).split('\n').length - 1;
  let lineIdx = titleLineIndex + 1;

  let chapter: string | null = null;
  const headingLines: string[] = [];
  let sectionLineIdx = -1;
  for (; lineIdx < lines.length; lineIdx++) {
    const line = (lines[lineIdx] ?? '').trim();
    if (line === '') continue;
    if (CHAPTER_RE.test(line)) {
      const chapterTitle = (lines[lineIdx + 1] ?? '').trim();
      chapter = chapterTitle ? `${line}: ${chapterTitle}` : line;
      lineIdx++;
      continue;
    }
    if (CITATION_BRACKET_RE.test(line)) continue;
    if (SECTION_OPEN_RE.test(line)) { sectionLineIdx = lineIdx; break; }
    headingLines.push(line);
  }
  if (sectionLineIdx === -1) {
    throw new Error('parseTca1997Section: no section-number line (e.g. "530.") found');
  }

  const sectionNumber = SECTION_OPEN_RE.exec((lines[sectionLineIdx] ?? '').trim())![1]!;
  // Marginal headings wrap across lines with the parenthesis split from its
  // contents (e.g. "Interpretation (" / "Chapter 2" / ")."); rejoin them the
  // way they read on the printed page.
  const heading = headingLines.join(' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();

  const bodyLines = lines.slice(sectionLineIdx);
  while (bodyLines.length && bodyLines.at(-1)!.trim() === '') bodyLines.pop();
  const provisionText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const sourceStart = offsets[sectionLineIdx] ?? 0;
  const lastLineIdx = sectionLineIdx + bodyLines.length - 1;
  const lastLine = lines[lastLineIdx] ?? '';
  const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

  return {
    sectionNumber,
    chapter,
    heading,
    provisionText,
    sourceStart,
    sourceEnd,
    category: categoriseProvision(heading, provisionText),
  };
}

export function parseTca1997SectionFile(path: string): ParsedTcaSection {
  return parseTca1997Section(readFileSync(path, 'utf8'));
}

export const TCA_1997_S530_MD_PATH = new URL(
  '../../../docs/statutes/tca-1997/s530.md',
  import.meta.url,
).pathname;

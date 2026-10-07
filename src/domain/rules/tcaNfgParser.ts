/**
 * Sections of Revenue's "Notes for Guidance — Taxes Consolidation Act 1997"
 * (Finance Act 2025 edition; issue #211), as `pdftotext -layout` converts each
 * part's PDF (the catalogue extraction, scripts/catalogue/extract.ts).
 *
 * There is no LRC revised TCA 1997 (docs/statutes/tca-1997/README.md), so the
 * Notes are the current consolidated statement of each section's effect. Each
 * section's note opens with a heading line at the left margin, the section
 * number and its title ("81 General rule as to deductions"), followed within
 * two lines by "Summary" or "Details". The part's table of contents repeats
 * the headings indented, so a left-margin heading followed by one of those
 * words is the note itself. A note runs to the next such heading.
 */

export interface NfgSection {
  sectionNumber: string;
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
}

const HEADING = /^ {0,2}(\d+[A-Z]{0,3}) ([A-Z“"].*?)\s*$/;

/**
 * A lettered section after the one before it (380L after 380K): the same
 * number, a later suffix. The same section again is a line of text.
 */
function laterLetteredSection(section: string, previousSection: string): boolean {
  const a = /^(\d+)([A-Z]*)$/.exec(section);
  const b = /^(\d+)([A-Z]*)$/.exec(previousSection);
  if (!a || !b || a[1] !== b[1]) return false;
  const [x, y] = [a[2]!, b[2]!];
  return x.length > y.length || (x.length === y.length && x > y);
}

/** Every section note in a part, in order. */
export function parseNfgSections(markdown: string): NfgSection[] {
  const lines = markdown.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }

  const contents = nfgContentsTitles(markdown);
  // The contents list ends where the body's first "Overview" opens; a listed
  // heading is a note only after it, never in the list itself.
  const bodyStart = lines.findIndex((l) => l.trim() === 'Overview');
  const starts: Array<{ line: number; sectionNumber: string; heading: string }> = [];
  let previous = 0;
  let previousSection = '';
  for (let i = 0; i < lines.length; i++) {
    // Everything before the first "Overview" is the cover and the contents list.
    if (i < bodyStart) continue;
    const m = HEADING.exec(lines[i]!);
    if (!m) continue;
    const number = Number.parseInt(m[1]!, 10);
    // Notes run in section order: a number going backwards is a line of text.
    if (number < previous) continue;
    // The body follows at once, or after up to two wrapped lines of the
    // heading and a blank line.
    const wrapped: string[] = [];
    let opensBody = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const t = lines[j]!.replace(/\f/g, '').trim();
      if (t === 'Summary' || t === 'Details' || t === 'Definitions') { opensBody = true; break; }
      // Blank lines and page furniture (a page number, the running header) between heading and body.
      if (t === '' || /^\d+$/.test(t) || t.startsWith('Notes for Guidance')) continue;
      if (HEADING.test(lines[j]!) || wrapped.length === 2) break;
      wrapped.push(t);
    }
    // A note with no Summary or Details (s.292) is taken when it is the next
    // section along: the same number or a close one. The same takes the first
    // note of a part (Part 11 opens with one, s.373): a left-margin heading
    // before any note has been taken is a note, not a line of text.
    // A section the contents list names is a note even with no Summary or Details
    // (a repealed or deleted section's note is a sentence or two): its heading
    // opens with the listed title, and it follows the sections before it.
    const listed = contents.get(m[1]!);
    const listedHere = listed !== undefined && number >= previous
      && (m[2]!.startsWith(listed) || listed.startsWith(m[2]!));
    if (!opensBody && !listedHere && !((previous === 0) || (number > previous && number - previous <= 5) || (/^\d/.test(lines[i]!) && laterLetteredSection(m[1]!, previousSection)))) continue;
    if (!opensBody) wrapped.length = 0;
    const heading = [m[2]!, ...wrapped].join(' ').replace(/- /g, '').replace(/\s+/g, ' ').trim();
    starts.push({ line: i, sectionNumber: m[1]!, heading });
    previous = number;
    previousSection = m[1]!;
  }

  return starts.map((s, k) => {
    const endLine = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
    const sourceStart = offsets[s.line]!;
    const sourceEnd = endLine < lines.length ? offsets[endLine]! : markdown.length;
    return {
      sectionNumber: s.sectionNumber, heading: s.heading,
      provisionText: markdown.slice(sourceStart, sourceEnd), sourceStart, sourceEnd,
    };
  });
}

/**
 * The section numbers a part's table of contents lists, in order. The
 * contents open at the "Finance Act ... edition" line of the cover page and
 * run to the part's "Overview". An entry is an indented section number and
 * title; a wrapped title can start a line with a year or a section reference,
 * so a number going backwards, or a year, is a continuation and not an entry.
 */
export function parseNfgContents(markdown: string): string[] {
  return [...nfgContentsTitles(markdown).keys()];
}

/** The contents list as section number → title, in order. */
function nfgContentsTitles(markdown: string): Map<string, string> {
  const lines = markdown.split('\n');
  const open = lines.findIndex((l) => /^Finance Act \d{4} edition/.test(l));
  const sections = new Map<string, string>();
  if (open < 0) return sections;
  let previous = 0;
  for (let i = open + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === 'Overview') break;
    const m = /^ {1,8}(\d+[A-Z]{0,3}) ([A-Z“"].*?)\s*$/.exec(line);
    if (!m) continue;
    const number = Number.parseInt(m[1]!, 10);
    if (number > 1500 || number < previous) continue;
    sections.set(m[1]!, m[2]!);
    previous = number;
  }
  return sections;
}

/**
 * Sections the contents list names that no note was parsed for, and notes parsed for
 * a section the contents do not list. A section missing here means its text
 * sits inside the previous section's note (issue #287).
 */
export function compareNfgContents(markdown: string): { missing: string[]; unlisted: string[] } {
  const listed = parseNfgContents(markdown);
  const found = parseNfgSections(markdown).map((s) => s.sectionNumber);
  return {
    missing: listed.filter((s) => !found.includes(s)),
    unlisted: found.filter((s) => !listed.includes(s)),
  };
}

/** One section's note; throws when the part has none or more than one. */
export function extractNfgSection(markdown: string, sectionNumber: string): NfgSection {
  const found = parseNfgSections(markdown).filter((s) => s.sectionNumber === sectionNumber);
  if (found.length !== 1) {
    throw new Error(`Expected one note for s.${sectionNumber}, found ${found.length}.`);
  }
  return found[0]!;
}

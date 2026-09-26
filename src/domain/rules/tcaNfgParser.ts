/**
 * Sections of Revenue's "Notes for Guidance — Taxes Consolidation Act 1997"
 * (Finance Act 2025 edition; issue #211), kept as pdftotext conversions in
 * docs/statutes/tca-1997-nfg/partNN.md.
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

/** Every section note in a part, in order. */
export function parseNfgSections(markdown: string): NfgSection[] {
  const lines = markdown.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }

  const starts: Array<{ line: number; sectionNumber: string; heading: string }> = [];
  let previous = 0;
  for (let i = 0; i < lines.length; i++) {
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
    // section along: the same number or a close one.
    if (!opensBody && !(previous > 0 && number > previous && number - previous <= 5)) continue;
    if (!opensBody) wrapped.length = 0;
    const heading = [m[2]!, ...wrapped].join(' ').replace(/- /g, '').replace(/\s+/g, ' ').trim();
    starts.push({ line: i, sectionNumber: m[1]!, heading });
    previous = number;
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

/** One section's note; throws when the part has none or more than one. */
export function extractNfgSection(markdown: string, sectionNumber: string): NfgSection {
  const found = parseNfgSections(markdown).filter((s) => s.sectionNumber === sectionNumber);
  if (found.length !== 1) {
    throw new Error(`Expected one note for s.${sectionNumber}, found ${found.length}.`);
  }
  return found[0]!;
}

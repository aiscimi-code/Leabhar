/**
 * Amendment history of each paragraph of an LRC revised schedule (issue
 * #205), read from the Law Reform Commission's own HTML.
 *
 * The revised text is the law as it now stands. The LRC marks every change
 * in it with a footnote reference ("F481") and lists each footnote — what
 * changed, on what date, by what Act ("Substituted (1.01.2018) by Finance Act
 * 2017 …, s. 56"). A rule quoting the current text is only good from the last
 * date that text changed: before then the paragraph said something else,
 * which is not in the repo. So a paragraph's rule window starts on the latest
 * date among the footnotes inside it, or on the Act's commencement when it has
 * none.
 *
 * Paragraphs are not separate elements in the LRC HTML, only Parts are, so
 * the text is walked in order and a footnote belongs to the paragraph it
 * appears in. Which paragraphs exist comes from the Markdown parser
 * (`parseVatcaSchedule`), already checked against the source; a line opens a
 * paragraph only when it is the next one expected, so a line that happens to
 * start "2014." or "86." cannot be mistaken for one.
 */

export interface LrcFootnote {
  ref: string;
  /** "Inserted", "Substituted", "Deleted", "Amended", …: the first word of the note ("unspecified" when it gives none). */
  kind: string;
  /** ISO date the change took effect, as the LRC states it. */
  date: string | null;
  text: string;
}

export interface ParagraphAnnotations {
  paragraph: string;
  footnotes: LrcFootnote[];
  /** The latest date among its footnotes, or null when it has none. */
  lastChanged: string | null;
}

/** VATCA 2010 commenced on 1 November 2010. */
export const VATCA_2010_COMMENCEMENT = '2010-11-01';

const decode = (s: string): string => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

const toIso = (d: string): string | null => {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(d);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
};

/**
 * The date a note gives, from its first parenthesis: "(1.01.2018)",
 * "(1.01.2022, deemed)", "(21.12.21)". When it gives more than one
 * ("(1.01.2021, 12.12.2021)", parts commencing on different days) the latest
 * is taken, since the text only stood as it now reads from then.
 */
function noteDate(text: string): string | null {
  const paren = /\(([^)]*\d{1,2}\.\d{1,2}\.\d{2,4}[^)]*)\)/.exec(text)?.[1];
  if (!paren) return null;
  const dates = [...paren.matchAll(/\b(\d{1,2}\.\d{1,2}\.\d{2,4})\b/g)].map((m) => toIso(m[1]!)).filter((d): d is string => !!d);
  return dates.sort().at(-1) ?? null;
}

/** Every footnote the page defines, by reference. */
export function parseLrcFootnotes(html: string): Map<string, LrcFootnote> {
  const notes = new Map<string, LrcFootnote>();
  const re = /<div class="f-note">\s*<p class="shouldernote1">\s*(F\d+)\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const text = decode(m[2]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const kind = text.startsWith('(') ? 'unspecified' : (text.split(/\s|\(/)[0] ?? 'unspecified');
    notes.set(m[1]!, { ref: m[1]!, kind, date: noteDate(text), text });
  }
  return notes;
}

/**
 * The operative text as lines, footnote markers kept as ⟦F123⟧ and the
 * footnote and editorial lists removed. The start of each Part is a line
 * ⟪S⟫; a centred line is prefixed ⟪C⟫ (a Part title or introduction before
 * the Part's first paragraph, a table title after it); a line that is only an
 * italic marginal heading is prefixed ⟪H⟫ — it heads the paragraph after it.
 */
function textLines(html: string): string[] {
  const body = html
    .replace(/<div class="f-note">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="e-note">[\s\S]*?<\/div>/g, '')
    .replace(/<section class="part"[^>]*>/g, '\n⟪S⟫\n')
    .replace(/<span class="commentary-reference">\s*(F\d+)\s*<\/span>/g, '⟦$1⟧')
    .replace(/<p[^>]*text-align:center[^>]*>/g, '⟪C⟫')
    .replace(/<p[^>]*>\s*<i>([^<]*)<\/i>\s*\.?\s*<\/p>/g, '⟪H⟫$1\n')
    .replace(/<\/p>|<br\s*\/?>/g, '\n');
  return decode(body.replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Attribute each footnote to the paragraph it appears in. `paragraphs` is
 * the expected list in document order; `startsAt` gives, for a paragraph
 * whose number is not printed, the exact line (its heading) that opens it.
 *
 * A footnote on a Part's title or introduction is a Part-level note. When it
 * records that the Part was inserted, the Part's paragraphs did not exist
 * before that date, so it counts for each of them. A note that only reworded
 * the Part's heading or introduction changes no paragraph's operative text;
 * it is reported in `partFootnotes` and does not move any paragraph's window.
 */
export function annotateScheduleParagraphs(
  html: string,
  paragraphs: string[],
  startsAt: Record<string, string> = {},
): { paragraphs: ParagraphAnnotations[]; partFootnotes: LrcFootnote[] } {
  const notes = parseLrcFootnotes(html);
  const note = (ref: string): LrcFootnote => notes.get(ref)
    ?? { ref, kind: 'unknown', date: null, text: 'Footnote not listed on the page.' };
  const found = new Map<string, Set<string>>(paragraphs.map((p) => [p, new Set<string>()]));
  const partLevel = new Set<string>();
  let next = 0;
  let current: string | null = null;
  // Part-level "Inserted" notes apply to every paragraph of the current Part.
  let partInserted: string[] = [];
  // Footnotes on a heading wait for the paragraph the heading introduces.
  let pending: string[] = [];
  const stripped = (l: string) => l.replace(/⟦F\d+⟧/g, '').trim();

  for (const raw of textLines(html)) {
    if (raw === '⟪S⟫') { current = null; partInserted = []; pending = []; continue; }
    const centred = raw.startsWith('⟪C⟫');
    const heading = raw.startsWith('⟪H⟫');
    const line = raw.replace(/^⟪[CH]⟫/, '').trim();
    const refs = [...line.matchAll(/⟦(F\d+)⟧/g)].map((m) => m[1]!);

    if (centred && current === null) {
      for (const r of refs) {
        partLevel.add(r);
        if (note(r).kind === 'Inserted') partInserted.push(r);
      }
      continue;
    }

    const expected = paragraphs[next];
    if (expected !== undefined) {
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const numbered = new RegExp(`^(?:⟦F\\d+⟧\\s*)*\\[?\\s*${escaped}\\.(?:\\s|$|\\(|⟦)`).test(line);
      if (numbered || startsAt[expected] === stripped(line)) {
        current = expected;
        next += 1;
        [...pending, ...partInserted].forEach((r) => found.get(current!)!.add(r));
        pending = [];
      }
    }
    if (heading && startsAt[paragraphs[next] ?? ''] !== stripped(line)) { pending.push(...refs); continue; }
    for (const r of refs) {
      if (current) found.get(current)!.add(r);
      else partLevel.add(r);
    }
  }
  if (next !== paragraphs.length) {
    throw new Error(`Paragraph ${paragraphs[next]} was not found in the LRC text (found ${next} of ${paragraphs.length}).`);
  }

  return {
    partFootnotes: [...partLevel].map(note),
    paragraphs: paragraphs.map((p) => {
      const footnotes = [...found.get(p)!].map(note);
      const dates = footnotes.map((f) => f.date).filter((d): d is string => !!d).sort();
      return { paragraph: p, footnotes, lastChanged: dates.at(-1) ?? null };
    }),
  };
}

/**
 * Paragraphs whose number the LRC text does not print, keyed by schedule:
 * the paragraph and the heading line that opens it.
 */
export const UNNUMBERED_PARAGRAPHS: Record<string, Array<{ paragraph: string; before: string; heading: string }>> = {
  '3': [{ paragraph: '21', before: '22', heading: 'Miscellaneous services.' }],
};

export interface ParagraphWindow {
  /** The date the paragraph's current text took effect: its latest amendment, or the Act's commencement. */
  effectiveFrom: string;
  footnotes: LrcFootnote[];
}

/**
 * Each paragraph's window, from the LRC HTML kept beside the schedule's
 * Markdown (same SHA-256 as its front matter records). `paragraphs` is the
 * Markdown parser's list; unnumbered paragraphs are inserted where they sit.
 */
export function scheduleParagraphWindows(
  html: string, scheduleNumber: string, paragraphs: string[],
): Map<string, ParagraphWindow> {
  const list = [...paragraphs];
  const startsAt: Record<string, string> = {};
  for (const u of UNNUMBERED_PARAGRAPHS[scheduleNumber] ?? []) {
    if (!list.includes(u.paragraph)) list.splice(Math.max(0, list.indexOf(u.before)), 0, u.paragraph);
    startsAt[u.paragraph] = u.heading;
  }
  const { paragraphs: annotated } = annotateScheduleParagraphs(html, list, startsAt);
  return new Map(annotated.map((a) => [a.paragraph, {
    effectiveFrom: a.lastChanged && a.lastChanged > VATCA_2010_COMMENCEMENT ? a.lastChanged : VATCA_2010_COMMENCEMENT,
    footnotes: a.footnotes,
  }]));
}

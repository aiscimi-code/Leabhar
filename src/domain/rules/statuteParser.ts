/**
 * Deterministic parser for the Finance Act 2024 (2024 Act 43) enacted Markdown.
 *
 * The parser is deliberately *textual*, not semantic: it never infers what a
 * provision "means", only what it *says* and *where* it lives. Every derived
 * rule produced downstream carries the verbatim `provisionText` as its authority;
 * a plain-language gloss is always separately tagged `ai_suggestion` (and so
 * review-flagged) so an invention can never masquerade as the statute's words.
 *
 * This keeps the non-negotiable invariant from AGENTS.md: "the system must not
 * silently repair" — and extends it to "the system must not silently invent".
 *
 * Input conventions (verified against docs/2024-act-43-enacted.md):
 *  - Body sections begin at column 0 with a line matching `^<num>. ` after the
 *    Contents block. The Contents block (headings + "CONTENTS") and the
 *    front matter (`[NO. 43.]`, page-break markers `\f`) are skipped.
 *  - Each section is followed by a blank line, then its heading, then the
 *    provision body indented by 3+ spaces until the next `^<num>. ` line.
 *  - A section may contain multiple top-level paragraphs; the heading is the
 *    line after the section number that is not a `(n)` subsection opener.
 *  - Subsection openers look like `(1)  ...` at the section's base indent.
 *
 * Output: a list of `ParsedProvision` records, each with character offsets into
 * the source so the exact slice is always recoverable and re-checkable.
 */
import { readFileSync } from 'node:fs';

export interface ParsedProvision {
  /** e.g. "3". Leading section number only. */
  sectionNumber: string;
  /** First heading line(s) for the section, joined. */
  heading: string;
  /** Normalised plain text of the provision body (indentation collapses, page markers removed). */
  provisionText: string;
  /** Start offset of the section number line in source. */
  sourceStart: number;
  /** End offset (exclusive) of the last line of the section in source. */
  sourceEnd: number;
  /** Principal Act(s) amended, parsed from phrases like "Principal Act" / specific act names. */
  principalActs: string[];
  /** Section/subsection refs being amended, e.g. ["531AN","472BB(3)","15((3)(i)"] — raw tokens. */
  amendsSection: string[];
  /** Verbatim effective-date clue string if any, else null. */
  effectiveClue: string | null;
  /** Broad category for the provision, for lookup and reporting. */
  category: ProvisionCategory;
  /** Finance Act 2023 / 2024 references in the text (other Acts cited). */
  citedActs: string[];
}

export type ProvisionCategory =
  | 'income_tax' | 'corporation_tax' | 'vat' | 'usc' | 'capital_allowances'
  | 'capital_gains_tax' | 'relief' | 'exemption' | 'penalty' | 'procedure'
  | 'definitions' | 'repeal' | 'other';

const SECTION_RE = /^(\d{1,3})\.\s+/;
const SUBSECTION_RE = /^\s*\((\d+|[A-Z])\)\s+/;

const ACT_CITATIONS = [
  'Taxes Consolidation Act 1997',
  'Value-Added Tax Consolidation Act 2010',
  'Capital Acquisitions Tax Consolidation Act 2003',
  'Stamp Duties Consolidation Act 1999',
  'Social Welfare Consolidation Act 2005',
  'Emergency Measures in the Public Interest (Covid-19) Act 2020',
  "Children and Family Relationships Act 2015",
  'Finance Act 2005',
  'Finance (No. 2) Act 2023',
  'Corporation Tax Act 2010',
  'Income Tax Act 1961',
  'Pay and Compare (Ireland) Act 2023',
];

/**
 * Normalise a raw slice of the statute into clean plain text: strip the form
 * feed page markers and the leading "PT.1 S.3"-style marginalia, collapse
 * runs of spaces to a single space, but preserve newlines between paragraphs
 * so structure is not invented where none exists.
 */
function normaliseProvisionText(raw: string): string {
  return raw
    .replace(/\f/g, ' ') // form feeds -> space
    .replace(/^[ \t]+/gm, '') // strip leading indentation (structure is not semantic here)
    .replace(/[ \t]{2,}/g, ' ') // collapse horizontal runs
    .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
    .trim();
}

/** Split source into line-start offsets so we can map a line index back to a source offset. */
function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

/**
 * Extract the leading number from a section header line, e.g. "3.    As respects" -> "3".
 * Returns "" when the line is not a section header.
 */
function sectionNumberFromLine(line: string): string {
  const m = line.match(SECTION_RE);
  return m ? (m[1] ?? '') : '';
}

/**
 * Parse the heading: the first non-subsection text on the section header line,
 * after the section number. If the line's remainder is an empty subsection
 * opener `(1) ...` or the section number is immediately followed by a page
 * break, the heading is the first following descriptive (non-`(n)`) line;
 * if there is none, the heading is empty (the section opens straight into a
 * subsection with no short title).
 */
function extractHeading(lines: string[], startIdx: number): string {
  const headerLine = (lines[startIdx] ?? '').replace(SECTION_RE, '').trim();
  // A section that opens with a subsection `(1) ...` (or page-number-only text)
  // has no short title on the header line — fall through to following lines.
  if (headerLine && !/^(\(|\d|PT\.|S\.|NO\. 43\.|\[2024.\])/.test(headerLine)) {
    return headerLine;
  }
  // Otherwise, look for the first following descriptive (non-`(n)`) line.
  for (let i = startIdx + 1; i < Math.min(startIdx + 6, lines.length); i++) {
    const candidate = (lines[i] ?? '').trim();
    if (!candidate) continue;
    if (SUBSECTION_RE.test(candidate)) continue;
    if (/^(PT\.|S\.|NO\. 43\.|\[2024.\]|Finance Act 2024\.)/.test(candidate)) continue;
    return candidate;
  }
  return '';
}

function parseAmendsSection(text: string): string[] {
  const refs: string[] = [];
  // "Section 947A of the Principal Act", "section 472BB(3)", "section 82C(1)",
  // "paragraph 6(2)", "Schedule 2", "Part 3 of Schedule 26A", "Chapter 1 of Part 7"
  const patterns = [
    /section\s+([0-9]+[A-Z]*(?:\(\d+[A-Z]?\)*)*)/gi,
    /paragraph\s+([0-9]+\([0-9A-Z]\))+/gi,
    /Schedule\s+([0-9]+[A-Z]*)/gi,
    /Part\s+([0-9]+[A-Z]*) of Schedule\s+([0-9]+[A-Z]*)/gi,
    /Chapter\s+([0-9]+[A-Z]?) of Part\s+([0-9]+)/gi,
  ];
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      refs.push(m[0].replace(/\s+/g, ' '));
    }
  }
  return refs;
}

function parseEffectiveClue(text: string): string | null {
  // e.g. "year of assessment 2025" / "come into operation on ... 1 January 2025"
  const m = text.match(
    /(year of assessment \d+(?: and subsequent years of assessment)?|come[s]?\s*into operation.*?(\d{1,2} \w+ \d{4})|deemed to have come into operation.*?\d{1,2} \w+ \d{4})/gi,
  );
  return m?.[0]?.trim() ?? null;
}

function parseCitedActs(text: string): string[] {
  const out: string[] = [];
  for (const act of ACT_CITATIONS) {
    if (new RegExp(act.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
      out.push(act);
    }
  }
  return out;
}

/**
 * Parse the entire Finance Act 2024 enacted Markdown into provisions.
 *
 * The algorithm: walk lines, start a section on the first `^<num>. ` in the
 * body; close it on the next section start or on a trailing form-feed / page
 * header line. Everything between the section number line and the next section
 * is captured with source offsets.
 */
export function parseFinanceAct2024(source: string): ParsedProvision[] {
  const lines = source.split('\n');
  const offsets = lineOffsets(source);
  const provisions: ParsedProvision[] = [];

  // Find the start of the body: first line matching `^<num>. ` that occurs after
  // the Contents block. The Contents block contains the chapter headings and the
  // "Section" column header, but those are not `^<num>. ` body sections.
  const bodyStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (SECTION_RE.test(line)) bodyStarts.push(i);
  }

  for (let s = 0; s < bodyStarts.length; s++) {
    const startLine = bodyStarts[s] ?? 0;
    const sectionNumber = sectionNumberFromLine(lines[startLine] ?? '');
    if (!sectionNumber) continue;

    const nextStart = bodyStarts[s + 1];
    const endLine = nextStart !== undefined ? nextStart - 1 : lines.length - 1;
    // endLine is the last line *before* the next section header's gap.
    // Capture from startLine to endLine inclusive.
    const sliceLines = lines.slice(startLine, endLine + 1);
    // Drop trailing empty lines.
    while (sliceLines.length && sliceLines.at(-1)!.trim() === '') sliceLines.pop();
    while (sliceLines.length && sliceLines[0]!.trim() === '') sliceLines.shift();

    if (sliceLines.length === 0) continue;

    const heading = extractHeading(sliceLines, 0);
    const rawBody = sliceLines.join('\n');
    const provisionText = normaliseProvisionText(rawBody);

    const lower = rawBody;
    let principalActs: string[] = ACT_CITATIONS.filter((a) =>
      new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(lower),
    );
    // "Principal Act" alone is the Taxes Consolidation Act 1997 by default in a TCA context;
    // keep it explicit only when qualified. Drop bare "Principal Act" unless the section
    // also names a specific act — we resolve "Principal Act" at the application layer.
    const hasBarePrincipal = /\bPrincipal Act\b/.test(lower) && !principalActs.includes('Taxes Consolidation Act 1997');
    if (hasBarePrincipal) principalActs = ['Principal Act (Taxes Consolidation Act 1997)'];

    const sourceStart = offsets[startLine];
    const lastLineIdx = startLine + sliceLines.length - 1;
    const lastLine = lines[lastLineIdx] ?? '';
    const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

    provisions.push({
      sectionNumber,
      heading,
      provisionText,
      sourceStart,
      sourceEnd,
      principalActs,
      amendsSection: parseAmendsSection(rawBody),
      effectiveClue: parseEffectiveClue(rawBody),
      citedActs: parseCitedActs(rawBody),
      category: categoriseProvision(heading, provisionText),
    });
  }

  return provisions;
}

/** Parse from a filesystem path. */
export function parseFinanceAct2024File(path: string): ParsedProvision[] {
  return parseFinanceAct2024(readFileSync(path, 'utf8'));
}

/** Stable slug for a provision, derived purely from section number + heading. */
export function provisionSlug(sectionNumber: string, heading: string): string {
  const base = (heading || `section-${sectionNumber}`).toLowerCase();
  return base
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    + `-s${sectionNumber}`;
}

/**
 * Categorise a provision by its heading text using only deterministic keyword
 * matching on the heading — never an LLM inference. Returns the first match.
 */
export function categoriseProvision(heading: string, body: string): ParsedProvision['category'] {
  const text = `${heading} ${body}`.toLowerCase();
  const rules: Array<[RegExp, ParsedProvision['category']]> = [
    [/\b(usc|universal social charge)\b/, 'usc'],
    [/\bcorporation tax\b/, 'corporation_tax'],
    [/\b(capital gains tax|cgt)\b/, 'capital_gains_tax'],
    [/\bcapital allowances?\b/, 'capital_allowances'],
    [/\bvat\b/, 'vat'],
    [/\bincome tax\b/, 'income_tax'],
    [/\brelief\b/, 'relief'],
    [/\bexempt/, 'exemption'],
    [/\brepeal\b/, 'repeal'],
    [/\b(definitions?|interpretation)\b/, 'definitions'],
    [/\b(penalty|sanction)\b/, 'penalty'],
    [/\bprocedure\b/, 'procedure'],
  ];
  for (const [re, cat] of rules) {
    if (re.test(text)) return cat;
  }
  return 'other';
}

export type ProvisionCategory =
  | 'income_tax' | 'corporation_tax' | 'vat' | 'usc' | 'capital_allowances'
  | 'capital_gains_tax' | 'relief' | 'exemption' | 'penalty' | 'procedure'
  | 'definitions' | 'repeal' | 'other';

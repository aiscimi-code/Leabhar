/**
 * Deterministic parser for the Value-Added Tax Consolidation Act 2010
 * (VATCA 2010), converted Markdown.
 *
 * VATCA is a *principal* Act (it states the law directly), printed in the
 * Irish Statute Book's "marginal note" layout: each section's short heading
 * sits beside it rather than above it, unlike the Finance Act 2024 (an
 * *amending* Act, parsed by `statuteParser.ts`). `scripts/convert-statute-pdf.ts`
 * already reconstructs the heading onto its own line directly above the
 * section number during the one-time PDF conversion (see that script's own
 * header and docs/statutes/vatca-2010/README.md), so this parser reads the
 * same "heading above section" convention `statuteParser.ts` does, and
 * reuses its generic (source-independent) helpers: `categoriseProvision`,
 * `assessRelevance`, `provisionSlug`.
 *
 * Like `statuteParser.ts`, this is deliberately *textual*: it never infers
 * what a provision means, only what it says and where it lives. Every
 * derived rule downstream carries the verbatim `provisionText` as its
 * authority.
 *
 * Input conventions (verified against docs/statutes/vatca-2010/vatca-2010-enacted.md):
 *  - A section opens with `^<num>[A-Z]? .—` (e.g. "34 .—", "12 .—(1)").
 *  - Its heading is the line(s) directly above (see convert-statute-pdf.ts).
 *  - Sections 30, 42 and 55 are not resolved by the converter (an edge case
 *    in its column-splitting heuristic — see that script's header) and so do
 *    not appear here; Schedules are out of scope for this pass entirely (the
 *    conversion stops at the first "SCHEDULE" heading). Both are documented
 *    limitations, not silent gaps — see docs/RULES_KB.md.
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ParsedProvision } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ParsedProvision, ProvisionCategory } from './statuteParser';

const SECTION_RE = /^(\d{1,3}[A-Z]?)\s*\.—/;

/** Page-break/running-header noise this Act's conversion leaves between paragraphs. */
const PAGE_NOISE_RE = /^(Pt\.\s*\d+|Value-Added Tax Consolidation Act|No\.\s*31\.?|\[No\.\s*31\.?\]|\[?2010\.?\]?|\d+$)/;

function normaliseProvisionText(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !PAGE_NOISE_RE.test(line.trim()))
    .join('\n')
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

/**
 * A section's heading, printed on the line(s) directly above the section
 * number by convert-statute-pdf.ts. Walking upward: page noise is skipped
 * without ending the search; a blank line, a Part/Chapter header, or another
 * section's own number line ends it.
 */
function extractHeadingAbove(lines: string[], startLine: number): string {
  let j = startLine - 1;
  const collected: string[] = [];
  while (j >= 0) {
    const line = (lines[j] ?? '').trim();
    if (line === '') break;
    if (PAGE_NOISE_RE.test(line)) { j--; continue; }
    if (/^(PART|Chapter)\b/i.test(line)) return '';
    if (SECTION_RE.test(line)) return '';
    collected.unshift(line);
    j--;
  }
  return collected.join(' ');
}

/** Every "section N" (or "sections N and M", "section N(x)") reference in a provision's text. */
function parseSectionReferences(text: string): string[] {
  const refs: string[] = [];
  const re = /sections?\s+(\d{1,3}[A-Z]?(?:\([0-9A-Za-z]+\))*(?:\s*(?:,|and|or)\s*\d{1,3}[A-Z]?(?:\([0-9A-Za-z]+\))*)*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push(m[0].replace(/\s+/g, ' '));
  }
  return refs;
}

/**
 * Parse the VATCA 2010 converted Markdown into provisions.
 *
 * The algorithm mirrors `parseFinanceAct2024`: find every body section start,
 * capture from there to just before the next one, normalise, and locate the
 * heading above it. `source` here is the *converted Markdown*, not the PDF —
 * offsets are only recoverable against that file, which is itself
 * reproducible from the PDF (docs/statutes/vatca-2010/README.md).
 */
export function parseVatca2010(source: string): ParsedProvision[] {
  const lines = source.split('\n');
  const offsets = lineOffsets(source);
  const provisions: ParsedProvision[] = [];

  const bodyStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i] ?? '')) bodyStarts.push(i);
  }

  for (let s = 0; s < bodyStarts.length; s++) {
    const startLine = bodyStarts[s] ?? 0;
    const sectionMatch = (lines[startLine] ?? '').match(SECTION_RE);
    const sectionNumber = sectionMatch?.[1];
    if (!sectionNumber) continue;

    const nextStart = bodyStarts[s + 1];
    const endLine = nextStart !== undefined ? nextStart - 1 : lines.length - 1;
    const sliceLines = lines.slice(startLine, endLine + 1);
    while (sliceLines.length && sliceLines.at(-1)!.trim() === '') sliceLines.pop();
    while (sliceLines.length && sliceLines[0]!.trim() === '') sliceLines.shift();
    if (sliceLines.length === 0) continue;

    const heading = extractHeadingAbove(lines, startLine);
    const rawBody = sliceLines.join('\n');
    const provisionText = normaliseProvisionText(rawBody);

    const sourceStart = offsets[startLine] ?? 0;
    const lastLineIdx = startLine + sliceLines.length - 1;
    const lastLine = lines[lastLineIdx] ?? '';
    const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

    provisions.push({
      sectionNumber,
      heading,
      provisionText,
      sourceStart,
      sourceEnd,
      principalActs: [], // VATCA is itself the principal Act; nothing to record here.
      // "Sections this provision references" — VATCA is a principal Act, so
      // this is never "amends" the way it is for a Finance Act provision.
      amendsSection: parseSectionReferences(rawBody),
      effectiveClue: null, // VATCA states no per-section effective date; see the source's own commencement date (s.125).
      citedActs: [],
      category: categoriseProvision(heading, provisionText),
    });
  }

  return provisions;
}

export function parseVatca2010File(path: string): ParsedProvision[] {
  return parseVatca2010(readFileSync(path, 'utf8'));
}

/** Path to the bundled VATCA 2010 converted Markdown extract, resolved relative to this file. */
export const VATCA_2010_MD_PATH = new URL(
  '../../../docs/statutes/vatca-2010/vatca-2010-enacted.md',
  import.meta.url,
).pathname;

/**
 * Deterministic parser for VATCA 2010 Schedules 2 and 3, as converted by
 * `docs/statutes/scripts/extract_vat_sources.py` from the LRC's revised-Act
 * HTML (revisedacts.lawreform.ie) — a different source, and a different
 * point-in-time consolidation, from the "as enacted" principal-Act text
 * `vatcaParser.ts` reads (see `vatcaScheduleIngestion.ts` for why these are
 * ingested as their own `irish_knowledge_sources` rows, never merged into
 * the principal Act's).
 *
 * Layout (verified against docs/statutes/vatca-2010-revised/schedule-2.md
 * and schedule-3.md): a front-matter block, a `# Title` line, then the flat
 * body. A paragraph opens with a bare `N.` / `N. (1)` / `NA.` at the very
 * start of a line (no ".—" convention here, unlike the principal Act). Its
 * marginal-note heading sits one blank line above it (also unlike the
 * principal Act, where heading and number are adjacent with no blank line).
 *
 * Blank lines are NOT a reliable paragraph boundary here: the HTML->text
 * flattening in extract_vat_sources.py emits one for every separate HTML
 * text node, including an inline cross-reference link mid-sentence (e.g.
 * "...is deemed to supply under\n\nsection 91G\n." — a genuine blank line
 * sitting inside one subparagraph). So, exactly like `vatcaParser.ts`, a
 * paragraph's extent is found by locating every paragraph-opening *line*
 * and slicing from one to just before the next, never by grouping
 * blank-line-delimited blocks.
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ParsedProvision } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ParsedProvision, ProvisionCategory } from './statuteParser';

export interface ParsedScheduleParagraph {
  /** e.g. "1", "9A", "13B". Leading paragraph number only. */
  paragraphNumber: string;
  /** "Part 1" / "Part 2", when a PART heading precedes this paragraph in the source. */
  part: string | null;
  /** Marginal-note heading immediately above the paragraph (best-effort; see extractHeadingAbove). */
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ParsedProvision['category'];
}

export interface ScheduleFrontMatter {
  title: string;
  citation: string;
  sourceUrl: string;
  sourceHtmlSha256: string | null;
}

// A paragraph normally opens as "N. " or bare "N." on its own line, but at
// least one (Schedule 2 paragraph 5, "5.(1) The supply...") has no space
// before its first subparagraph — allow "(" as a third valid follow character.
const PARA_OPEN_RE = /^(\d{1,2}[A-Z]?)\.(?:\s|\(|$)/;
const PART_RE = /^PART\s+(\d+)\s*$/;
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n/;

/** Read the small hand-written YAML front matter `extract_vat_sources.py` writes. */
export function parseScheduleFrontMatter(source: string): ScheduleFrontMatter {
  const m = source.match(FRONT_MATTER_RE);
  const fields: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = line.match(/^([a-zA-Z0-9_]+):\s*"?([^"]*?)"?\s*$/);
      if (kv) fields[kv[1]!] = kv[2]!;
    }
  }
  return {
    title: fields.title ?? '',
    citation: fields.citation ?? '',
    sourceUrl: fields.source_url ?? '',
    sourceHtmlSha256: fields.source_html_sha256 ?? null,
  };
}

function normaliseProvisionText(raw: string): string {
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

/**
 * A paragraph's marginal-note heading, one blank line above its number in
 * this source (contrast `vatcaParser.ts`'s `extractHeadingAbove`, where
 * heading and number are adjacent). Skips exactly one run of blank lines,
 * then collects the short block above — capped at 120 characters so a
 * paragraph with no heading of its own (none observed, but not guaranteed)
 * cannot silently slurp the previous paragraph's body text instead.
 */
function extractHeadingAbove(lines: string[], startLine: number): string {
  let j = startLine - 1;
  while (j >= 0 && (lines[j] ?? '').trim() === '') j--;
  const collected: string[] = [];
  while (j >= 0) {
    const line = (lines[j] ?? '').trim();
    if (line === '') break;
    if (PART_RE.test(line) || PARA_OPEN_RE.test(line)) break;
    if (/^SCHEDULE\s+\d/.test(line) || /^\[.*\]$/.test(line) || /^Section\s+\d+$/.test(line)) break;
    collected.unshift(line);
    j--;
    if (collected.join(' ').length > 120) break;
  }
  return collected.join(' ');
}

/**
 * Parse a Schedule's converted Markdown into its top-level numbered
 * paragraphs. `scheduleNumber` ("2" or "3") is only used to build the
 * category-assessment input; it plays no role in matching.
 */
export function parseVatcaSchedule(source: string): ParsedScheduleParagraph[] {
  const lines = source.split('\n');
  const offsets = lineOffsets(source);
  const paragraphs: ParsedScheduleParagraph[] = [];

  const bodyStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (PARA_OPEN_RE.test(lines[i] ?? '')) bodyStarts.push(i);
  }

  let currentPart: string | null = null;
  let partCursor = 0;

  for (let s = 0; s < bodyStarts.length; s++) {
    const startLine = bodyStarts[s] ?? 0;

    while (partCursor < startLine) {
      const pm = (lines[partCursor] ?? '').trim().match(PART_RE);
      if (pm) currentPart = `Part ${pm[1]}`;
      partCursor++;
    }

    const match = (lines[startLine] ?? '').match(PARA_OPEN_RE);
    const paragraphNumber = match?.[1];
    if (!paragraphNumber) continue;

    const nextStart = bodyStarts[s + 1];
    const endLine = nextStart !== undefined ? nextStart - 1 : lines.length - 1;
    const sliceLines = lines.slice(startLine, endLine + 1);
    while (sliceLines.length && sliceLines.at(-1)!.trim() === '') sliceLines.pop();
    if (sliceLines.length === 0) continue;

    const heading = extractHeadingAbove(lines, startLine);
    const rawBody = sliceLines.join('\n');
    const provisionText = normaliseProvisionText(rawBody);

    const sourceStart = offsets[startLine] ?? 0;
    const lastLineIdx = startLine + sliceLines.length - 1;
    const lastLine = lines[lastLineIdx] ?? '';
    const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

    paragraphs.push({
      paragraphNumber,
      part: currentPart,
      heading,
      provisionText,
      sourceStart,
      sourceEnd,
      category: categoriseProvision(heading, provisionText),
    });
  }

  return paragraphs;
}

export function parseVatcaScheduleFile(path: string): ParsedScheduleParagraph[] {
  return parseVatcaSchedule(readFileSync(path, 'utf8'));
}

export const VATCA_SCHEDULE_1_MD_PATH = new URL(
  '../../../docs/statutes/vatca-2010-revised/schedule-1.md',
  import.meta.url,
).pathname;

export const VATCA_SCHEDULE_2_MD_PATH = new URL(
  '../../../docs/statutes/vatca-2010-revised/schedule-2.md',
  import.meta.url,
).pathname;

export const VATCA_SCHEDULE_3_MD_PATH = new URL(
  '../../../docs/statutes/vatca-2010-revised/schedule-3.md',
  import.meta.url,
).pathname;

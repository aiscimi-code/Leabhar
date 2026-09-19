/**
 * Deterministic parser for S.I. 639/2010 (Value-Added Tax Regulations 2010),
 * as-made text at docs/statutes/si-639-2010/2010-si-639.md — a single
 * converted Markdown covering all regulations, like the VATCA/Finance Act
 * 2024 whole-Act parsers, not the one-file-per-provision shape TCA 1997 or
 * the VATCA Schedules use.
 *
 * Layout (verified against the committed file): front matter, a title line,
 * an "ARRANGEMENT OF REGULATIONS" table of contents (numbered headings only,
 * no body), the enacting clause ("...hereby make the following
 * regulations:"), the 47 regulations themselves (each opening as a bare
 * "N." / "N. (1)" on its own line, exactly like the VATCA Schedules'
 * convention — see `vatcaScheduleParser.ts`'s header for why that convention
 * needs line-based extent-finding rather than blank-line-block grouping),
 * then an "EXPLANATORY NOTE" appendix that also numbers 1-47 in prose
 * summary form. Both the table of contents and the Explanatory Note are
 * excluded by finding the real body's own start/end markers first, rather
 * than trying to distinguish a real regulation-opener from a TOC or
 * explanatory-note line by pattern alone.
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedSi639Regulation {
  /** e.g. "25". Leading regulation number only. */
  regulationNumber: string;
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

const REG_OPEN_RE = /^(\d{1,2}[A-Z]?)\.(?:\s|\(|$)/;
const ENACTING_CLAUSE_RE = /hereby make the following regulations:/;
const EXPLANATORY_NOTE_RE = /^EXPLANATORY NOTE$/;

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

/** Marginal heading directly above a regulation, one blank line up — same
 *  convention and same extraction approach as `vatcaScheduleParser.ts`. */
function extractHeadingAbove(lines: string[], startLine: number): string {
  let j = startLine - 1;
  while (j >= 0 && (lines[j] ?? '').trim() === '') j--;
  const collected: string[] = [];
  while (j >= 0) {
    const line = (lines[j] ?? '').trim();
    if (line === '') break;
    if (REG_OPEN_RE.test(line)) break;
    collected.unshift(line);
    j--;
    if (collected.join(' ').length > 120) break;
  }
  return collected.join(' ');
}

export function parseSi639(source: string): ParsedSi639Regulation[] {
  const enactingMatch = ENACTING_CLAUSE_RE.exec(source);
  if (!enactingMatch) throw new Error('parseSi639: enacting clause ("hereby make the following regulations:") not found');
  const bodyStartOffset = enactingMatch.index + enactingMatch[0].length;

  const explanatoryMatch = new RegExp(EXPLANATORY_NOTE_RE.source, 'm').exec(source);
  const bodyEndOffset = explanatoryMatch ? explanatoryMatch.index : source.length;

  const lines = source.split('\n');
  const offsets = lineOffsets(source);
  // The line index containing bodyStartOffset, plus one: scanning begins on
  // the line *after* the enacting clause, never on the clause's own line.
  const bodyStartLine = source.slice(0, bodyStartOffset).split('\n').length;
  const bodyEndLine = explanatoryMatch
    ? source.slice(0, bodyEndOffset).split('\n').length - 1
    : lines.length;

  const regulations: ParsedSi639Regulation[] = [];
  const bodyStarts: number[] = [];
  for (let i = bodyStartLine; i < bodyEndLine; i++) {
    if (REG_OPEN_RE.test(lines[i] ?? '')) bodyStarts.push(i);
  }

  for (let s = 0; s < bodyStarts.length; s++) {
    const startLine = bodyStarts[s]!;
    const match = (lines[startLine] ?? '').match(REG_OPEN_RE);
    const regulationNumber = match?.[1];
    if (!regulationNumber) continue;

    const nextStart = bodyStarts[s + 1];
    const endLine = nextStart !== undefined ? nextStart - 1 : bodyEndLine - 1;
    const sliceLines = lines.slice(startLine, endLine + 1);
    while (sliceLines.length && sliceLines.at(-1)!.trim() === '') sliceLines.pop();
    if (sliceLines.length === 0) continue;

    const heading = extractHeadingAbove(lines, startLine);
    const rawBody = sliceLines.join('\n');
    const provisionText = rawBody.replace(/\n{3,}/g, '\n\n').trim();

    const sourceStart = offsets[startLine] ?? 0;
    const lastLineIdx = startLine + sliceLines.length - 1;
    const lastLine = lines[lastLineIdx] ?? '';
    const sourceEnd = (offsets[lastLineIdx] ?? 0) + lastLine.length;

    regulations.push({
      regulationNumber,
      heading,
      provisionText,
      sourceStart,
      sourceEnd,
      category: categoriseProvision(heading, provisionText),
    });
  }

  return regulations;
}

export function parseSi639File(path: string): ParsedSi639Regulation[] {
  return parseSi639(readFileSync(path, 'utf8'));
}

export const SI_639_2010_MD_PATH = new URL(
  '../../../docs/statutes/si-639-2010/2010-si-639.md',
  import.meta.url,
).pathname;

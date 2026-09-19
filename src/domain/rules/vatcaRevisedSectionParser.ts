/**
 * Deterministic parser for an individual VATCA 2010 section, LRC-revised
 * text, one file per section under docs/statutes/vatca-2010-revised/
 * (s002.md ... s108C.md) — fetched by extract_vat_sources.py, distinct from
 * both the whole-Act as-enacted text `vatcaParser.ts` reads and the
 * Schedule paragraphs `vatcaScheduleParser.ts` reads, though all three come
 * from the same LRC site and share its HTML->text conversion.
 *
 * Layout (verified against s046.md, s002.md, s91A.md, s108A.md — chosen to
 * cover the observed variation): front matter, a `# VATCA 2010 s.N
 * (revised)` title, then: a bare repeat of the section number as a page
 * heading (sometimes printed twice), the section's marginal heading text,
 * optionally a `[...]` predecessor-Act citation bracket (older sections
 * only — one inserted after 2010, like s.91A, has none; VATA-era brackets
 * can themselves span two lines, e.g. s.2's "[VATA s. 1 (in part) and s.
 * 3(1B) and FA 2010\ns. 165(4)]"), then the section number a final time
 * immediately before its own operative text. That last marker is not
 * consistently formatted: "46\n.—(1)", "91A\n.\n—\nIn", and "108A\n.\n—\n(1)"
 * all appear across real files — rather than match one specific line
 * pattern, this parser searches the whole post-title text for
 * `<sectionNumber>` followed by `.` followed by `—`, with any amount of
 * whitespace (including newlines) between each, and treats that as the
 * unambiguous start of the operative text (a plain word-boundary check
 * stops "9" spuriously matching inside "91A").
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';
import { parseScheduleFrontMatter, type ScheduleFrontMatter } from './vatcaScheduleParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';
export type { ScheduleFrontMatter as VatcaRevisedFrontMatter };

export interface ParsedVatcaRevisedSection {
  /** e.g. "46", "91A". Leading section number only. */
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
const CITATION_SECTION_RE = /s\.(\w+)"?\s*$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseVatcaRevisedSection(source: string): ParsedVatcaRevisedSection {
  const fm = parseScheduleFrontMatter(source);
  const numberMatch = CITATION_SECTION_RE.exec(fm.citation);
  if (!numberMatch) {
    throw new Error(`parseVatcaRevisedSection: could not read a section number from citation "${fm.citation}"`);
  }
  const sectionNumber = numberMatch[1]!;

  const fmMatch = source.match(FRONT_MATTER_RE);
  const afterFrontMatter = fmMatch ? fmMatch[0].length : 0;
  const titleMatch = TITLE_LINE_RE.exec(source.slice(afterFrontMatter));
  if (!titleMatch) throw new Error('parseVatcaRevisedSection: no "# VATCA 2010 s.N (revised)" title line found');
  const bodyStart = afterFrontMatter + titleMatch.index + titleMatch[0].length;

  const operativeOpenRe = new RegExp(`\\b${escapeRegExp(sectionNumber)}\\b\\s*\\.\\s*—`);
  const bodyText = source.slice(bodyStart);
  const operativeMatch = operativeOpenRe.exec(bodyText);
  if (!operativeMatch) {
    throw new Error(`parseVatcaRevisedSection: no operative-text start ("${sectionNumber}.—") found`);
  }
  const operativeOffsetInBody = operativeMatch.index;
  const sourceStart = bodyStart + operativeOffsetInBody;

  // Heading: everything between the title and the operative start, minus
  // blank lines, minus any line that is just the bare section number
  // (printed once or twice as a page heading), minus a `[...]` predecessor-
  // citation bracket — which can itself span more than one line.
  const preambleLines = bodyText.slice(0, operativeOffsetInBody).split('\n');
  const headingLines: string[] = [];
  let inBracket = false;
  for (const raw of preambleLines) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBracket) { if (line.endsWith(']')) inBracket = false; continue; }
    if (line === sectionNumber) continue;
    if (line.startsWith('[')) { if (!line.endsWith(']')) inBracket = true; continue; }
    headingLines.push(line);
  }
  const heading = headingLines.join(' ').trim();

  const bodyLines = source.slice(sourceStart).split('\n');
  while (bodyLines.length && bodyLines.at(-1)!.trim() === '') bodyLines.pop();
  const provisionText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const sourceEnd = sourceStart + bodyLines.join('\n').length;

  return {
    sectionNumber,
    heading,
    provisionText,
    sourceStart,
    sourceEnd,
    category: categoriseProvision(heading, provisionText),
  };
}

export function parseVatcaRevisedSectionFile(path: string): ParsedVatcaRevisedSection {
  return parseVatcaRevisedSection(readFileSync(path, 'utf8'));
}

export function vatcaRevisedSectionPath(sectionNumber: string): string {
  const padded = /^\d+$/.test(sectionNumber) ? sectionNumber.padStart(3, '0') : sectionNumber;
  return new URL(
    `../../../docs/statutes/vatca-2010-revised/s${padded}.md`,
    import.meta.url,
  ).pathname;
}

export const VATCA_REVISED_S046_MD_PATH = vatcaRevisedSectionPath('46');

/**
 * Deterministic parser for an individual Companies Act 2014 section, LRC-
 * revised text, one file per section under docs/statutes/companies-act-2014/
 * (s282.md, s280A.md, ...) — fetched by extract_vat_sources.py's
 * extract_companies_act_2014(), the same per-section LRC fetch shape VATCA's
 * revised sections use (vatcaRevisedSectionParser.ts) and the same front
 * matter/HTML->text conversion, but a different operative-text marker
 * convention: this Act prints the section number, then a bare "." with
 * nothing else, alone on its own line — never VATCA's "N\n.—(1)" run-on
 * convention. Verified against all eight fetched sections (s282, s280A,
 * s280D, s280E, s352, s358, s359, s360): in every one, the first line after
 * the marginal heading that is exactly "<sectionNumber>." is the operative
 * text's start, one line before its own "(1)"/first paragraph — so this
 * parser matches that literal line rather than reusing VATCA's em-dash
 * search, which would never match here at all.
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedCompaniesAct2014Section {
  /** e.g. "282", "280A". Leading section number only. */
  sectionNumber: string;
  /** The section's own marginal heading, e.g. "Basic requirements for accounting records". */
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

const FRONT_MATTER_RE = /^---\n[\s\S]*?\n---\n/;
const TITLE_LINE_RE = /^#\s+.*$/m;
const CITATION_SECTION_RE = /s\.(\w+)"?\s*$/;

export function parseCompaniesAct2014Section(source: string): ParsedCompaniesAct2014Section {
  const fm = parseScheduleFrontMatter(source);
  const numberMatch = CITATION_SECTION_RE.exec(fm.citation);
  if (!numberMatch) {
    throw new Error(`parseCompaniesAct2014Section: could not read a section number from citation "${fm.citation}"`);
  }
  const sectionNumber = numberMatch[1]!;

  const fmMatch = source.match(FRONT_MATTER_RE);
  const afterFrontMatter = fmMatch ? fmMatch[0].length : 0;
  const titleMatch = TITLE_LINE_RE.exec(source.slice(afterFrontMatter));
  if (!titleMatch) {
    throw new Error('parseCompaniesAct2014Section: no "# Companies Act 2014 s.N (revised)" title line found');
  }
  const bodyStart = afterFrontMatter + titleMatch.index + titleMatch[0].length;

  const bodyText = source.slice(bodyStart);
  const lines = bodyText.split('\n');
  const openerLine = `${sectionNumber}.`;
  const openerLineIdx = lines.findIndex((l) => l.trim() === openerLine);
  if (openerLineIdx === -1) {
    throw new Error(`parseCompaniesAct2014Section: no operative-text opener line "${openerLine}" found`);
  }

  const sourceStart = bodyStart + lines.slice(0, openerLineIdx).join('\n').length
    + (openerLineIdx > 0 ? 1 : 0); // account for the newline the join() above drops

  // Heading: non-blank lines between the title and the opener, minus the
  // bare section-number page-heading line (printed once, with no trailing ".").
  const headingLines: string[] = [];
  for (let i = 0; i < openerLineIdx; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line === sectionNumber) continue;
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

export function parseCompaniesAct2014SectionFile(path: string): ParsedCompaniesAct2014Section {
  return parseCompaniesAct2014Section(readFileSync(path, 'utf8'));
}

export function companiesAct2014SectionPath(sectionNumber: string): string {
  return new URL(
    `../../../docs/statutes/companies-act-2014/s${sectionNumber}.md`,
    import.meta.url,
  ).pathname;
}

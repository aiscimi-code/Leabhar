/**
 * Deterministic parser for S.I. 156/2012 (Tax Returns and Payments (Mandatory
 * Electronic Filing and Payment of Tax) Regulations 2012), as made.
 *
 * It reads each regulation under its own `## ` heading, numbered opener
 * intact (e.g. "4. (1) Where any specified person..."). The catalogue
 * extraction lays the Irish Statute Book page out that way
 * (`scripts/catalogue/extract.ts`, #556), as the statute copy before it was
 * written. A heading whose body does not open with a number is skipped: the
 * copy replaced regulations 5-9 with one summary line ("5–9. Capacity
 * exclusions, ..."), a paraphrase, not a source, and the opener regex
 * (`^(\d+)\.\s`) does not match "5–9." (an en-dash follows the first digit).
 *
 * The knowledge base holds regs 1, 2 and 4, the ones that copy quoted; the
 * page has all nine (#705).
 */
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedSi156Regulation {
  regulationNumber: string;
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

const HEADING_RE = /^## (.+)$/;
const NUMBERED_OPENER_RE = /^(\d+)\.\s/;

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

export function parseSi156(source: string): ParsedSi156Regulation[] {
  const lines = source.split('\n');
  const offsets = lineOffsets(source);

  const headingLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i] ?? '')) headingLines.push(i);
  }

  const regulations: ParsedSi156Regulation[] = [];
  for (let h = 0; h < headingLines.length; h++) {
    const headingLine = headingLines[h]!;
    const headingMatch = (lines[headingLine] ?? '').match(HEADING_RE);
    const heading = headingMatch?.[1]?.trim() ?? '';

    const nextHeadingLine = headingLines[h + 1];
    const bodyEndLine = nextHeadingLine !== undefined ? nextHeadingLine - 1 : lines.length - 1;

    // The body's first non-blank line must itself carry the numbered opener;
    // a heading whose body doesn't (the "5–9. ..." placeholder) is not a real
    // verbatim provision and is silently skipped.
    let firstBodyLine = headingLine + 1;
    while (firstBodyLine <= bodyEndLine && (lines[firstBodyLine] ?? '').trim() === '') firstBodyLine++;
    const openerMatch = (lines[firstBodyLine] ?? '').match(NUMBERED_OPENER_RE);
    if (!openerMatch) continue;
    const regulationNumber = openerMatch[1]!;

    const sliceLines = lines.slice(firstBodyLine, bodyEndLine + 1);
    while (sliceLines.length && sliceLines.at(-1)!.trim() === '') sliceLines.pop();
    if (sliceLines.length === 0) continue;

    const provisionText = sliceLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const sourceStart = offsets[firstBodyLine] ?? 0;
    const lastLineIdx = firstBodyLine + sliceLines.length - 1;
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

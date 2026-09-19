/**
 * Deterministic parser for Revenue TDM Part 38-01-03b (Guidelines for VAT
 * Registration), as-converted PDF text at
 * docs/statutes/tdm-38-01-03b/38-01-03b.md (pdfplumber extraction, real
 * `source_pdf_sha256` in front matter — genuinely verbatim, unlike the short
 * paraphrased reference files this KB has excluded elsewhere).
 *
 * This 40+ page manual repeats its "Exclusion from Mandatory Electronic
 * Filing and Payment of Tax" guidance once per registrant-type scenario
 * (resident/non-resident individual/company) — four times, verified
 * byte-identical by `extractCapacityExclusionSection`'s own test. Rather
 * than build a whole-document parser for a 40-page manual to reach one
 * repeated paragraph, this extracts just that one section by anchoring on
 * its own heading and closing sentence — the same targeted, one-provision
 * approach used for `si692025Parser.ts`.
 *
 * This closes a gap `si156Curation.ts` explicitly flagged: S.I. 156/2012
 * reg.5's "capacity" exclusion criteria are not restated anywhere in this
 * KB because the local si-156-2012 transcript only summarises regs 5-9
 * rather than quoting them. This TDM is Revenue's own guidance on exactly
 * that exclusion — a different source, lower in the source hierarchy than
 * the Regulation itself (`revenue_guidance`, not `legislation`), but
 * genuinely verbatim and citable in its own right.
 */
import { readFileSync } from 'node:fs';

const HEADING = 'Exclusion from Mandatory Electronic Filing and Payment of Tax';
const END_ANCHOR = 'of this notification.';

export interface ParsedTdmCapacityExclusion {
  heading: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  /** How many byte-identical repeats of this section the document contains. */
  occurrences: number;
}

export function extractCapacityExclusionSection(source: string): ParsedTdmCapacityExclusion {
  const occurrences: string[] = [];
  let searchFrom = 0;
  let firstStart = -1;
  let firstEnd = -1;

  for (;;) {
    const headingIdx = source.indexOf(HEADING, searchFrom);
    if (headingIdx === -1) break;
    const anchorIdx = source.indexOf(END_ANCHOR, headingIdx);
    if (anchorIdx === -1) break;
    const end = anchorIdx + END_ANCHOR.length;
    const text = source.slice(headingIdx, end);
    occurrences.push(text);
    if (firstStart === -1) { firstStart = headingIdx; firstEnd = end; }
    searchFrom = end;
  }

  if (occurrences.length === 0) {
    throw new Error(`extractCapacityExclusionSection: "${HEADING}" not found`);
  }
  const normalised = occurrences.map((t) => t.replace(/\s+/g, ' ').trim());
  const distinct = new Set(normalised);
  if (distinct.size > 1) {
    throw new Error(
      `extractCapacityExclusionSection: ${distinct.size} textually different versions of "${HEADING}" found — `
      + 'refusing to pick one arbitrarily; this parser assumes every repeat is identical boilerplate.',
    );
  }

  const rawBody = source.slice(firstStart, firstEnd);
  const bodyLines = rawBody.split('\n');
  const heading = bodyLines[0]!.trim();
  const provisionText = bodyLines.slice(1).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    heading,
    provisionText,
    sourceStart: firstStart,
    sourceEnd: firstEnd,
    occurrences: occurrences.length,
  };
}

export function extractCapacityExclusionSectionFile(path: string): ParsedTdmCapacityExclusion {
  return extractCapacityExclusionSection(readFileSync(path, 'utf8'));
}

export const TDM_38_01_03B_MD_PATH = new URL(
  '../../../docs/statutes/tdm-38-01-03b/38-01-03b.md',
  import.meta.url,
).pathname;

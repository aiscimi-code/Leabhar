/**
 * Deterministic parser for S.I. 69/2025 (European Union (Value-Added Tax)
 * Regulations 2025), as-made text at
 * docs/statutes/si-69-2025/2025-si-69.md — an amending instrument that
 * substitutes text directly into VATCA 2010 (transposing the EU cross-border
 * SME exemption scheme, Council Directive (EU) 2020/285).
 *
 * This is not a whole-document, many-provisions-per-file parser like
 * `si639Parser.ts`: the document's ten numbered regulations sit alongside a
 * newly-inserted VATCA Chapter (sections 92B, 92C, 92D) *within* regulation
 * 9's own substituted text, and "92B." etc. would themselves match a naive
 * bare-number-opener regex — a whole-document parser would need to tell a
 * top-level regulation boundary apart from a nested inserted-section number,
 * which this file does not attempt. Instead, `parseSi692025Regulation`
 * extracts exactly one named top-level regulation (1-10) by finding its own
 * "^N. " line-start marker and the next top-level regulation's marker (or
 * end of document) as the boundary — the same targeted, one-provision
 * approach `vatcaRevisedSectionParser.ts` uses for a single VATCA section.
 *
 * Only Regulation 8 is extracted today (see `si692025Curation.ts`): it
 * substitutes the current eligibility test for the moneys-received (cash)
 * basis of VAT accounting into VATCA 2010 s.80(1)(a) and (b) — closing the
 * gap `si639Curation.ts` explicitly flagged ("the real threshold lives in
 * VATCA s.80(1), not this Regulation, and is not restated or curated here").
 */
import { readFileSync } from 'node:fs';
import { categoriseProvision, provisionSlug, type ProvisionCategory } from './statuteParser';

export { categoriseProvision, provisionSlug, assessRelevance } from './statuteParser';
export type { ProvisionCategory } from './statuteParser';

export interface ParsedSi692025Regulation {
  regulationNumber: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  category: ProvisionCategory;
}

/** Only ever called with a top-level regulation number 1-10 in this document. */
export function parseSi692025Regulation(source: string, regulationNumber: string): ParsedSi692025Regulation {
  const startRe = new RegExp(`^${regulationNumber}\\.\\s`, 'm');
  const startMatch = startRe.exec(source);
  if (!startMatch) {
    throw new Error(`parseSi692025Regulation: no top-level marker for regulation ${regulationNumber} found`);
  }
  const sourceStart = startMatch.index;

  const nextNumber = String(Number(regulationNumber) + 1);
  const endRe = new RegExp(`^${nextNumber}\\.\\s`, 'm');
  const afterStart = source.slice(sourceStart + startMatch[0].length);
  const endMatch = endRe.exec(afterStart);
  const sourceEndExclusive = endMatch ? sourceStart + startMatch[0].length + endMatch.index : source.length;

  const rawSlice = source.slice(sourceStart, sourceEndExclusive);
  const lines = rawSlice.split('\n');
  while (lines.length && lines.at(-1)!.trim() === '') lines.pop();
  const provisionText = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    regulationNumber,
    provisionText,
    sourceStart,
    sourceEnd: sourceStart + rawSlice.trimEnd().length,
    category: categoriseProvision('', provisionText),
  };
}

export function parseSi692025RegulationFile(path: string, regulationNumber: string): ParsedSi692025Regulation {
  return parseSi692025Regulation(readFileSync(path, 'utf8'), regulationNumber);
}

export const SI_69_2025_MD_PATH = new URL(
  '../../../docs/statutes/si-69-2025/2025-si-69.md',
  import.meta.url,
).pathname;

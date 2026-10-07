/**
 * Parsers for the two Revenue form-guidance documents behind the VAT return
 * screens (issue #439): Revenue's "How do you complete a VAT 3 return?" page
 * and TDM VAT-RTD-S76, the Return of Trading Details manual. The catalogue
 * extraction reads each with it (catalogue/vat3-rtd/, #556).
 *
 * Both are already read directly by src/domain/vat (boxDefinitions.ts, rtd.ts)
 * for the figures; this parser turns the same passages into offset-addressable
 * provisions so the rules knowledge base can cite the form a treatment lands
 * on, and re-check the quote against the file, like any other source.
 */
import { normaliseSpace } from '../vat/boxDefinitions';

export interface ParsedPassage {
  sectionNumber: string;
  heading: string;
  /** Whitespace-collapsed text of the passage, verbatim otherwise. */
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
  /** The source's own way of pointing a reader here (set by the ingest step). */
  locator?: string;
}

/** The VAT3 boxes Revenue's page defines, in the page's own order. */
export const VAT3_BOX_CODES = ['T1', 'T2', 'T3', 'T4', 'E1', 'E2', 'ES1', 'ES2', 'PA1'] as const;

/** Where the VAT3 page's box definitions stop being box definitions. */
const VAT3_TAIL = 'Please see Further guidance';

/**
 * The box passages of Revenue's VAT3 page: each box heading ("T1 – VAT on
 * sales") starts a passage that runs to the next box heading or the page tail.
 */
export function parseVat3Boxes(markdown: string): ParsedPassage[] {
  interface BoxStart { code: string; index: number; heading: string }
  const found: BoxStart[] = VAT3_BOX_CODES.flatMap((code) => {
    const m = new RegExp(`^${code}\\s*[\\u2013-]\\s*(.+)$`, 'm').exec(markdown);
    return m ? [{ code, index: m.index, heading: m[1]!.trim() }] : [];
  }).sort((a, b) => a.index - b.index);
  const tailIndex = markdown.indexOf(VAT3_TAIL);
  const end = tailIndex >= 0 ? tailIndex : markdown.length;
  return found.map((start, i) => {
    const next = found[i + 1]?.index ?? end;
    const slice = markdown.slice(start.index, Math.min(next, end));
    return {
      sectionNumber: start.code,
      heading: normaliseSpace(start.heading),
      provisionText: normaliseSpace(slice),
      sourceStart: start.index,
      sourceEnd: Math.min(next, end),
    };
  });
}

/** The RTD manual passages curated into rules: (section, heading, until heading). */
export const RTD_PASSAGES: Array<{ sectionNumber: string; heading: RegExp; next: RegExp }> = [
  { sectionNumber: '1', heading: /^1 Introduction$/m, next: /^2 The ROS VAT RTD$/m },
  { sectionNumber: '2.2', heading: /^ ?2\.2 Supplies of Goods and \/ or Services filing$/m, next: /^ ?2\.3 Acquisitions/m },
  { sectionNumber: '2.3', heading: /^ ?2\.3 Acquisitions from the European Union and Non-European Union$/m, next: /^ ?2\.4 Goods or Services Purchased for Resale/m },
  { sectionNumber: '2.4', heading: /^ ?2\.4 Goods or Services Purchased for Resale \(Irish or Intra EU acquisitions,$/m, next: /^ ?2\.5 Other Deductible Goods and Services/m },
  { sectionNumber: '2.5', heading: /^ ?2\.5 Other Deductible Goods and Services \(Irish or Intra-EU acquisitions, Postponed$/m, next: /^2\.6 Traditional presentation of VAT RTD$/m },
  { sectionNumber: '2.6', heading: /^2\.6 Traditional presentation of VAT RTD$/m, next: /^3 VAT RTD – Compliance Measures$/m },
];

/** The curated passages of TDM VAT-RTD-S76. */
export function parseRtdManualSections(markdown: string): ParsedPassage[] {
  return RTD_PASSAGES.flatMap((p) => {
    const heading = p.heading.exec(markdown);
    if (!heading) return [];
    const from = heading.index + heading[0].length;
    const nextMatch = p.next.exec(markdown.slice(from));
    const to = nextMatch ? from + nextMatch.index : markdown.length;
    return [{
      sectionNumber: p.sectionNumber,
      heading: normaliseSpace(heading[0]),
      provisionText: normaliseSpace(markdown.slice(from, to)),
      sourceStart: heading.index,
      sourceEnd: to,
    }];
  });
}

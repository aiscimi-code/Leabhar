import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVatca2010 } from './vatcaParser';
import { VATCA_CURATED_RULES } from './vatcaCuration';
import { readCatalogueEntry } from './catalogue';
import { VATCA_2010_CATALOGUE_ENTRY } from './vatcaIngestion';

/**
 * The Act as enacted is parsed into the rules catalogue (#556): the structure
 * tests read the parse the extraction committed; the parser's own mechanics
 * run on an excerpt (ss.33-35) as `convert-statute-pdf.ts` converts the PDF.
 */
const EXCERPT = readFileSync(new URL('./__fixtures__/vatca-2010-enacted-excerpt.md', import.meta.url), 'utf8');
const sections = () => readCatalogueEntry(VATCA_2010_CATALOGUE_ENTRY).provisions;

describe('vatcaParser', () => {
  it('parses every body section 1-125, skipping the table of contents and Schedules', () => {
    const numbers = new Set(sections().map((p) => p.sectionNumber));
    for (let n = 1; n <= 125; n++) expect(numbers.has(String(n))).toBe(true);
    // Nothing beyond "SCHEDULE" is parsed at all.
    expect(numbers.has('126')).toBe(false);
    expect(numbers.size).toBe(125);
  });

  it('records stable, in-bounds source offsets', () => {
    const provs = parseVatca2010(EXCERPT);
    expect(provs.map((p) => p.sectionNumber)).toEqual(['33', '34', '35']);
    for (const p of provs) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    }
  });

  it('preserves verbatim provision text with a recoverable offset slice', () => {
    const s34 = parseVatca2010(EXCERPT).find((p) => p.sectionNumber === '34')!;
    const slice = EXCERPT.slice(s34.sourceStart, s34.sourceEnd);
    const tokens = s34.provisionText.split(/\s+/).filter((t) => t.length > 4);
    const hits = tokens.filter((t) => slice.includes(t)).length;
    expect(hits / tokens.length).toBeGreaterThan(0.9);
    // The excerpt parses to the same words as the whole Act did.
    expect(sections().find((p) => p.sectionNumber === '34')!.excerpt).toBe(s34.provisionText);
  });

  it('reads the margin heading above each section', () => {
    expect(parseVatca2010(EXCERPT).map((p) => p.heading)).toEqual([
      'Application and interpretation of section 34 .', expect.any(String), 'Use and enjoyment provisions.',
    ]);
  });

  it('categorises VATCA provisions as vat when they say "value-added tax" even without the acronym', () => {
    expect(sections().find((p) => p.sectionNumber === '3')!.category).toBe('vat');
  });

  it('is idempotent across two parses', () => {
    expect(parseVatca2010(EXCERPT)).toEqual(parseVatca2010(EXCERPT));
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of its provision\'s text', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of VATCA_CURATED_RULES) {
      const p = sections().find((x) => x.sectionNumber === rule.sectionNumber);
      expect(p, `provision for ${rule.ruleKey} (s.${rule.sectionNumber})`).toBeDefined();
      expect(
        norm(p!.excerpt),
        `${rule.ruleKey}: statementExcerpt must be verbatim`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });
});

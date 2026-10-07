import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi639 } from './si639Parser';
import { readCatalogueEntry } from './catalogue';
import { SI_639_CATALOGUE_ENTRY } from './si639Ingestion';

/** The enacting clause, regs 1-2 and the start of the Explanatory Note, as the page converts: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/si-639-2010-excerpt.md', import.meta.url), 'utf8');
/** Every regulation, as the catalogue extraction parsed it from the page. */
const regs = readCatalogueEntry(SI_639_CATALOGUE_ENTRY).provisions;

describe('parseSi639', () => {
  it('parses exactly regulations 1-47, excluding the table of contents and Explanatory Note', () => {
    const numbers = regs.map((r) => r.sectionNumber);
    for (let n = 1; n <= 47; n++) expect(numbers).toContain(String(n));
    expect(numbers).toHaveLength(47);
    expect(parseSi639(EXCERPT).map((r) => r.regulationNumber)).toEqual(['1', '2']);
  });

  it('records the marginal heading for a sampled regulation', () => {
    expect(regs.find((r) => r.sectionNumber === '25')!.heading).toBe('Determination of tax due by reference to moneys received');
    expect(parseSi639(EXCERPT)[0]!.heading).toBe('Citation and commencement');
  });

  it('captures the full verbatim body of a regulation, not the TOC entry or Explanatory Note summary', () => {
    const reg25 = regs.find((r) => r.sectionNumber === '25')!;
    expect(reg25.excerpt.startsWith('25. (1) In this Regulation')).toBe(true);
    expect(reg25.excerpt).toContain('moneys received basis of accounting');
    // The Explanatory Note's own summary of regulation 25 uses different
    // wording ("sets out the terms and conditions relating to") — confirm
    // that text was NOT what got captured.
    expect(reg25.excerpt).not.toContain('sets out the terms and conditions');
    const reg2 = parseSi639(EXCERPT)[1]!;
    expect(reg2.provisionText.startsWith('2. In these Regulations')).toBe(true);
    expect(reg2.provisionText).not.toContain('defines certain terms');
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const parsed = parseSi639(EXCERPT);
    for (const r of parsed) {
      expect(r.sourceStart).toBeGreaterThanOrEqual(0);
      expect(r.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
      expect(r.sourceEnd).toBeGreaterThan(r.sourceStart);
    }
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]!.sourceStart).toBeGreaterThanOrEqual(parsed[i - 1]!.sourceEnd);
    }
  });

  it('is idempotent across two parses', () => {
    expect(parseSi639(EXCERPT)).toEqual(parseSi639(EXCERPT));
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi156 } from './si156Parser';
import { readCatalogueEntry } from './catalogue';
import { SI_156_CATALOGUE_ENTRY } from './si156Ingestion';

/** Regs 1 and 2 under "## " headings, as the catalogue extraction lays them out: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/si-156-2012-excerpt.md', import.meta.url), 'utf8');
/** The regulations books hold, as the catalogue extraction parsed them from the page. */
const regs = readCatalogueEntry(SI_156_CATALOGUE_ENTRY).provisions;

describe('parseSi156', () => {
  it('holds the regulations books already hold: 1, 2 and 4 (#705)', () => {
    expect(regs.map((r) => r.sectionNumber)).toEqual(['1', '2', '4']);
    expect(parseSi156(EXCERPT).map((r) => r.regulationNumber)).toEqual(['1', '2']);
  });

  it('never emits a provision for a heading whose body is not a numbered regulation', () => {
    const placeholder = `${EXCERPT}\n## Exclusion, appeal, payment timing\n\n5–9. Summarised, not quoted.\n`;
    expect(parseSi156(placeholder).map((r) => r.regulationNumber)).toEqual(['1', '2']);
  });

  it('captures reg.4\'s full verbatim body, the mandatory e-filing/e-payment obligation', () => {
    const reg4 = regs.find((r) => r.sectionNumber === '4')!;
    expect(reg4.heading).toBe('Persons registered for VAT required to make returns and payments by electronic means');
    expect(reg4.excerpt.startsWith('4. (1) Where any specified person')).toBe(true);
    expect(reg4.excerpt).toContain('by electronic means');
    expect(reg4.excerpt).toContain('section 65 of the Value-Added Tax Consolidation Act 2010 (No. 31 of 2010)');
    expect(reg4.category).toBe('vat');
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const parsed = parseSi156(EXCERPT);
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
    expect(parseSi156(EXCERPT)).toEqual(parseSi156(EXCERPT));
  });
});

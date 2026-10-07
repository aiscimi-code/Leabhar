import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTca1997Section } from './tca1997SectionParser';
import { readCatalogueEntry } from './catalogue';
import { TCA_1997_S530_CATALOGUE_ENTRY } from './rctIngestion';

/** The opening of s.530 as its page converts, blank lines dropped: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/tca-1997-s530-excerpt.md', import.meta.url), 'utf8');
/** The whole section, as the catalogue extraction parsed it from the page. */
const s530 = readCatalogueEntry(TCA_1997_S530_CATALOGUE_ENTRY).provisions[0]!;

describe('parseTca1997Section', () => {
  it('parses the section number, chapter and heading', () => {
    const p = parseTca1997Section(EXCERPT);
    expect(p.sectionNumber).toBe('530');
    expect(p.chapter).toBe('CHAPTER 2: Payments to subcontractors in certain industries');
    expect(p.heading).toBe('Interpretation (Chapter 2).');
    expect([s530.chapter, s530.heading]).toEqual([p.chapter, p.heading]);
  });

  it('drops the leading amendment-history citation bracket from the heading', () => {
    const p = parseTca1997Section(EXCERPT);
    expect(p.heading).not.toContain('FA70');
    expect(p.heading).not.toContain('[');
  });

  it('captures the full body text to end of file, including the construction operations definition', () => {
    expect(s530.excerpt.startsWith('530.')).toBe(true);
    expect(s530.excerpt).toContain('“construction operations” means operations of any of the following descriptions');
    expect(s530.excerpt).toContain('the construction, alteration, repair, extension, demolition or dismantling of buildings or structures');
    expect(s530.excerpt).toContain('forestry operations');
    expect(s530.excerpt).toContain('meat processing operations');
    // The excerpt's opening is what the parser reads from the same lines.
    expect(s530.excerpt.startsWith(parseTca1997Section(EXCERPT).provisionText)).toBe(true);
  });

  it('records stable, in-bounds source offsets that recover the verbatim body from the raw file', () => {
    const p = parseTca1997Section(EXCERPT);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = EXCERPT.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('categorises via the shared statuteParser keyword rules (subsection (2)\'s own "corporation tax" mention wins over "Interpretation")', () => {
    // categoriseProvision checks corporation_tax before definitions in its
    // rule list; s.530(2)'s own text ("references... shall include
    // references to corporation tax") matches first. This reflects the
    // shared, source-independent categoriser's real behaviour, not a
    // TCA-specific special case.
    expect(s530.category).toBe('corporation_tax');
  });

  it('is idempotent across two parses', () => {
    expect(parseTca1997Section(EXCERPT)).toEqual(parseTca1997Section(EXCERPT));
  });
});

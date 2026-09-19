import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTca1997Section, parseTca1997SectionFile, TCA_1997_S530_MD_PATH } from './tca1997SectionParser';

describe('parseTca1997Section', () => {
  it('parses the section number, chapter and heading', () => {
    const p = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    expect(p.sectionNumber).toBe('530');
    expect(p.chapter).toBe('CHAPTER 2: Payments to subcontractors in certain industries');
    expect(p.heading).toBe('Interpretation (Chapter 2).');
  });

  it('drops the leading amendment-history citation bracket from the heading', () => {
    const p = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    expect(p.heading).not.toContain('FA70');
    expect(p.heading).not.toContain('[');
  });

  it('captures the full body text to end of file, including the construction operations definition', () => {
    const p = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    expect(p.provisionText.startsWith('530.')).toBe(true);
    expect(p.provisionText).toContain('“construction operations” means operations of any of the following descriptions');
    expect(p.provisionText).toContain('the construction, alteration, repair, extension, demolition or dismantling of buildings or structures');
    expect(p.provisionText).toContain('forestry operations');
    expect(p.provisionText).toContain('meat processing operations');
  });

  it('records stable, in-bounds source offsets that recover the verbatim body from the raw file', () => {
    const src = readFileSync(TCA_1997_S530_MD_PATH, 'utf8');
    const p = parseTca1997Section(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = src.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('categorises via the shared statuteParser keyword rules (subsection (2)\'s own "corporation tax" mention wins over "Interpretation")', () => {
    // categoriseProvision checks corporation_tax before definitions in its
    // rule list; s.530(2)'s own text ("references... shall include
    // references to corporation tax") matches first. This reflects the
    // shared, source-independent categoriser's real behaviour, not a
    // TCA-specific special case.
    const p = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    expect(p.category).toBe('corporation_tax');
  });

  it('is idempotent across two parses', () => {
    const a = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    const b = parseTca1997SectionFile(TCA_1997_S530_MD_PATH);
    expect(a).toEqual(b);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFinanceAct2024, provisionSlug, categoriseProvision } from './statuteParser';
import { readCatalogueEntry } from './catalogue';
import { FINANCE_ACT_2024_CATALOGUE_ENTRY } from './irishRules';

/** The Act's front matter and ss.1-4, as `pdftotext -layout` lays them out: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/finance-act-2024-excerpt.md', import.meta.url), 'utf8');
/** The whole Act, as the catalogue extraction parsed it from the PDF. */
const entry = readCatalogueEntry(FINANCE_ACT_2024_CATALOGUE_ENTRY);
const section = (n: string) => entry.provisions.find((p) => p.sectionNumber === n)!;

describe('statuteParser', () => {
  it('parses all 118 body sections in order, no invention', () => {
    expect(entry.provisions.map((p) => p.sectionNumber)).toEqual(
      Array.from({ length: 118 }, (_, i) => String(i + 1)),
    );
  });

  it('reads the excerpt as the catalogue entry reads the whole Act', () => {
    const provs = parseFinanceAct2024(EXCERPT);
    expect(provs.map((p) => p.sectionNumber)).toEqual(['1', '2', '3', '4']);
    // s.4 is the excerpt's last section; ss.1-3 run up to the next one, as in the whole Act.
    for (const p of provs.slice(0, 3)) {
      const e = section(p.sectionNumber);
      expect(p.provisionText).toBe(e.excerpt);
      expect(p.heading).toBe(e.heading);
      expect(p.amendsSection.join('; ') || null).toBe(e.amendsSection);
      expect(p.effectiveClue).toBe(e.effectiveClue);
      expect(p.citedActs).toEqual(e.citedActs);
    }
  });

  it('records stable source offsets within the file bounds', () => {
    const provs = parseFinanceAct2024(EXCERPT);
    for (const p of provs) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    }
  });

  it('preserves verbatim provision text with a recoverable offset slice', () => {
    const s3 = parseFinanceAct2024(EXCERPT).find((p) => p.sectionNumber === '3')!;
    const slice = EXCERPT.slice(s3.sourceStart, s3.sourceEnd).replace(/\f/g, ' ');
    const tokens = s3.provisionText.split(/\s+/).filter((t) => t.length > 4);
    const hits = tokens.filter((tok) => slice.includes(tok)).length;
    // 90%+ of long tokens traceable to the source slice — no invention.
    expect(hits / tokens.length).toBeGreaterThan(0.9);
  });

  it('extracts the heading line printed above the section number', () => {
    // The line directly above "1.    In this Part..." reads "Interpretation (Part 1)".
    expect(parseFinanceAct2024(EXCERPT)[0]!.heading).toBe('Interpretation (Part 1)');
  });

  it('joins a heading that wraps across two printed lines', () => {
    expect(section('15').heading).toBe(
      'Automatic enrolment retirement savings system (amendments consequential on '
      + 'insertion of Chapter 2E in Part 30)',
    );
  });

  it('finds the section-specific heading rather than a subsection opener', () => {
    const s2 = parseFinanceAct2024(EXCERPT).find((p) => p.sectionNumber === '2')!;
    // S.2's body begins "(1) Section 531AN..."; the heading is the line above it.
    expect(s2.heading).toBe('Amendment of section 531AN of Principal Act (rate of charge)');
  });

  it('parses amendment targets (amendsSection) from the text only', () => {
    const provs = parseFinanceAct2024(EXCERPT);
    expect(provs.find((p) => p.sectionNumber === '4')!.amendsSection.join(' | ')).toContain('472BB(3)');
    const s3 = provs.find((p) => p.sectionNumber === '3')!.amendsSection.join(' | ');
    expect(s3).toContain('section 15');
    expect(s3).toContain('section 461');
  });

  it('extracts effective-date clues only where present', () => {
    expect(parseFinanceAct2024(EXCERPT).find((p) => p.sectionNumber === '3')!.effectiveClue).toMatch(/year of assessment 2025/);
    expect(section('117').effectiveClue).toBeNull();
  });

  it('categorises by deterministic keyword match on heading/body', () => {
    const s2 = parseFinanceAct2024(EXCERPT).find((p) => p.sectionNumber === '2')!;
    expect(categoriseProvision(s2.heading, s2.provisionText)).toBe('usc');
  });

  it('produces a stable, unique slug per section', () => {
    const slugs = entry.provisions.map((p) => provisionSlug(p.sectionNumber, p.heading));
    expect(new Set(slugs).size).toBe(entry.provisions.length); // every slug distinct
    expect(slugs[0]).toMatch(/-s1$/);
  });

  it('the parser is idempotent across two reads', () => {
    expect(parseFinanceAct2024(EXCERPT)).toEqual(parseFinanceAct2024(EXCERPT));
  });
});

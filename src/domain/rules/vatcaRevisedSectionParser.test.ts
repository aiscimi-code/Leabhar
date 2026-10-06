import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseVatcaRevisedSection, parseVatcaRevisedSectionFile, vatcaRevisedSectionPath,
} from './vatcaRevisedSectionParser';
import { readCatalogueEntry } from './catalogue';
import { VATCA_REVISED_S046_CATALOGUE_ENTRY } from './vatcaRevisedIngestion';

const S047 = vatcaRevisedSectionPath('47');

describe('parseVatcaRevisedSection', () => {
  it('s.46 (rates), whose operative marker is "46\\n.—(1)", parsed into the rules catalogue (#443)', () => {
    // s.46 no longer has a statute copy: its parse is the catalogue excerpt,
    // written by scripts/catalogue/extract.ts with this parser.
    const [p] = readCatalogueEntry(VATCA_REVISED_S046_CATALOGUE_ENTRY).provisions;
    expect(p!.sectionNumber).toBe('46');
    expect(p!.heading).toBe('Rates of tax.');
    expect(p!.excerpt.startsWith('46')).toBe(true);
    expect(p!.excerpt).toContain('23 per');
    expect(p!.excerpt).toContain('13.5 per cent');
    expect(p!.excerpt).toContain('4.8 per cent');
    expect(p!.excerpt).not.toContain('Act as originally enacted');
    expect(p!.excerpt).not.toMatch(/^F\d+$/m);
  });

  it('parses s.2, whose predecessor-citation bracket spans two lines', () => {
    const p = parseVatcaRevisedSectionFile(vatcaRevisedSectionPath('2'));
    expect(p.sectionNumber).toBe('2');
    expect(p.heading).toBe('Interpretation — general.');
    expect(p.heading).not.toContain('VATA');
    expect(p.heading).not.toContain('[');
    expect(p.provisionText.startsWith('2')).toBe(true);
    expect(p.provisionText).toContain('“accountable person”');
  });

  it('parses s.91A, inserted after 2010 so it has no predecessor-citation bracket, ' +
     'and whose "." and "—" sit on their own separate lines', () => {
    const p = parseVatcaRevisedSectionFile(vatcaRevisedSectionPath('91A'));
    expect(p.sectionNumber).toBe('91A');
    expect(p.heading).toBe('Definitions');
    expect(p.provisionText.startsWith('91A')).toBe(true);
  });

  it('parses s.108A, whose bare section-number heading is printed twice before its own text', () => {
    const p = parseVatcaRevisedSectionFile(vatcaRevisedSectionPath('108A'));
    expect(p.sectionNumber).toBe('108A');
    expect(p.heading).toBe('Notice of requirement to furnish certain information, etc.');
    expect(p.provisionText.startsWith('108A')).toBe(true);
    expect(p.provisionText).toContain('The Revenue Commissioners may');
  });

  it('records stable, in-bounds source offsets that recover the verbatim body', () => {
    const src = readFileSync(S047, 'utf8');
    const p = parseVatcaRevisedSection(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = src.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('is idempotent across two parses', () => {
    const a = parseVatcaRevisedSectionFile(S047);
    const b = parseVatcaRevisedSectionFile(S047);
    expect(a).toEqual(b);
  });
});

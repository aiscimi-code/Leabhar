import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseVatcaRevisedSection, parseVatcaRevisedSectionFile, vatcaRevisedSectionPath,
  VATCA_REVISED_S046_MD_PATH,
} from './vatcaRevisedSectionParser';

describe('parseVatcaRevisedSection', () => {
  it('parses s.46 (rates), whose operative marker is "46\\n.—(1)"', () => {
    const p = parseVatcaRevisedSectionFile(VATCA_REVISED_S046_MD_PATH);
    expect(p.sectionNumber).toBe('46');
    expect(p.heading).toBe('Rates of tax.');
    expect(p.provisionText.startsWith('46')).toBe(true);
    expect(p.provisionText).toContain('23 per');
    expect(p.provisionText).toContain('13.5 per cent');
    expect(p.provisionText).toContain('4.8 per cent');
    expect(p.provisionText).not.toContain('Act as originally enacted');
    expect(p.provisionText).not.toMatch(/^F\d+$/m);
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
    const src = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
    const p = parseVatcaRevisedSection(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = src.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('is idempotent across two parses', () => {
    const a = parseVatcaRevisedSectionFile(VATCA_REVISED_S046_MD_PATH);
    const b = parseVatcaRevisedSectionFile(VATCA_REVISED_S046_MD_PATH);
    expect(a).toEqual(b);
  });
});

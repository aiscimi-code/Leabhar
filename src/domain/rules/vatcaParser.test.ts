import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVatca2010, parseVatca2010File, VATCA_2010_MD_PATH } from './vatcaParser';
import { VATCA_CURATED_RULES } from './vatcaCuration';

describe('vatcaParser', () => {
  it('parses every body section 1-125, skipping the table of contents and Schedules', () => {
    const provs = parseVatca2010File(VATCA_2010_MD_PATH);
    const numbers = new Set(provs.map((p) => p.sectionNumber));
    for (let n = 1; n <= 125; n++) expect(numbers.has(String(n))).toBe(true);
    // Nothing beyond "SCHEDULE" is parsed at all.
    expect(numbers.has('126')).toBe(false);
  });

  it('records stable, in-bounds source offsets', () => {
    const src = readFileSync(VATCA_2010_MD_PATH, 'utf8');
    const provs = parseVatca2010(src);
    for (const p of provs) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    }
  });

  it('preserves verbatim provision text with a recoverable offset slice', () => {
    const src = readFileSync(VATCA_2010_MD_PATH, 'utf8');
    const provs = parseVatca2010(src);
    const s34 = provs.find((p) => p.sectionNumber === '34')!;
    const slice = src.slice(s34.sourceStart, s34.sourceEnd);
    const tokens = s34.provisionText.split(/\s+/).filter((t) => t.length > 4);
    const hits = tokens.filter((t) => slice.includes(t)).length;
    expect(hits / tokens.length).toBeGreaterThan(0.9);
  });

  it('categorises VATCA provisions as vat when they say "value-added tax" even without the acronym', () => {
    const provs = parseVatca2010File(VATCA_2010_MD_PATH);
    const s3 = provs.find((p) => p.sectionNumber === '3')!;
    expect(s3.category).toBe('vat');
  });

  it('is idempotent across two parses', () => {
    const a = parseVatca2010File(VATCA_2010_MD_PATH);
    const b = parseVatca2010File(VATCA_2010_MD_PATH);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.sectionNumber).toBe(b[i]!.sectionNumber);
      expect(a[i]!.provisionText).toBe(b[i]!.provisionText);
    }
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of its provision\'s text', () => {
    const provs = parseVatca2010File(VATCA_2010_MD_PATH);
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of VATCA_CURATED_RULES) {
      const p = provs.find((x) => x.sectionNumber === rule.sectionNumber);
      expect(p, `provision for ${rule.ruleKey} (s.${rule.sectionNumber})`).toBeDefined();
      expect(
        norm(p!.provisionText),
        `${rule.ruleKey}: statementExcerpt must be verbatim`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });
});

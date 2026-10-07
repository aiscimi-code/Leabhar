import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVatcaSchedule, parseScheduleFrontMatter } from './vatcaScheduleParser';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { readCatalogueEntry } from './catalogue';
import { containsIgnoringLayout } from './lrcAnnotations';

/**
 * Schedules 1-3 are parsed into the rules catalogue (#556): the structure
 * tests read the parse the extraction committed; the parser's own mechanics
 * run on an excerpt of Schedule 2 as `lrc_html_to_text.py` converts it.
 */
const EXCERPT = readFileSync(new URL('./__fixtures__/vatca-schedule-2-excerpt.md', import.meta.url), 'utf8');
const paragraphs = (n: '1' | '2' | '3') => readCatalogueEntry(`vatca-2010-revised/schedule-${n}.json`).provisions;

describe('parseScheduleFrontMatter', () => {
  it('reads the LRC-revised front matter, distinct from the principal Act\'s own citation', () => {
    const fm = parseScheduleFrontMatter(EXCERPT);
    expect(fm.citation).toBe('2010 Act 31 Sch.2');
    expect(fm.sourceUrl).toContain('revisedacts.lawreform.ie');
    expect(fm.sourceHtmlSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseVatcaSchedule', () => {
  it('parses Schedule 2\'s 14 numbered paragraphs plus 9A, with no false positives from stray numbers', () => {
    const numbers = paragraphs('2').map((p) => p.sectionNumber);
    for (let n = 1; n <= 14; n++) expect(numbers).toContain(String(n));
    expect(numbers).toContain('9A');
    expect(numbers).toHaveLength(15);
  });

  it('parses Schedule 3\'s paragraphs, including lettered sub-paragraphs and the unnumbered 21', () => {
    const paras = paragraphs('3');
    const numbers = paras.map((p) => p.sectionNumber);
    expect(numbers).toContain('3A');
    expect(numbers).toContain('9B');
    expect(numbers).toContain('13B');
    // The LRC text prints para 21 (substituted, F481) without its number; it
    // opens after its heading and no longer runs into para 20 (issue #205).
    expect(numbers.slice(numbers.indexOf('20'), numbers.indexOf('20') + 3)).toEqual(['20', '21', '22']);
    const p20 = paras.find((p) => p.sectionNumber === '20')!;
    const p21 = paras.find((p) => p.sectionNumber === '21')!;
    expect(p20.excerpt).not.toContain('care of the human body');
    expect(p21.heading).toBe('Miscellaneous services.');
    expect(p21.excerpt).toMatch(/^\(1\) Services consisting of the care of the human body/);
    expect(p21.excerpt).toContain('by tour guides');
  });

  it('records the marginal-note heading for a sampled paragraph', () => {
    const paras = paragraphs('2');
    expect(paras.find((p) => p.sectionNumber === '1')!.heading).toBe('Intra-Community transactions.');
    expect(paras.find((p) => p.sectionNumber === '10')!.heading).toBe('Children’s clothing and footwear.');
    expect(parseVatcaSchedule(EXCERPT).map((p) => p.heading)).toEqual(['Intra-Community transactions.', 'Imports.', 'Food and drink.']);
  });

  it('tracks which Part a paragraph sits under', () => {
    const paras = paragraphs('2');
    expect(paras.find((p) => p.sectionNumber === '1')!.part).toBe('Part 1');
    expect(paras.find((p) => p.sectionNumber === '8')!.part).toBe('Part 2');
    expect(parseVatcaSchedule(EXCERPT).map((p) => [p.paragraphNumber, p.part])).toEqual([['1', 'Part 1'], ['2', 'Part 1'], ['8', 'Part 2']]);
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const paras = parseVatcaSchedule(EXCERPT);
    for (const p of paras) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
      expect(EXCERPT.slice(p.sourceStart, p.sourceEnd)).toBe(p.provisionText);
    }
    for (let i = 1; i < paras.length; i++) {
      expect(paras[i]!.sourceStart).toBeGreaterThanOrEqual(paras[i - 1]!.sourceEnd);
    }
  });

  it('preserves a mid-sentence blank line (an inline cross-reference link) inside one paragraph, not as a false boundary', () => {
    const p1 = parseVatcaSchedule(EXCERPT).find((p) => p.paragraphNumber === '1')!;
    // Subparagraph (5) sits inside paragraph 1's own text; a blank-line-based
    // splitter would have stranded "section 91G." as if it were paragraph 1's
    // sibling rather than its content.
    expect(p1.provisionText).toContain('section 91G');
    expect(p1.provisionText).toContain('(5) The supply of goods');
    expect(paragraphs('2').find((p) => p.sectionNumber === '1')!.excerpt).toBe(p1.provisionText);
  });

  it('is idempotent across two parses', () => {
    expect(parseVatcaSchedule(EXCERPT)).toEqual(parseVatcaSchedule(EXCERPT));
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of its paragraph\'s text', () => {
    for (const rule of VATCA_SCHEDULE_CURATED_RULES) {
      const p = paragraphs(rule.scheduleNumber as '2' | '3').find((x) => x.sectionNumber === rule.sectionNumber);
      expect(p, `paragraph for ${rule.ruleKey} (Sch.${rule.scheduleNumber} para.${rule.sectionNumber})`).toBeDefined();
      expect(containsIgnoringLayout(p!.excerpt, rule.statementExcerpt), `${rule.ruleKey}: statementExcerpt must be verbatim`).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseVatcaSchedule, parseVatcaScheduleFile, parseScheduleFrontMatter,
  VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH,
} from './vatcaScheduleParser';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';

describe('parseScheduleFrontMatter', () => {
  it('reads the LRC-revised front matter, distinct from the principal Act\'s own citation', () => {
    const src = readFileSync(VATCA_SCHEDULE_2_MD_PATH, 'utf8');
    const fm = parseScheduleFrontMatter(src);
    expect(fm.citation).toBe('2010 Act 31 Sch.2');
    expect(fm.sourceUrl).toContain('revisedacts.lawreform.ie');
    expect(fm.sourceHtmlSha256).toMatch(/^[0-9a-f]{64,65}$/);
  });
});

describe('parseVatcaSchedule', () => {
  it('parses Schedule 2\'s 14 numbered paragraphs plus 9A, with no false positives from stray numbers', () => {
    const paras = parseVatcaScheduleFile(VATCA_SCHEDULE_2_MD_PATH);
    const numbers = paras.map((p) => p.paragraphNumber);
    for (let n = 1; n <= 14; n++) expect(numbers).toContain(String(n));
    expect(numbers).toContain('9A');
    expect(numbers).toHaveLength(15);
  });

  it('parses Schedule 3\'s paragraphs, including lettered sub-paragraphs, skipping the repealed 21', () => {
    const paras = parseVatcaScheduleFile(VATCA_SCHEDULE_3_MD_PATH);
    const numbers = paras.map((p) => p.paragraphNumber);
    expect(numbers).toContain('3A');
    expect(numbers).toContain('9B');
    expect(numbers).toContain('13B');
    expect(numbers).not.toContain('21');
  });

  it('records the marginal-note heading for a sampled paragraph', () => {
    const paras = parseVatcaScheduleFile(VATCA_SCHEDULE_2_MD_PATH);
    const p1 = paras.find((p) => p.paragraphNumber === '1')!;
    expect(p1.heading).toBe('Intra-Community transactions.');
    const p10 = paras.find((p) => p.paragraphNumber === '10')!;
    expect(p10.heading).toBe('Children’s clothing and footwear.');
  });

  it('tracks which Part a paragraph sits under', () => {
    const paras = parseVatcaScheduleFile(VATCA_SCHEDULE_2_MD_PATH);
    expect(paras.find((p) => p.paragraphNumber === '1')!.part).toBe('Part 1');
    expect(paras.find((p) => p.paragraphNumber === '8')!.part).toBe('Part 2');
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const src = readFileSync(VATCA_SCHEDULE_3_MD_PATH, 'utf8');
    const paras = parseVatcaSchedule(src);
    for (const p of paras) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    }
    for (let i = 1; i < paras.length; i++) {
      expect(paras[i]!.sourceStart).toBeGreaterThanOrEqual(paras[i - 1]!.sourceEnd);
    }
  });

  it('preserves a mid-sentence blank line (an inline cross-reference link) inside one paragraph, not as a false boundary', () => {
    const paras = parseVatcaScheduleFile(VATCA_SCHEDULE_2_MD_PATH);
    const p1 = paras.find((p) => p.paragraphNumber === '1')!;
    // Subparagraph (5) sits inside paragraph 1's own text; a blank-line-based
    // splitter would have stranded "section 91G." as if it were paragraph 1's
    // sibling rather than its content.
    expect(p1.provisionText).toContain('section 91G');
    expect(p1.provisionText).toContain('(5) The supply of goods');
  });

  it('is idempotent across two parses', () => {
    const a = parseVatcaScheduleFile(VATCA_SCHEDULE_3_MD_PATH);
    const b = parseVatcaScheduleFile(VATCA_SCHEDULE_3_MD_PATH);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.paragraphNumber).toBe(b[i]!.paragraphNumber);
      expect(a[i]!.provisionText).toBe(b[i]!.provisionText);
    }
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of its paragraph\'s text', () => {
    const sch2 = parseVatcaScheduleFile(VATCA_SCHEDULE_2_MD_PATH);
    const sch3 = parseVatcaScheduleFile(VATCA_SCHEDULE_3_MD_PATH);
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of VATCA_SCHEDULE_CURATED_RULES) {
      const paras = rule.scheduleNumber === '2' ? sch2 : sch3;
      const p = paras.find((x) => x.paragraphNumber === rule.sectionNumber);
      expect(p, `paragraph for ${rule.ruleKey} (Sch.${rule.scheduleNumber} para.${rule.sectionNumber})`).toBeDefined();
      expect(
        norm(p!.provisionText),
        `${rule.ruleKey}: statementExcerpt must be verbatim`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });
});

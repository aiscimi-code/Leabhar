import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi692025Regulation, parseSi692025RegulationFile, SI_69_2025_MD_PATH } from './si692025Parser';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';

describe('parseSi692025Regulation', () => {
  it('extracts regulation 8\'s full verbatim body, both substituted s.80(1) paragraphs', () => {
    const reg8 = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '8');
    expect(reg8.provisionText.startsWith('8. Section 80(1) of the Act of 2010 is amended')).toBe(true);
    expect(reg8.provisionText).toContain('at least 90 per cent of the person’s annual turnover is derived from supplies to persons who are not registered persons');
    expect(reg8.provisionText).toContain('€2,000,000 in any continuous period of 12 months');
  });

  it('stops before the next top-level regulation, not the inserted 92B/92C/92D sections inside regulation 9', () => {
    const reg8 = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '8');
    expect(reg8.provisionText).not.toContain('Part 10 of the Act of 2010');
    expect(reg8.provisionText).not.toContain('92B');

    const reg9 = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '9');
    expect(reg9.provisionText.startsWith('9. Part 10 of the Act of 2010 is amended')).toBe(true);
    expect(reg9.provisionText).toContain('92B');
    expect(reg9.provisionText).toContain('92D');
    expect(reg9.provisionText).not.toContain('10. Schedule 9');
  });

  it('records stable, in-bounds source offsets that round-trip against the raw source', () => {
    const src = readFileSync(SI_69_2025_MD_PATH, 'utf8');
    const reg8 = parseSi692025Regulation(src, '8');
    expect(reg8.sourceStart).toBeGreaterThanOrEqual(0);
    expect(reg8.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(reg8.sourceEnd).toBeGreaterThan(reg8.sourceStart);
    expect(src.slice(reg8.sourceStart, reg8.sourceStart + 2)).toBe('8.');
  });

  it('is idempotent across two parses', () => {
    const a = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '8');
    const b = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '8');
    expect(a).toEqual(b);
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of regulation 8\'s text', () => {
    const reg8 = parseSi692025RegulationFile(SI_69_2025_MD_PATH, '8');
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of SI_69_2025_CURATED_RULES) {
      expect(
        norm(reg8.provisionText),
        `${rule.ruleKey}: statementExcerpt must be verbatim`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });
});

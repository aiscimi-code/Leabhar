import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi692025Regulation } from './si692025Parser';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';
import { readCatalogueEntry } from './catalogue';
import { SI_69_2025_CATALOGUE_ENTRY } from './si692025Ingestion';

/** Regs 7 and 8, the opening of reg 9 and reg 10's first line, as the page converts: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/si-69-2025-excerpt.md', import.meta.url), 'utf8');
/** The regulations books hold, as the catalogue extraction parsed them from the page. */
const regulation = (n: string) => readCatalogueEntry(SI_69_2025_CATALOGUE_ENTRY).provisions.find((p) => p.sectionNumber === n)!.excerpt;

describe('parseSi692025Regulation', () => {
  it('extracts regulation 8\'s full verbatim body, both substituted s.80(1) paragraphs', () => {
    const reg8 = parseSi692025Regulation(EXCERPT, '8').provisionText;
    expect(reg8).toBe(regulation('8'));
    expect(reg8.startsWith('8. Section 80(1) of the Act of 2010 is amended')).toBe(true);
    expect(reg8).toContain('at least 90 per cent of the person’s annual turnover is derived from supplies to persons who are not registered persons');
    expect(reg8).toContain('€2,000,000 in any continuous period of 12 months');
  });

  it('extracts regulation 7\'s full verbatim body (the s.60(4) deductibility restriction)', () => {
    const reg7 = parseSi692025Regulation(EXCERPT, '7').provisionText;
    expect(reg7).toBe(regulation('7'));
    expect(reg7.startsWith('7. Section 60 of the Act of 2010 is amended')).toBe(true);
    expect(reg7).toContain('shall not deduct any tax on expenditure incurred for the purpose of supplies made in accordance with Chapter 5 of Part 10');
    expect(reg7).not.toContain('Section 80(1)');
  });

  it('stops before the next top-level regulation, not the inserted 92B/92C/92D sections inside regulation 9', () => {
    const reg8 = regulation('8');
    expect(reg8).not.toContain('Part 10 of the Act of 2010');
    expect(reg8).not.toContain('92B');

    const reg9 = regulation('9');
    expect(reg9.startsWith('9. Part 10 of the Act of 2010 is amended')).toBe(true);
    expect(reg9).toContain('92B');
    expect(reg9).toContain('92D');
    expect(reg9).not.toContain('10. Schedule 9');
    expect(parseSi692025Regulation(EXCERPT, '9').provisionText).not.toContain('10. Schedule 9');
  });

  it('records stable, in-bounds source offsets that round-trip against the raw source', () => {
    const reg8 = parseSi692025Regulation(EXCERPT, '8');
    expect(reg8.sourceStart).toBeGreaterThanOrEqual(0);
    expect(reg8.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
    expect(reg8.sourceEnd).toBeGreaterThan(reg8.sourceStart);
    expect(EXCERPT.slice(reg8.sourceStart, reg8.sourceStart + 2)).toBe('8.');
  });

  it('is idempotent across two parses', () => {
    expect(parseSi692025Regulation(EXCERPT, '8')).toEqual(parseSi692025Regulation(EXCERPT, '8'));
  });

  it('every curated rule\'s statement excerpt is a verbatim substring of its own regulation\'s text', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of SI_69_2025_CURATED_RULES) {
      expect(
        norm(regulation(rule.regulationNumber)),
        `${rule.ruleKey}: statementExcerpt must be verbatim against regulation ${rule.regulationNumber}`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });
});

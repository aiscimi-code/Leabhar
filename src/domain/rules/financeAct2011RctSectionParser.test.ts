import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseFinanceAct2011RctSection, parseFinanceAct2011RctSectionFile, tca1997RctSectionMdPath,
} from './financeAct2011RctSectionParser';
import { RCT_CURATED_RULES } from './rctCuration';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUV'.split('');

describe('parseFinanceAct2011RctSection', () => {
  it('parses every one of the 22 inserted sections (530A-530V) without error', () => {
    for (const letter of LETTERS) {
      const p = parseFinanceAct2011RctSectionFile(tca1997RctSectionMdPath(`530${letter}`));
      expect(p.sectionNumber, letter).toBe(`530${letter}`);
      expect(p.provisionText.startsWith(`530${letter}.—`), letter).toBe(true);
    }
  });

  it('strips FA 2011 s.20\'s own opening quotation mark from s.530A\'s heading, but keeps the heading text', () => {
    const p = parseFinanceAct2011RctSectionFile(tca1997RctSectionMdPath('530A'));
    expect(p.heading).toBe('Principal to whom relevant contracts tax applies.');
  });

  it('captures s.530E\'s full body, all three rate paragraphs', () => {
    const p = parseFinanceAct2011RctSectionFile(tca1997RctSectionMdPath('530E'));
    expect(p.heading).toBe('Rates of tax.');
    expect(p.provisionText).toContain('shall be zero where the Revenue Commissioners have made a determination');
    expect(p.provisionText).toContain('shall be the standard rate (within the meaning of section 3)');
    expect(p.provisionText).toContain('shall be 35 per cent where the Revenue Commissioners have made a determination');
  });

  it('records stable, in-bounds source offsets that round-trip against the raw source', () => {
    const path = tca1997RctSectionMdPath('530I');
    const src = readFileSync(path, 'utf8');
    const p = parseFinanceAct2011RctSection(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    expect(src.slice(p.sourceStart, p.sourceStart + 5)).toBe('530I.');
  });

  it('is idempotent across two parses', () => {
    const path = tca1997RctSectionMdPath('530G');
    const a = parseFinanceAct2011RctSectionFile(path);
    const b = parseFinanceAct2011RctSectionFile(path);
    expect(a).toEqual(b);
  });

  it('every issue #131 curated rule\'s statement excerpt is a verbatim substring of its own section\'s text', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const fa2011Sources = new Set(['tca1997_s530a', 'tca1997_s530e', 'tca1997_s530g', 'tca1997_s530h', 'tca1997_s530i']);
    for (const rule of RCT_CURATED_RULES) {
      if (!fa2011Sources.has(rule.source)) continue;
      const text = norm(parseFinanceAct2011RctSectionFile(tca1997RctSectionMdPath(rule.sectionNumber)).provisionText);
      expect(text, `${rule.ruleKey}: statementExcerpt must be verbatim against s.${rule.sectionNumber}`)
        .toContain(norm(rule.statementExcerpt));
    }
  });
});

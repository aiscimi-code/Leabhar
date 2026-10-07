import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFinanceAct2011RctSection } from './financeAct2011RctSectionParser';
import { RCT_CURATED_RULES } from './rctCuration';
import { readCatalogueEntry } from './catalogue';
import { RCT_FA2011_SECTIONS, rctFa2011CatalogueEntry, type RctFa2011SectionKey } from './rctIngestion';

/** The opening of s.530A as cut from FA 2011 s.20's page: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/tca-1997-s530A-excerpt.md', import.meta.url), 'utf8');
/** The sections the knowledge base loads, as the catalogue extraction parsed them from the page. */
const LOADED = Object.keys(RCT_FA2011_SECTIONS) as RctFa2011SectionKey[];
const provision = (key: RctFa2011SectionKey) => readCatalogueEntry(rctFa2011CatalogueEntry(key)).provisions[0]!;
/** The inserted sections nothing loads yet, still kept as copies. */
const COPIES = 'BCDFJKLMNOPQRSTUV'.split('');
const copyPath = (letter: string) => new URL(`../../../docs/statutes/tca-1997/s530${letter}.md`, import.meta.url).pathname;

describe('parseFinanceAct2011RctSection', () => {
  it('parses every one of the 22 inserted sections (530A-530V) without error', () => {
    for (const letter of COPIES) {
      const p = parseFinanceAct2011RctSection(readFileSync(copyPath(letter), 'utf8'));
      expect(p.sectionNumber, letter).toBe(`530${letter}`);
      expect(p.provisionText.startsWith(`530${letter}.—`), letter).toBe(true);
    }
    for (const key of LOADED) {
      const p = provision(key);
      expect(p.sectionNumber, key).toBe(RCT_FA2011_SECTIONS[key].sectionNumber);
      expect(p.excerpt.startsWith(`${p.sectionNumber}.—`), key).toBe(true);
    }
  });

  it('strips FA 2011 s.20\'s own opening quotation mark from s.530A\'s heading, but keeps the heading text', () => {
    expect(parseFinanceAct2011RctSection(EXCERPT).heading).toBe('Principal to whom relevant contracts tax applies.');
    expect(provision('tca1997_s530a').heading).toBe('Principal to whom relevant contracts tax applies.');
  });

  it('captures s.530E\'s full body, all three rate paragraphs', () => {
    const p = provision('tca1997_s530e');
    expect(p.heading).toBe('Rates of tax.');
    expect(p.excerpt).toContain('shall be zero where the Revenue Commissioners have made a determination');
    expect(p.excerpt).toContain('shall be the standard rate (within the meaning of section 3)');
    expect(p.excerpt).toContain('shall be 35 per cent where the Revenue Commissioners have made a determination');
  });

  it('records stable, in-bounds source offsets that round-trip against the raw source', () => {
    const p = parseFinanceAct2011RctSection(EXCERPT);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    expect(EXCERPT.slice(p.sourceStart, p.sourceStart + 5)).toBe('530A.');
  });

  it('is idempotent across two parses', () => {
    expect(parseFinanceAct2011RctSection(EXCERPT)).toEqual(parseFinanceAct2011RctSection(EXCERPT));
  });

  it('every issue #131 curated rule\'s statement excerpt is a verbatim substring of its own section\'s text', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of RCT_CURATED_RULES) {
      if (!(rule.source in RCT_FA2011_SECTIONS)) continue;
      const text = norm(provision(rule.source as RctFa2011SectionKey).excerpt);
      expect(text, `${rule.ruleKey}: statementExcerpt must be verbatim against s.${rule.sectionNumber}`)
        .toContain(norm(rule.statementExcerpt));
    }
  });
});

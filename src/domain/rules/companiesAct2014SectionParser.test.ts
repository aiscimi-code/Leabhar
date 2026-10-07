import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCompaniesAct2014Section } from './companiesAct2014SectionParser';
import { readCatalogueEntry } from './catalogue';
import { companiesAct2014CatalogueEntry, type CompaniesAct2014SectionNumber } from './companiesAct2014Ingestion';

/** s.285 as converted from its LRC page, a whole section: the parser's mechanics. */
const S285 = readFileSync(new URL('./__fixtures__/companies-act-2014-s285.md', import.meta.url), 'utf8');
/** A section as the catalogue extraction parsed it from its page. */
const section = (n: CompaniesAct2014SectionNumber) => {
  const p = readCatalogueEntry(companiesAct2014CatalogueEntry(n)).provisions[0]!;
  return { sectionNumber: p.sectionNumber, heading: p.heading, provisionText: p.excerpt };
};

describe('parseCompaniesAct2014Section', () => {
  it('parses s.282 (accounting records), whose operative marker is a bare "282." line', () => {
    const p = section('282');
    expect(p.sectionNumber).toBe('282');
    expect(p.heading).toBe('Basic requirements for accounting records');
    expect(p.provisionText.startsWith('282.')).toBe(true);
    expect(p.provisionText).toContain('adequate accounting records');
    expect(p.provisionText).not.toContain('Act as originally enacted');
  });

  it('parses s.280A (small company), a lettered section number', () => {
    const p = section('280A');
    expect(p.sectionNumber).toBe('280A');
    expect(p.heading).toBe('Qualification of company as small company: general');
    expect(p.provisionText.startsWith('280A.')).toBe(true);
    expect(p.provisionText).toContain('€15 million');
    expect(p.provisionText).toContain('€7.5 million');
    expect(p.provisionText).toContain('does not exceed 50');
  });

  it('parses s.280D (micro company)', () => {
    const p = section('280D');
    expect(p.sectionNumber).toBe('280D');
    expect(p.heading).toBe('Qualification of company as micro company');
    expect(p.provisionText).toContain('€900,000');
    expect(p.provisionText).toContain('€450,000');
    expect(p.provisionText).toContain('does not exceed 10');
  });

  it('parses s.281, a one-sentence duty with no numbered subsections', () => {
    const p = section('281');
    expect(p.sectionNumber).toBe('281');
    expect(p.heading).toBe('Obligation to keep adequate accounting records');
    expect(p.provisionText.startsWith('281.')).toBe(true);
    expect(p.provisionText).toContain('adequate accounting records');
  });

  it('parses s.343 and keeps the substituted 56-day period', () => {
    const p = section('343');
    expect(p.sectionNumber).toBe('343');
    expect(p.heading).toBe('Obligation to make annual return');
    expect(p.provisionText).toContain('56 days');
    expect(p.provisionText).toContain('annual return date');
  });

  it('parses s.280E, the shortest section (no subsections at all)', () => {
    const p = section('280E');
    expect(p.sectionNumber).toBe('280E');
    expect(p.heading).toBe('Micro companies regime');
    expect(p.provisionText.startsWith('280E.')).toBe(true);
    expect(p.provisionText).toContain('micro companies regime');
  });

  it('parses s.359, whose subsections (3)-(12) are genuine LRC deletions rendered as "…"', () => {
    const p = section('359');
    expect(p.sectionNumber).toBe('359');
    expect(p.provisionText).toContain('group company');
    expect(p.provisionText).toContain('…');
    expect(p.provisionText).toContain('Chapter 16');
  });

  it('parses a converted page: s.285, its heading and its body', () => {
    const p = parseCompaniesAct2014Section(S285);
    expect(p.sectionNumber).toBe('285');
    expect(p.provisionText.startsWith('285.')).toBe(true);
    expect(p).toMatchObject(section('285'));
  });

  it('records stable, in-bounds source offsets that recover the verbatim body', () => {
    const src = S285;
    const p = parseCompaniesAct2014Section(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = src.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('is idempotent across two parses', () => {
    const a = parseCompaniesAct2014Section(S285);
    const b = parseCompaniesAct2014Section(S285);
    expect(a).toEqual(b);
  });
});

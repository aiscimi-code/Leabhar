import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseCompaniesAct2014Section, parseCompaniesAct2014SectionFile, companiesAct2014SectionPath,
} from './companiesAct2014SectionParser';

describe('parseCompaniesAct2014Section', () => {
  it('parses s.282 (accounting records), whose operative marker is a bare "282." line', () => {
    const p = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('282'));
    expect(p.sectionNumber).toBe('282');
    expect(p.heading).toBe('Basic requirements for accounting records');
    expect(p.provisionText.startsWith('282.')).toBe(true);
    expect(p.provisionText).toContain('adequate accounting records');
    expect(p.provisionText).not.toContain('Act as originally enacted');
  });

  it('parses s.280A (small company), a lettered section number', () => {
    const p = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('280A'));
    expect(p.sectionNumber).toBe('280A');
    expect(p.heading).toBe('Qualification of company as small company: general');
    expect(p.provisionText.startsWith('280A.')).toBe(true);
    expect(p.provisionText).toContain('€15 million');
    expect(p.provisionText).toContain('€7.5 million');
    expect(p.provisionText).toContain('does not exceed 50');
  });

  it('parses s.280D (micro company)', () => {
    const p = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('280D'));
    expect(p.sectionNumber).toBe('280D');
    expect(p.heading).toBe('Qualification of company as micro company');
    expect(p.provisionText).toContain('€900,000');
    expect(p.provisionText).toContain('€450,000');
    expect(p.provisionText).toContain('does not exceed 10');
  });

  it('parses s.280E, the shortest section (no subsections at all)', () => {
    const p = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('280E'));
    expect(p.sectionNumber).toBe('280E');
    expect(p.heading).toBe('Micro companies regime');
    expect(p.provisionText.startsWith('280E.')).toBe(true);
    expect(p.provisionText).toContain('micro companies regime');
  });

  it('parses s.359, whose subsections (3)-(12) are genuine LRC deletions rendered as "…"', () => {
    const p = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('359'));
    expect(p.sectionNumber).toBe('359');
    expect(p.provisionText).toContain('group company');
    expect(p.provisionText).toContain('…');
    expect(p.provisionText).toContain('Chapter 16');
  });

  it('records stable, in-bounds source offsets that recover the verbatim body', () => {
    const path = companiesAct2014SectionPath('352');
    const src = readFileSync(path, 'utf8');
    const p = parseCompaniesAct2014Section(src);
    expect(p.sourceStart).toBeGreaterThanOrEqual(0);
    expect(p.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    const slice = src.slice(p.sourceStart, p.sourceEnd);
    expect(slice.replace(/\s+/g, ' ').trim()).toBe(p.provisionText.replace(/\s+/g, ' ').trim());
  });

  it('is idempotent across two parses', () => {
    const a = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('360'));
    const b = parseCompaniesAct2014SectionFile(companiesAct2014SectionPath('360'));
    expect(a).toEqual(b);
  });
});

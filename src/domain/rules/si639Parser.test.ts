import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi639, parseSi639File, SI_639_2010_MD_PATH } from './si639Parser';

describe('parseSi639', () => {
  it('parses exactly regulations 1-47, excluding the table of contents and Explanatory Note', () => {
    const regs = parseSi639File(SI_639_2010_MD_PATH);
    const numbers = regs.map((r) => r.regulationNumber);
    for (let n = 1; n <= 47; n++) expect(numbers).toContain(String(n));
    expect(numbers).toHaveLength(47);
  });

  it('records the marginal heading for a sampled regulation', () => {
    const regs = parseSi639File(SI_639_2010_MD_PATH);
    const reg25 = regs.find((r) => r.regulationNumber === '25')!;
    expect(reg25.heading).toBe('Determination of tax due by reference to moneys received');
    const reg1 = regs.find((r) => r.regulationNumber === '1')!;
    expect(reg1.heading).toBe('Citation and commencement');
  });

  it('captures the full verbatim body of a regulation, not the TOC entry or Explanatory Note summary', () => {
    const regs = parseSi639File(SI_639_2010_MD_PATH);
    const reg25 = regs.find((r) => r.regulationNumber === '25')!;
    expect(reg25.provisionText.startsWith('25. (1) In this Regulation')).toBe(true);
    expect(reg25.provisionText).toContain('moneys received basis of accounting');
    // The Explanatory Note's own summary of regulation 25 uses different
    // wording ("sets out the terms and conditions relating to") — confirm
    // that text was NOT what got captured.
    expect(reg25.provisionText).not.toContain('sets out the terms and conditions');
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const src = readFileSync(SI_639_2010_MD_PATH, 'utf8');
    const regs = parseSi639(src);
    for (const r of regs) {
      expect(r.sourceStart).toBeGreaterThanOrEqual(0);
      expect(r.sourceEnd).toBeLessThanOrEqual(src.length);
      expect(r.sourceEnd).toBeGreaterThan(r.sourceStart);
    }
    for (let i = 1; i < regs.length; i++) {
      expect(regs[i]!.sourceStart).toBeGreaterThanOrEqual(regs[i - 1]!.sourceEnd);
    }
  });

  it('is idempotent across two parses', () => {
    const a = parseSi639File(SI_639_2010_MD_PATH);
    const b = parseSi639File(SI_639_2010_MD_PATH);
    expect(a).toEqual(b);
  });
});

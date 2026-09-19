import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSi156, parseSi156File, SI_156_2012_MD_PATH } from './si156Parser';

describe('parseSi156', () => {
  it('extracts only the regulations genuinely quoted verbatim in this file: 1, 2 and 4', () => {
    const regs = parseSi156File(SI_156_2012_MD_PATH);
    expect(regs.map((r) => r.regulationNumber)).toEqual(['1', '2', '4']);
  });

  it('never emits a provision for the "5-9" editorial placeholder section', () => {
    const regs = parseSi156File(SI_156_2012_MD_PATH);
    expect(regs.some((r) => r.provisionText.includes('as in the official instrument'))).toBe(false);
  });

  it('captures reg.4\'s full verbatim body, the mandatory e-filing/e-payment obligation', () => {
    const regs = parseSi156File(SI_156_2012_MD_PATH);
    const reg4 = regs.find((r) => r.regulationNumber === '4')!;
    expect(reg4.heading).toBe('Persons registered for VAT required to make returns and payments by electronic means');
    expect(reg4.provisionText.startsWith('4. (1) Where any specified person')).toBe(true);
    expect(reg4.provisionText).toContain('by electronic means');
    expect(reg4.category).toBe('vat');
  });

  it('records stable, in-bounds, non-overlapping source offsets', () => {
    const src = readFileSync(SI_156_2012_MD_PATH, 'utf8');
    const regs = parseSi156(src);
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
    const a = parseSi156File(SI_156_2012_MD_PATH);
    const b = parseSi156File(SI_156_2012_MD_PATH);
    expect(a).toEqual(b);
  });
});

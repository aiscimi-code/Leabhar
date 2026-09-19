import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractCapacityExclusionSection, extractCapacityExclusionSectionFile, TDM_38_01_03B_MD_PATH } from './tdm3801_03bParser';

describe('extractCapacityExclusionSection', () => {
  it('finds all four repeats of the section and confirms they are byte-identical', () => {
    const r = extractCapacityExclusionSectionFile(TDM_38_01_03B_MD_PATH);
    expect(r.occurrences).toBe(4);
  });

  it('captures the verbatim application procedure and the "capacity" definition', () => {
    const r = extractCapacityExclusionSectionFile(TDM_38_01_03B_MD_PATH);
    expect(r.heading).toBe('Exclusion from Mandatory Electronic Filing and Payment of Tax');
    expect(r.provisionText).toContain('you can apply in writing stating your');
    expect(r.provisionText).toContain('Capacity means sufficient access to the Internet');
    expect(r.provisionText).toContain('not prevented by reason of age, or mental or physical infirmity');
  });

  it('throws rather than silently picking one version if repeats ever diverge', () => {
    const source = 'Exclusion from Mandatory Electronic Filing and Payment of Tax\nVersion A text.\nof this notification.\n\n'
      + 'Exclusion from Mandatory Electronic Filing and Payment of Tax\nVersion B text.\nof this notification.';
    expect(() => extractCapacityExclusionSection(source)).toThrow(/textually different versions/);
  });

  it('records stable, in-bounds source offsets', () => {
    const src = readFileSync(TDM_38_01_03B_MD_PATH, 'utf8');
    const r = extractCapacityExclusionSection(src);
    expect(r.sourceStart).toBeGreaterThanOrEqual(0);
    expect(r.sourceEnd).toBeLessThanOrEqual(src.length);
    expect(r.sourceEnd).toBeGreaterThan(r.sourceStart);
    expect(src.slice(r.sourceStart, r.sourceStart + 10)).toBe('Exclusion ');
  });

  it('is idempotent across two parses', () => {
    const a = extractCapacityExclusionSectionFile(TDM_38_01_03B_MD_PATH);
    const b = extractCapacityExclusionSectionFile(TDM_38_01_03B_MD_PATH);
    expect(a).toEqual(b);
  });
});

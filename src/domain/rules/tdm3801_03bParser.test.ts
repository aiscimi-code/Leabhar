import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractCapacityExclusionSection } from './tdm3801_03bParser';
import { readCatalogueEntry } from './catalogue';
import { TDM_38_01_03B_CATALOGUE_ENTRY } from './tdm3801_03bIngestion';

/** The four pages of the manual that carry the passage: the parser's mechanics. */
const EXCERPT = readFileSync(new URL('./__fixtures__/tdm-38-01-03b-excerpt.md', import.meta.url), 'utf8');
/** The passage as the catalogue extraction parsed it from Revenue's PDF. */
const provision = () => readCatalogueEntry(TDM_38_01_03B_CATALOGUE_ENTRY).provisions[0]!;

describe('extractCapacityExclusionSection', () => {
  it('finds all four repeats of the section and confirms they are byte-identical', () => {
    expect(extractCapacityExclusionSection(EXCERPT).occurrences).toBe(4);
  });

  it('captures the verbatim application procedure and the "capacity" definition', () => {
    const p = provision();
    expect(p.heading).toBe('Exclusion from Mandatory Electronic Filing and Payment of Tax');
    expect(p.excerpt).toContain('you can apply in writing stating your');
    expect(p.excerpt).toContain('Capacity means sufficient access to the Internet');
    expect(p.excerpt).toContain('not prevented by reason of age, or mental or physical infirmity');
    expect(extractCapacityExclusionSection(EXCERPT).provisionText).toBe(p.excerpt);
  });

  it('throws rather than silently picking one version if repeats ever diverge', () => {
    const source = 'Exclusion from Mandatory Electronic Filing and Payment of Tax\nVersion A text.\nof this notification.\n\n'
      + 'Exclusion from Mandatory Electronic Filing and Payment of Tax\nVersion B text.\nof this notification.';
    expect(() => extractCapacityExclusionSection(source)).toThrow(/textually different versions/);
  });

  it('records stable, in-bounds source offsets', () => {
    const r = extractCapacityExclusionSection(EXCERPT);
    expect(r.sourceStart).toBeGreaterThanOrEqual(0);
    expect(r.sourceEnd).toBeLessThanOrEqual(EXCERPT.length);
    expect(r.sourceEnd).toBeGreaterThan(r.sourceStart);
    expect(EXCERPT.slice(r.sourceStart, r.sourceStart + 10)).toBe('Exclusion ');
  });

  it('is idempotent across two parses', () => {
    expect(extractCapacityExclusionSection(EXCERPT)).toEqual(extractCapacityExclusionSection(EXCERPT));
  });
});

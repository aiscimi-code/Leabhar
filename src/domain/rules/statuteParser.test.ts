import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFinanceAct2024, parseFinanceAct2024File, provisionSlug, categoriseProvision } from './statuteParser';

const SRC = '/home/box/HermesWorkspace/temp/Laebhar/docs/statutes/2024-act-43/2024-act-43-enacted.md'
  .replace('Leabhar', 'Leabhar');
// (kept as a const so path is obvious; the repo lives under HermesWorkspace/temp/Leabhar)
const REAL_SRC = '/home/box/HermesWorkspace/temp/Leabhar/docs/statutes/2024-act-43/2024-act-43-enacted.md';

describe('statuteParser', () => {
  it('parses all 118 body sections in order, no invention', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    expect(provs).toHaveLength(118);
    expect(provs.map((p) => p.sectionNumber)).toEqual(
      Array.from({ length: 118 }, (_, i) => String(i + 1)),
    );
  });

  it('records stable source offsets within the file bounds', () => {
    const src = readFileSync(REAL_SRC, 'utf8');
    const provs = parseFinanceAct2024(src);
    const totalLen = src.length;
    for (const p of provs) {
      expect(p.sourceStart).toBeGreaterThanOrEqual(0);
      expect(p.sourceEnd).toBeLessThanOrEqual(totalLen);
      expect(p.sourceEnd).toBeGreaterThan(p.sourceStart);
    }
  });

  it('preserves verbatim provision text with a recoverable offset slice', () => {
    const src = readFileSync(REAL_SRC, 'utf8');
    const provs = parseFinanceAct2024(src);
    const s3 = provs.find((p) => p.sectionNumber === '3')!;
    const slice = src.slice(s3.sourceStart, s3.sourceEnd).replace(/\f/g, ' ');
    const body = s3.provisionText;
    const tokens = body.split(/\s+/).filter((t) => t.length > 4);
    let hits = 0;
    for (const tok of tokens) {
      if (slice.includes(tok)) hits++;
    }
    // 90%+ of long tokens traceable to the source slice — no invention.
    expect(hits / tokens.length).toBeGreaterThan(0.9);
  });

  it('extracts a heading for sections with a short title', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const s1 = provs.find((p) => p.sectionNumber === '1')!;
    expect(s1.heading).toContain('Principal Act');
    expect(s1.heading).toContain('Taxes Consolidation Act 1997');
  });

  it('leaves heading empty when a section opens straight into a subsection', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const s2 = provs.find((p) => p.sectionNumber === '2')!;
    // S.2 body begins "(1) Section 531AN..." — no short title on the number line.
    expect(s2.heading).not.toContain('Section 531AN');
  });

  it('parses amendment targets (amendsSection) from the text only', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const s4 = provs.find((p) => p.sectionNumber === '4')!;
    expect(s4.amendsSection.join(' | ')).toContain('472BB(3)');
    const s3 = provs.find((p) => p.sectionNumber === '3')!;
    expect(s3.amendsSection.join(' | ')).toContain('section 15');
    expect(s3.amendsSection.join(' | ')).toContain('section 461');
  });

  it('extracts effective-date clues only where present', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const s3 = provs.find((p) => p.sectionNumber === '3')!;
    expect(s3.effectiveClue).toMatch(/year of assessment 2025/);
    const s117 = provs.find((p) => p.sectionNumber === '117')!;
    expect(s117.effectiveClue).toBeNull();
  });

  it('categorises by deterministic keyword match on heading/body', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const s2 = provs.find((p) => p.sectionNumber === '2')!;
    expect(categoriseProvision(s2.heading, s2.provisionText)).toBe('usc');
  });

  it('produces a stable, unique slug per section', () => {
    const provs = parseFinanceAct2024File(REAL_SRC);
    const slugs = provs.map((p) => provisionSlug(p.sectionNumber, p.heading));
    const uniq = new Set(slugs);
    expect(uniq.size).toBe(provs.length); // every slug distinct
    expect(slugs[0]).toMatch(/-s1$/);
  });

  it('the parser is idempotent across two reads', () => {
    const a = parseFinanceAct2024File(REAL_SRC);
    const b = parseFinanceAct2024File(REAL_SRC);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].sectionNumber).toBe(b[i].sectionNumber);
      expect(a[i].heading).toBe(b[i].heading);
      expect(a[i].amendsSection).toEqual(b[i].amendsSection);
      expect(a[i].effectiveClue).toBe(b[i].effectiveClue);
    }
  });
});

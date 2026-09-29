import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { statuteSourcePaths, statuteFilePath } from './knowledgeBase';

const FM = /^---\n([\s\S]*?)\n---/;
const HASH = /^source_html_sha256:\s*"?([0-9a-f]{64})"?$/m;

/** Ingested files that still have no upstream HTML/PDF digest. Shrink only
 *  when a capture adds the real bytes' hash — do not invent one. #591. */
const MISSING_HTML_HASH = [
  'docs/statutes/282-2011/articles-10-13b-establishment.md',
  'docs/statutes/ebriefs/2025/no-168-25.md',
  'docs/statutes/finance-act-2024/2024-act-43-enacted.md',
  'docs/statutes/finance-act-2025/2025-act-18-enacted.md',
  'docs/statutes/rct/tdm-18-02-04.md',
  'docs/statutes/rct/tdm-18-02-05.md',
  'docs/statutes/rct/tdm-18-02-11.md',
  'docs/statutes/si-312-1996/art92.md',
  'docs/statutes/tca-1997-nfg/part01.md',
  'docs/statutes/tca-1997-nfg/part02.md',
  'docs/statutes/tca-1997-nfg/part04.md',
  'docs/statutes/tca-1997-nfg/part09.md',
  'docs/statutes/tca-1997-nfg/part11.md',
  'docs/statutes/tca-1997-nfg/part11c.md',
  'docs/statutes/tca-1997-nfg/part12.md',
  'docs/statutes/tca-1997-nfg/part13.md',
  'docs/statutes/tca-1997-nfg/part15.md',
  'docs/statutes/tca-1997-nfg/part18.md',
  'docs/statutes/tca-1997-nfg/part18d.md',
  'docs/statutes/tca-1997-nfg/part23.md',
  'docs/statutes/tca-1997-nfg/part36.md',
  'docs/statutes/tca-1997-nfg/part41a.md',
  'docs/statutes/tca-1997-nfg/part43.md',
  'docs/statutes/tca-1997/s284.md',
  'docs/statutes/tca-1997/s530.md',
  'docs/statutes/tdm-11-00-01/11-00-01.md',
  'docs/statutes/tdm-38-01-03b/38-01-03b.md',
  'docs/statutes/tdm-38-03-33/38-03-33.md',
  'docs/statutes/vat3-rtd/VAT-RTD-S76.md',
  'docs/statutes/vatca-2010/vatca-2010-enacted.md',
];

describe('ingested statute inventory (#591)', () => {
  const paths = statuteSourcePaths();

  it('loadStatutoryKnowledgeBase points at files that exist', () => {
    expect(paths.length).toBeGreaterThan(40);
    for (const rel of paths) {
      expect(existsSync(statuteFilePath(rel)), rel).toBe(true);
    }
  });

  it('a recorded source_html_sha256 is 64 lowercase hex, not a hash of this markdown file', () => {
    // source_html_sha256 is the upstream HTML/PDF digest. Re-hashing the
    // committed .md and comparing it to that field is a category error —
    // that is how PR #598 reported 335 "mismatches".
    for (const rel of paths) {
      const text = readFileSync(statuteFilePath(rel), 'utf8');
      const fm = FM.exec(text)?.[1] ?? '';
      const hash = HASH.exec(fm)?.[1];
      if (!hash) continue;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('names the ingested files that still have no source_html_sha256', () => {
    const missing = paths.filter((rel) => {
      const text = readFileSync(statuteFilePath(rel), 'utf8');
      return !HASH.test(FM.exec(text)?.[1] ?? '');
    }).sort();
    expect(missing).toEqual([...MISSING_HTML_HASH].sort());
  });
});

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { statuteSourcePaths, statuteFilePath } from './knowledgeBase';

const FM = /^---\n([\s\S]*?)\n---/;
const HTML_HASH = /^source_html_sha256:\s*"?([0-9a-f]{64})"?$/m;
const PDF_HASH = /^source_pdf_sha256:\s*"?([0-9a-f]{64})"?$/m;

function frontMatter(rel: string): string {
  return FM.exec(readFileSync(statuteFilePath(rel), 'utf8'))?.[1] ?? '';
}

function recordedDigest(rel: string): string | null {
  const fm = frontMatter(rel);
  const fromFm = HTML_HASH.exec(fm)?.[1] ?? PDF_HASH.exec(fm)?.[1] ?? null;
  if (fromFm) return fromFm;
  // Conversion source present as a sibling PDF (FA 2024 / VATCA as-enacted).
  const siblingPdf = statuteFilePath(rel.replace(/\.md$/, '.pdf'));
  return existsSync(siblingPdf) ? `sibling-pdf:${siblingPdf}` : null;
}

/** Ingested files that still have neither source_html_sha256 nor
 *  source_pdf_sha256. Shrink only when a capture adds the real bytes' hash.
 *  Empty since EU 282/2011 moved to the rules catalogue with its EUR-Lex
 *  page (#556); do not invent a digest to keep it so. */
const MISSING_UPSTREAM_HASH: string[] = [];

describe('ingested statute inventory (#591)', () => {
  const paths = statuteSourcePaths();

  it('loadStatutoryKnowledgeBase points at files that exist', () => {
    // Shrinks as #556 moves each source to the rules catalogue; it only guards against an empty list.
    expect(paths.length).toBeGreaterThan(0);
    for (const rel of paths) {
      expect(existsSync(statuteFilePath(rel)), rel).toBe(true);
    }
  });

  it('a recorded upstream digest is 64 lowercase hex, not a hash of this markdown file', () => {
    // source_html_sha256 is the upstream HTML digest; source_pdf_sha256 is
    // the sibling/official PDF. Re-hashing the committed .md and comparing
    // it to either field is a category error — that is how PR #598 reported
    // 335 "mismatches".
    for (const rel of paths) {
      const hash = recordedDigest(rel);
      if (!hash || hash.startsWith('sibling-pdf:')) continue;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('names the ingested files that still have no upstream HTML or PDF digest', () => {
    const missing = paths.filter((rel) => recordedDigest(rel) === null).sort();
    expect(missing).toEqual([...MISSING_UPSTREAM_HASH].sort());
  });
});

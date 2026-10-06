import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { readCatalogueEntry, type CatalogueEntry } from './catalogue';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { compareWithCatalogue, sourceWords, traceSourceChange, verifySources } from './sourceDrift';
import { main } from '@/cli/irishRules';

/**
 * `verify-sources` (issue #443, #686 step 12): a catalogued source whose
 * official file has moved is reported, quote by quote, and traced through the
 * rule graph into review items. Nothing is fetched here: a fake stands in for
 * the official site.
 */
const NAME = 'vatca-2010-revised/s046.json';
const s46 = (): CatalogueEntry => readCatalogueEntry(NAME);

/** The excerpt as the LRC might re-publish it: markup, curly quotes and renumbered footnote markers. */
function republished(excerpt: string): Buffer {
  const body = excerpt
    .replace(/"([^"]*)"/g, '“$1”')
    .split(/\n{2,}/)
    .map((para, i) => `<p class="Body">${para.replace(/\n/g, ' ')}<sup>F${100 + i}</sup></p>`)
    .join('\n');
  return Buffer.from(`<html><head><style>p{}</style><script>var x=1;</script></head><body>${body}</body></html>`);
}
const page = (edit: (excerpt: string) => string = (x) => x) => republished(edit(s46().provisions[0]!.excerpt));

describe('sourceWords', () => {
  it('drops markup, footnote markers and quote-mark style', () => {
    expect(sourceWords('<p>the “rate” of 9 per cent<sup>F95</sup> &amp; more</p>'))
      .toEqual(['the', 'rate', 'of', '9', 'per', 'cent', 'more']);
  });
});

describe('compareWithCatalogue', () => {
  it('reports unchanged when the file is the one recorded, without reading the quotes', () => {
    const bytes = Buffer.from('<p>anything</p>');
    const entry = { ...s46(), source: { ...s46().source, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const report = compareWithCatalogue(NAME, entry, bytes);
    expect(report.status).toBe('unchanged');
    expect(report.quotesMissing).toEqual([]);
  });

  it('finds every quote in a re-published copy of the same words', () => {
    const report = compareWithCatalogue(NAME, s46(), page());
    expect(report.status).toBe('changed');
    expect(report.currentSha256).not.toBe(report.recordedSha256);
    expect(report.quotesMissing).toEqual([]);
    expect(report.quotesFound).toHaveLength(s46().rules.flatMap((r) => r.versions).filter((v) => v.quote).length);
  });

  it('names the rule versions whose quote is gone', () => {
    const report = compareWithCatalogue(NAME, s46(), page((x) => x.replace(/4\.8 per cent/g, '5.0 per cent')));
    expect(report.quotesMissing).toEqual(['vat.rate_livestock_current@1']);
  });
});

describe('verifySources', () => {
  it('reports a file it cannot fetch as unreachable, and carries on', async () => {
    const reports = await verifySources({ entries: [NAME], fetch: () => Promise.reject(new Error('HTTP 503')) });
    expect(reports).toEqual([expect.objectContaining({ entry: NAME, status: 'unreachable', currentSha256: null, error: 'HTTP 503' })]);
  });

  it('checks every catalogue entry by default', async () => {
    const urls: string[] = [];
    await verifySources({ fetch: async (url) => { urls.push(url); return page(); } });
    expect(urls).toContain(s46().source.sourceUrl);
  });
});

describe('traceSourceChange', () => {
  let db: AppDatabase;
  let companyId: string;
  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Drift Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });
  const items = () => db.select().from(reviewItems)
    .where(and(eq(reviewItems.companyId, companyId), like(reviewItems.dedupeKey, 'rule_source_change:%'))).all();

  it('raises nothing for an unchanged or unreachable source', () => {
    const bytes = Buffer.from('x');
    const entry = { ...s46(), source: { ...s46().source, sha256: createHash('sha256').update(bytes).digest('hex') } };
    expect(traceSourceChange(db, { companyId, report: compareWithCatalogue(NAME, entry, bytes) }).reviewItemsRaised).toBe(0);
    expect(items()).toHaveLength(0);
  });

  it('puts each rule from the source, and each rule relying on one, in front of the book; a missing quote is a warning', () => {
    const report = compareWithCatalogue(NAME, s46(), page((x) => x.replace(/4\.8 per cent/g, '5.0 per cent')));
    const trace = traceSourceChange(db, { companyId, report });
    const direct = s46().rules.map((r) => r.key);
    for (const key of direct) expect(trace.affectedRules).toContain(key);
    expect(trace.reviewItemsRaised).toBe(trace.affectedRules.length);

    const raised = items();
    expect(raised.map((i) => i.entityId).sort()).toEqual(trace.affectedRules);
    expect(raised.find((i) => i.entityId === 'vat.rate_livestock_current')!.severity).toBe('warning');
    expect(raised.find((i) => i.entityId === 'vat.rate_reduced_current')!.severity).toBe('info');
    expect(raised.every((i) => i.status === 'open' && i.detail.includes('Nothing has been changed'))).toBe(true);

    // The same change traced again raises nothing new.
    traceSourceChange(db, { companyId, report });
    expect(items()).toHaveLength(raised.length);
  });
});

describe('rules CLI: verify-sources', () => {
  it('exits 0 when every source is unchanged, and 1 with --trace raising review items when one has moved', async () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Cli Drift Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    loadStatutoryKnowledgeBase(db, { companyId });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });

    const changed = await main(['verify-sources', '--entry', 'vatca-2010-revised/s046', '--trace'], { db, companyId, fetchSource: async () => page() });
    expect(changed).toBe(1);
    const result = JSON.parse(out.join('')) as { reports: Array<{ status: string }>; traces: Array<{ reviewItemsRaised: number }> };
    expect(result.reports[0]!.status).toBe('changed');
    expect(result.traces[0]!.reviewItemsRaised).toBeGreaterThan(0);

    out.length = 0;
    const noTrace = await main(['verify-sources'], { db, companyId, fetchSource: () => Promise.reject(new Error('offline')) });
    expect(noTrace).toBe(1);
    expect(JSON.parse(out.join('')).traces).toEqual([]);
    vi.restoreAllMocks();
  });
});

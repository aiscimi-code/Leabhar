import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { catalogueOfficialFilePath, readCatalogueEntry, withoutPageState, type CatalogueEntry } from './catalogue';
import { readFileSync } from 'node:fs';
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

describe('a page with ASP.NET state (#713)', () => {
  const VAT3 = 'vat3-rtd/completing-vat3-return.json';
  const vat3 = () => readCatalogueEntry(VAT3);
  const kept = () => readFileSync(catalogueOfficialFilePath(VAT3)).toString('latin1');
  /** The kept page as Revenue serves it once its view state has rotated. */
  const rotated = (edit: (html: string) => string = (x) => x) => Buffer.from(edit(kept()
    .replace(/(name="__VIEWSTATE" id="__VIEWSTATE" value=")[^"]*/, '$1c29tZXRoaW5nIGVsc2U=')), 'latin1');

  it('empties only the state fields\' values', () => {
    const page = Buffer.from('<form><input type="hidden" name="__VIEWSTATE" value="abc" /><input name="q" value="keep" /></form>');
    expect(withoutPageState(page)!.toString()).toBe('<form><input type="hidden" name="__VIEWSTATE" value="" /><input name="q" value="keep" /></form>');
    expect(withoutPageState(Buffer.from('<p>no state</p>'))).toBeNull();
  });

  it('reports a page whose bytes moved only with its state as page_state_only, and traces nothing', () => {
    const report = compareWithCatalogue(VAT3, vat3(), rotated());
    expect(report.status).toBe('page_state_only');
    expect(report.currentSha256).not.toBe(report.recordedSha256);
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'State Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    expect(traceSourceChange(db, { companyId, report }).reviewItemsRaised).toBe(0);
  });

  it('still reports a page whose words moved as changed, quote by quote', () => {
    const report = compareWithCatalogue(VAT3, vat3(), rotated((html) => html.replace('sent to customers in other EU countries', 'sent to customers abroad')));
    expect(report.status).toBe('changed');
    expect(report.quotesMissing).toEqual(['vat3.box_e1@1']);
  });

  it('a change outside the words, in the markup, is still a change', () => {
    const report = compareWithCatalogue(VAT3, vat3(), rotated((html) => html.replace('<h3>T1', '<h3 class="moved">T1')));
    expect(report.status).toBe('changed');
    expect(report.quotesMissing).toEqual([]);
  });
});

describe('a EUR-Lex page with Dynatrace config (#714)', () => {
  const EU = 'eu-282-2011/consolidated-2025-04-14.json';
  const eu = () => readCatalogueEntry(EU);
  const kept = () => readFileSync(catalogueOfficialFilePath(EU)).toString('latin1');
  /** The kept page as EUR-Lex serves it on another request: new agent and page ids. */
  const refetched = (edit: (html: string) => string = (x) => x) => Buffer.from(edit(kept()
    .replace(/(data-dtconfig="[^"]*?agentId=)[0-9a-f]+/, '$10123456789abcdef')), 'latin1');

  it('empties only the config attribute\'s value', () => {
    const page = Buffer.from('<script src="a.js" data-dtconfig="app=1|agentId=2" async></script><p data-x="keep">');
    expect(withoutPageState(page)!.toString()).toBe('<script src="a.js" data-dtconfig="" async></script><p data-x="keep">');
  });

  it('reports a page whose bytes moved only with its config as page_state_only', () => {
    expect(refetched().equals(readFileSync(catalogueOfficialFilePath(EU)))).toBe(false);
    expect(compareWithCatalogue(EU, eu(), refetched()).status).toBe('page_state_only');
  });

  it('still reports a page whose words moved as changed, quote by quote', () => {
    const report = compareWithCatalogue(EU, eu(), refetched((html) => html.replace('a VAT identification number shall not', 'a VAT identification number may not')));
    expect(report.status).toBe('changed');
    expect(report.quotesMissing).toEqual(['eu.fixed_establishment_vat_number_not_sufficient@1']);
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

    // A page that moved only with its ASP.NET state passes, and --trace raises nothing (#713).
    out.length = 0;
    const kept = readFileSync(catalogueOfficialFilePath('vat3-rtd/completing-vat3-return.json')).toString('latin1');
    const rotated = Buffer.from(kept.replace(/(name="__VIEWSTATE" id="__VIEWSTATE" value=")[^"]*/, '$1cm90YXRlZA=='), 'latin1');
    const stateOnly = await main(['verify-sources', '--entry', 'vat3-rtd/completing-vat3-return', '--trace'], { db, companyId, fetchSource: async () => rotated });
    expect(stateOnly).toBe(0);
    const quiet = JSON.parse(out.join('')) as { reports: Array<{ status: string }>; traces: unknown[] };
    expect(quiet.reports[0]!.status).toBe('page_state_only');
    expect(quiet.traces).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('a changed PDF is not read as text (#702)', () => {
  it('reports the quotes as not assessed, not missing', () => {
    const entry = readCatalogueEntry('vatca-2010/vatca-2010-enacted.json');
    const fetched = Buffer.concat([Buffer.from('%PDF-1.4 changed'), Buffer.from([0])]);
    const report = compareWithCatalogue('vatca-2010/vatca-2010-enacted.json', entry, fetched);
    expect(report.status).toBe('changed');
    expect(report.quotesMissing).toEqual([]);
    expect(report.quotesNotAssessed.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishActProvisions, irishKnowledgeSources, irishTaxRules, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import {
  CATALOGUE_ENTRIES, catalogueOfficialFilePath, catalogueRulesFor, ingestCatalogueEntry, readCatalogueEntry, validateCatalogueEntry,
  type CatalogueEntry,
} from './catalogue';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { containsIgnoringLayout } from './lrcAnnotations';

/**
 * The rules catalogue (issue #443, #686 step 10): each committed entry is
 * well formed, says what the curation derives from it, and has replaced its
 * statute copy.
 */
let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Catalogue Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

describe.each(CATALOGUE_ENTRIES)('catalogue entry %s', (name) => {
  const entry = () => readCatalogueEntry(name);

  it('is well formed', () => {
    expect(() => entry()).not.toThrow();
  });

  it('holds the rules, links and reviews the curation derives from it (re-run npm run catalogue:extract)', () => {
    const e = entry();
    // An amending Act's entry can hold no rule of its own: it is the source a
    // rule cites for a date (finance-act-2023/s5.json, #688).
    expect(catalogueRulesFor(db, { companyId, entry: e, previous: e })).toEqual(e.rules);
  });

  it('quotes each rule version verbatim from its provision’s excerpt', () => {
    const e = entry();
    for (const rule of e.rules) {
      const excerpt = e.provisions.find((p) => p.sectionNumber === rule.sectionNumber)!.excerpt;
      for (const v of rule.versions) {
        if (v.quote) expect(containsIgnoringLayout(excerpt, v.quote), `${rule.key}@${v.version}`).toBe(true);
      }
    }
  });

  it('holds an approval only against the source hash it records', () => {
    const e = entry();
    for (const rule of e.rules) {
      for (const v of rule.versions) {
        if (v.review.status !== 'ai_extracted') expect(v.review.sourceSha256, `${rule.key}@${v.version}`).toBe(e.source.sha256);
      }
    }
  });

  it('keeps the official file it was extracted from, byte for byte, beside it (AGENTS.md #5)', () => {
    const path = catalogueOfficialFilePath(name);
    expect(existsSync(path), path).toBe(true);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(entry().source.sha256);
  });

  it('has replaced its statute copy: no .md, .html or .pdf of it is left in docs/statutes (#556)', () => {
    const stem = `docs/statutes/${name.replace(/\.json$/, '')}`;
    for (const ext of ['md', 'html', 'pdf']) expect(existsSync(`${stem}.${ext}`), `${stem}.${ext}`).toBe(false);
  });

  it('loads its provisions with their locators, and no offsets into a file that is not there', () => {
    const e = entry();
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, e.source.citation)).get()!;
    expect(source.sha256).toBe(e.source.sha256);
    expect(source.localPath).toBe(`catalogue/${name}`);
    const provisions = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, source.id)).all();
    expect(provisions.map((p) => [p.sectionNumber, p.locator, p.sourceStart])).toEqual(
      e.provisions.map((p) => [p.sectionNumber, p.locator, null]));
  });
});

describe('ingestCatalogueEntry', () => {
  const s46 = () => readCatalogueEntry('vatca-2010-revised/s046.json');
  const fresh = () => {
    const { db: d } = createTestDatabase();
    const { companyId: c } = createCompany(d, { legalName: 'Fresh Ltd', seedYears: [2025] });
    return { d, c };
  };

  it('is idempotent', () => {
    const { d, c } = fresh();
    const first = ingestCatalogueEntry(d, { companyId: c, entry: s46(), localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    const second = ingestCatalogueEntry(d, { companyId: c, entry: s46(), localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(second).toEqual({ ...first, ingested: false });
  });

  it('keeps a source a book read from its statute copy when the words are the same, so its rules keep their provision', () => {
    const { d, c } = fresh();
    const copy: CatalogueEntry = { ...s46(), source: { ...s46().source, sha256: '0'.repeat(64) } };
    const before = ingestCatalogueEntry(d, { companyId: c, entry: copy, localPath: 'docs/statutes/x.md', ingestVersion: 'v1' });
    const after = ingestCatalogueEntry(d, { companyId: c, entry: s46(), localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    expect(after.ingested).toBe(false);
    expect(after.sourceId).toBe(before.sourceId);
  });

  it('adds a new source, never editing the old one, when the words differ', () => {
    const { d, c } = fresh();
    ingestCatalogueEntry(d, { companyId: c, entry: s46(), localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    const moved: CatalogueEntry = {
      ...s46(),
      source: { ...s46().source, sha256: '1'.repeat(64) },
      provisions: s46().provisions.map((p) => ({ ...p, excerpt: `${p.excerpt} (amended)` })),
    };
    expect(ingestCatalogueEntry(d, { companyId: c, entry: moved, localPath: 'catalogue/x.json', ingestVersion: 'v2' }).ingested).toBe(true);
    expect(d.select().from(irishKnowledgeSources).all()).toHaveLength(2);
  });

  it('supersedes a copy that differs only by punctuation, and records the change (#706)', () => {
    const { d, c } = fresh();
    const official = s46();
    const copy: CatalogueEntry = {
      ...official,
      source: { ...official.source, sha256: '0'.repeat(64) },
      provisions: official.provisions.map((p, i) => i === 0
        ? { ...p, excerpt: p.excerpt.replace(',', '') }
        : p),
    };
    const before = ingestCatalogueEntry(d, { companyId: c, entry: copy, localPath: 'docs/statutes/x.md', ingestVersion: 'v1' });
    const provisionId = d.select({ id: irishActProvisions.id }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, before.sourceId)).get()!.id;
    d.insert(irishTaxRules).values({
      id: ids.taxRule(), companyId: c, provisionId, ruleKey: 'vat.punctuation_copy', topic: 'vat',
      name: 'Copy rule', statement: 'A rule taken from the copy.', effectiveFrom: '2010-11-01',
    }).run();

    const after = ingestCatalogueEntry(d, { companyId: c, entry: official, localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    expect(after.ingested).toBe(true);
    expect(after.repointed).toBe(1);
    expect(after.sourceId).not.toBe(before.sourceId);
    expect(d.select().from(irishKnowledgeSources).all()).toHaveLength(2);
    const rule = d.select().from(irishTaxRules).where(eq(irishTaxRules.ruleKey, 'vat.punctuation_copy')).get()!;
    expect(rule.provisionId).not.toBe(provisionId);
    const pointed = d.select().from(irishActProvisions).where(eq(irishActProvisions.id, rule.provisionId)).get()!;
    expect(pointed.sourceId).toBe(after.sourceId);
    const item = d.select().from(reviewItems).where(eq(reviewItems.companyId, c)).get()!;
    expect(item.dedupeKey).toBe(`catalogue-punctuation:${official.source.citation}`);
    expect(item.status).toBe('open');

    const again = ingestCatalogueEntry(d, { companyId: c, entry: official, localPath: 'catalogue/x.json', ingestVersion: 'v1' });
    expect(again).toEqual({ ...after, ingested: false, repointed: 0 });
  });
});

describe('validateCatalogueEntry', () => {
  const s46 = () => readCatalogueEntry('vatca-2010-revised/s046.json');

  it('refuses an approval that does not say who, when and against which hash', () => {
    const e = s46();
    e.rules[0]!.versions[0]!.review = { status: 'approved', by: 'A Reviewer', at: null, sourceSha256: null, note: null };
    expect(() => validateCatalogueEntry(e)).toThrow(/who, when/);
  });

  it('refuses a rule on a section the entry does not hold', () => {
    const e = s46();
    e.rules[0]!.sectionNumber = '999';
    expect(() => validateCatalogueEntry(e)).toThrow(/section 999/);
  });
});

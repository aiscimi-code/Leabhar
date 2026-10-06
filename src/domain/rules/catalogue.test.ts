import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishActProvisions, irishKnowledgeSources } from '@/db/schema';
import type { AppDatabase } from '@/db';
import {
  CATALOGUE_ENTRIES, catalogueRulesFor, ingestCatalogueEntry, readCatalogueEntry, validateCatalogueEntry,
  type CatalogueEntry,
} from './catalogue';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';

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

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

describe.each(CATALOGUE_ENTRIES)('catalogue entry %s', (name) => {
  const entry = () => readCatalogueEntry(name);

  it('is well formed', () => {
    expect(() => entry()).not.toThrow();
  });

  it('holds the rules, links and reviews the curation derives from it (re-run npm run catalogue:extract)', () => {
    const e = entry();
    expect(e.rules.length).toBeGreaterThan(0);
    expect(catalogueRulesFor(db, { companyId, entry: e, previous: e })).toEqual(e.rules);
  });

  it('quotes each rule version verbatim from its provision’s excerpt', () => {
    const e = entry();
    for (const rule of e.rules) {
      const excerpt = normalise(e.provisions.find((p) => p.sectionNumber === rule.sectionNumber)!.excerpt);
      for (const v of rule.versions) {
        if (v.quote) expect(excerpt.includes(normalise(v.quote)), `${rule.key}@${v.version}`).toBe(true);
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

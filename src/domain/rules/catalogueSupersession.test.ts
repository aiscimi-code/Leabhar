import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishActProvisions, irishKnowledgeSources, irishRuleLinks, irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { ingestCatalogueEntry, ingestCatalogueFile, readCatalogueEntry, type CatalogueEntry } from './catalogue';
import { preferredSourceId } from './catalogueSupersession';
import { deriveSi692025Rules } from './si692025Ingestion';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';

/**
 * A statute copy a book loaded before its source moved to the rules catalogue,
 * whose words are not the official ones (#706): superseded explicitly, never
 * left as a duplicate the derivations pick between at random.
 */
const ENTRY = 'si-69-2025/2025-si-69.json';
const COPY_PATH = 'docs/statutes/si-69-2025/2025-si-69.md';
const official = (): CatalogueEntry => readCatalogueEntry(ENTRY);

/** The entry as a pre-port copy held it: another file, with reg.9 edited. */
function copyOf(edit: (excerpt: string) => string): CatalogueEntry {
  const e = official();
  return {
    ...e,
    source: { ...e.source, sha256: 'c'.repeat(64) },
    provisions: e.provisions.map((p) => (p.sectionNumber === '9' ? { ...p, excerpt: edit(p.excerpt) } : p)),
  };
}

let db: AppDatabase;
let companyId: string;
beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Copy Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
});

const sources = () => db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, 'S.I. 69/2025')).all();
const rules = () => db.select({ key: irishTaxRules.ruleKey, version: irishTaxRules.ruleVersion, active: irishTaxRules.active, sourceId: irishActProvisions.sourceId })
  .from(irishTaxRules).innerJoin(irishActProvisions, eq(irishActProvisions.id, irishTaxRules.provisionId))
  .where(eq(irishTaxRules.companyId, companyId)).all();
const items = () => db.select().from(reviewItems)
  .where(and(eq(reviewItems.companyId, companyId), like(reviewItems.dedupeKey, 'catalogue-%'))).all();

describe('a pre-port copy that dropped a closing quote (#706)', () => {
  function loadCopyThenCatalogue() {
    const copy = ingestCatalogueEntry(db, {
      companyId, entry: copyOf((x) => x.replace('SME identified persons’)', 'SME identified persons)')), localPath: COPY_PATH, ingestVersion: 'v1',
    });
    deriveSi692025Rules(db, { companyId });
    const before = rules();
    const loaded = ingestCatalogueFile(db, { companyId, entry: ENTRY });
    return { copy, before, loaded };
  }

  it('the copy really differs only in punctuation', () => {
    expect(copyOf((x) => x.replace('SME identified persons’)', 'SME identified persons)')).provisions
      .find((p) => p.sectionNumber === '9')!.excerpt).not.toBe(official().provisions.find((p) => p.sectionNumber === '9')!.excerpt);
  });

  it('loads the official words, keeps the copy, and moves every rule to the catalogue provisions', () => {
    const { copy, before, loaded } = loadCopyThenCatalogue();
    expect(loaded.ingested).toBe(true);
    expect(sources().map((s) => s.localPath).sort()).toEqual([`catalogue/${ENTRY}`, COPY_PATH]);
    expect(before.every((r) => r.sourceId === copy.sourceId)).toBe(true);
    const after = rules();
    expect(after.map((r) => `${r.key}@${r.version}`).sort()).toEqual(before.map((r) => `${r.key}@${r.version}`).sort());
    expect(after.every((r) => r.sourceId === loaded.sourceId)).toBe(true);
    // The copy is kept as it was: the same provisions, the same words.
    expect(db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, copy.sourceId)).all()).toHaveLength(4);
  });

  it('records the one-character change as a punctuation review item, once', () => {
    loadCopyThenCatalogue();
    const raised = items();
    expect(raised).toEqual([expect.objectContaining({
      dedupeKey: 'catalogue-punctuation:S.I. 69/2025', severity: 'info', status: 'open', kind: 'other',
    })]);
    expect(raised[0]!.detail).toContain('9 (punctuation)');
    expect(raised[0]!.detail).toContain('The copy is kept as it was.');
    expect(ingestCatalogueFile(db, { companyId, entry: ENTRY }).ingested).toBe(false);
    expect(items()).toHaveLength(1);
  });

  it('derives from the catalogue source afterwards: every rule unchanged, none superseded', () => {
    const { loaded } = loadCopyThenCatalogue();
    expect(preferredSourceId(db, 'S.I. 69/2025')).toBe(loaded.sourceId);
    expect(deriveSi692025Rules(db, { companyId })).toMatchObject({ created: 0, superseded: 0 });
    expect(rules().every((r) => r.sourceId === loaded.sourceId)).toBe(true);
  });

  it('cites the catalogue provisions in the rule links, withdrawing the copy\'s', () => {
    loadCopyThenCatalogue();
    loadStatutoryKnowledgeBase(db, { companyId });
    const links = db.select({ active: irishRuleLinks.active, localPath: irishKnowledgeSources.localPath })
      .from(irishRuleLinks).innerJoin(irishActProvisions, eq(irishActProvisions.id, irishRuleLinks.toProvisionId))
      .innerJoin(irishKnowledgeSources, eq(irishKnowledgeSources.id, irishActProvisions.sourceId))
      .where(and(eq(irishRuleLinks.companyId, companyId), eq(irishKnowledgeSources.citation, 'S.I. 69/2025'))).all();
    expect(links.filter((l) => l.active).every((l) => l.localPath === `catalogue/${ENTRY}`)).toBe(true);
    expect(links.some((l) => l.active)).toBe(true);
  });
});

describe('a pre-port copy with words the official text does not have', () => {
  it('raises a wording warning, and leaves a rule whose words are gone on the copy for its derivation to supersede', () => {
    const copy = ingestCatalogueEntry(db, {
      companyId, entry: copyOf((x) => `${x} Inserted by hand.`), localPath: COPY_PATH, ingestVersion: 'v1',
    });
    deriveSi692025Rules(db, { companyId });
    // A rule quoting the copy's own words.
    const handEdited = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.annual_turnover_definition'))).get()!;
    db.update(irishTaxRules).set({ statement: 'Inserted by hand.' }).where(eq(irishTaxRules.id, handEdited.id)).run();

    const loaded = ingestCatalogueFile(db, { companyId, entry: ENTRY });
    const item = items()[0]!;
    expect(item).toMatchObject({ dedupeKey: 'catalogue-wording:S.I. 69/2025', severity: 'warning' });
    expect(item.detail).toContain('5 rules now read the catalogue\'s provisions; 1 whose words the catalogue does not hold stay on the copy');
    const kept = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, handEdited.id)).get()!;
    expect(db.select().from(irishActProvisions).where(eq(irishActProvisions.id, kept.provisionId)).get()!.sourceId).toBe(copy.sourceId);

    // Its derivation reads the catalogue source and supersedes it with a new version there.
    expect(deriveSi692025Rules(db, { companyId })).toMatchObject({ superseded: 1 });
    const active = rules().filter((r) => r.active && r.key === 'vat.annual_turnover_definition');
    expect(active).toEqual([expect.objectContaining({ version: 2, sourceId: loaded.sourceId })]);
  });
});

describe('a book whose copy says the official words', () => {
  it('keeps its source and raises nothing', () => {
    const copy = ingestCatalogueEntry(db, { companyId, entry: copyOf((x) => x), localPath: COPY_PATH, ingestVersion: 'v1' });
    expect(ingestCatalogueFile(db, { companyId, entry: ENTRY })).toMatchObject({ sourceId: copy.sourceId, ingested: false });
    expect(sources()).toHaveLength(1);
    expect(items()).toEqual([]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishActProvisions, irishKnowledgeSources, irishRuleLinks, irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { ingestCatalogueEntry, ingestCatalogueFile, readCatalogueEntry, type CatalogueEntry } from './catalogue';
import { preferredSourceId } from './catalogueSupersession';
import { deriveSi692025Rules } from './si692025Ingestion';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveCuratedRuleFamilies, deriveIncomeTaxRules, ingestSwcaSection, SI_312_1996_ART92_CATALOGUE_ENTRY } from './incomeTaxIngestion';
import { CAR_EMISSIONS_CURATED_RULES, CAR_EMISSIONS_RELEVANCE_REASON, CAR_EMISSIONS_SOURCES, TDM_11_00_01_CATALOGUE_ENTRY } from './carEmissionsCuration';
import { ingestSlicedSource } from './slicedSourceIngestion';

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
    deriveStatutoryKnowledgeBase(db, { companyId });
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

describe('S.I. 312/1996 art. 92: a hand-edited copy (#712)', () => {
  const FIXTURE = 'src/domain/rules/__fixtures__/si-312-1996-art92.md';
  const ruleRows = () => db.select({ id: irishTaxRules.id, version: irishTaxRules.ruleVersion, active: irishTaxRules.active, provisionId: irishTaxRules.provisionId })
    .from(irishTaxRules).where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'prsi.class_s_disregard'))).all();

  it('a new book quotes the official article, layout aside, from 1 January 2011', () => {
    const { sourceId } = ingestCatalogueFile(db, { companyId, entry: SI_312_1996_ART92_CATALOGUE_ENTRY });
    deriveIncomeTaxRules(db, { companyId });
    const [rule] = ruleRows();
    const provision = db.select().from(irishActProvisions).where(eq(irishActProvisions.id, rule!.provisionId)).get()!;
    expect(provision.sourceId).toBe(sourceId);
    expect(provision.provisionText).not.toContain('shall be €5,000 in a contribution year.'); // the page breaks the line
    expect(provision.provisionText).not.toContain('Substituted'); // the F292 note is not the article
    expect(provision.effectiveClue).toContain('S.I. No. 684 of 2010), art. 6, in effect as per art. 2.');
    expect(db.select().from(irishTaxRules).where(eq(irishTaxRules.id, rule!.id)).get()).toMatchObject({
      effectiveFrom: '2011-01-01', numericValue: 500_000, statement: 'shall be €5,000 in a contribution year.',
    });
  });

  it('a book that loaded the copy keeps it, its rule moves to the article without a new version, and the hand-edit is on the record', () => {
    const copy = ingestSwcaSection(db, { companyId, markdown: readFileSync(FIXTURE, 'utf8'), ingestVersion: 'v1', localPath: FIXTURE });
    deriveIncomeTaxRules(db, { companyId });
    const before = ruleRows();
    expect(before).toHaveLength(1);

    const loaded = ingestCatalogueFile(db, { companyId, entry: SI_312_1996_ART92_CATALOGUE_ENTRY });
    expect(deriveIncomeTaxRules(db, { companyId }).created).toBe(0);
    const after = ruleRows();
    expect(after).toEqual([expect.objectContaining({ id: before[0]!.id, version: 1, active: true })]);
    expect(db.select().from(irishActProvisions).where(eq(irishActProvisions.id, after[0]!.provisionId)).get()!.sourceId).toBe(loaded.sourceId);
    expect(db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, copy.sourceId)).get()).toBeTruthy();
    expect(items()).toEqual([expect.objectContaining({ dedupeKey: 'catalogue-wording:S.I. 312/1996 s.92', severity: 'warning' })]);
  });
});

describe('TDM 11-00-01: a copy whose page markers differ from the converter\'s', () => {
  it('is superseded as punctuation only: the page markers are the converter\'s, not the manual\'s words', () => {
    const FIXTURE = 'src/domain/rules/__fixtures__/tdm-11-00-01.md';
    ingestSlicedSource(db, CAR_EMISSIONS_SOURCES.map((s) => ({ ...s, path: FIXTURE })), CAR_EMISSIONS_RELEVANCE_REASON,
      { companyId, markdown: readFileSync(FIXTURE, 'utf8'), ingestVersion: 'v1', localPath: FIXTURE });
    // The car rule families also quote the Notes for Guidance on Part 11C.
    ingestCatalogueFile(db, { companyId, entry: 'tca-1997-nfg/part11c.json' });
    expect(deriveCuratedRuleFamilies(db, { companyId, rules: CAR_EMISSIONS_CURATED_RULES, label: 'capital allowances' }).skippedNoProvision).toEqual([]);
    const before = rules().filter((r) => r.key.startsWith('car.')).map((r) => `${r.key}@${r.version}`).sort();
    ingestCatalogueFile(db, { companyId, entry: TDM_11_00_01_CATALOGUE_ENTRY });
    expect(items()).toEqual([expect.objectContaining({ dedupeKey: 'catalogue-punctuation:Revenue TDM Part 11-00-01', severity: 'info' })]);
    expect(items()[0]!.detail).toContain('3 rules now read the catalogue\'s provisions.');
    expect(deriveCuratedRuleFamilies(db, { companyId, rules: CAR_EMISSIONS_CURATED_RULES, label: 'capital allowances' }).created).toBe(0);
    expect(rules().filter((r) => r.key.startsWith('car.')).map((r) => `${r.key}@${r.version}`).sort()).toEqual(before);
  });
});

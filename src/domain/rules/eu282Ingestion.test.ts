import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestEu282Articles, ingestEu282FromCatalogue, deriveEu282Rules, parseEuArticles,
  EU_282_2011_RULES, EU_282_2011, EU_282_2011_CATALOGUE_ENTRY,
} from './eu282Ingestion';
import { readCatalogueEntry } from './catalogue';
import { loadStatutoryKnowledgeBase, verifyStatuteFile } from './knowledgeBase';
import { resolveRuleDependencies } from './dependencies';
import { sourceAuthorityRank } from './sourceHierarchy';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
/** The Markdown extract the knowledge base read before the port (the CLI's --file). */
const FIXTURE = 'src/domain/rules/__fixtures__/eu-282-2011-articles-10-13b.md';
const markdown = readFileSync(FIXTURE, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'EU 282 Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
});

describe('the first EU source (issue #441)', () => {
  it('parses articles 10, 11, 12, 13, 13a and 13b, each with offsets', () => {
    const articles = parseEuArticles(markdown);
    expect(articles.map((a) => a.sectionNumber)).toEqual(['10', '11', '12', '13', '13a', '13b']);
    for (const article of articles) {
      expect(markdown.slice(article.sourceStart, article.sourceEnd).replace(/\s+/g, ' ')).toContain(
        article.provisionText.slice(0, 40),
      );
    }
  });

  it('loads the articles from their catalogue entry as an eu_source, idempotently, with article locators', () => {
    const first = ingestEu282FromCatalogue(db, { companyId });
    expect(first).toMatchObject({ provisionCount: 6, ingested: true });
    expect(ingestEu282FromCatalogue(db, { companyId }).ingested).toBe(false);

    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source).toMatchObject({ sourceType: 'eu_source', jurisdiction: 'EU', localPath: `catalogue/${EU_282_2011_CATALOGUE_ENTRY}` });
    expect(source.effectiveFrom).toBe('2011-07-01'); // the Regulation's application provision, not its retrieval
    const article = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, source.id), eq(irishActProvisions.sectionNumber, '13b'))).get()!;
    expect(article).toMatchObject({ locator: 'art. 13b', effectiveClue: EU_282_2011.effectiveClue, citedActs: ['Directive 2006/112/EC'] });
    const check = verifyStatuteFile(source.localPath, source.sha256, null, null, undefined, '13b');
    expect(check.exists && check.sha256Matches).toBe(true);
    expect(check.slice).toContain('any specific part of the earth');
  });

  it('ends each article before the next one\'s heading (#715)', () => {
    for (const a of parseEuArticles(markdown)) expect(a.provisionText, a.sectionNumber).not.toMatch(/Article \d+[a-z]?$/);
    for (const p of readCatalogueEntry(EU_282_2011_CATALOGUE_ENTRY).provisions) expect(p.excerpt, p.sectionNumber).not.toMatch(/Article \d+[a-z]?$/);
  });

  it('the EUR-Lex page says the same words the Markdown extract did, article by article', () => {
    const entry = readCatalogueEntry(EU_282_2011_CATALOGUE_ENTRY);
    expect(entry.provisions.map((p) => [p.sectionNumber, p.excerpt]))
      .toEqual(parseEuArticles(markdown).map((a) => [a.sectionNumber, a.provisionText]));
  });

  it('a book that read the Markdown extract keeps its source when the catalogue entry loads', () => {
    const before = ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1', localPath: FIXTURE });
    expect(ingestEu282FromCatalogue(db, { companyId })).toMatchObject({ sourceId: before.sourceId, ingested: false });
  });

  it('ingests a Markdown extract (--file) as an eu_source, idempotently, with article locators', () => {
    const first = ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1', localPath: FIXTURE });
    expect(first).toMatchObject({ provisionCount: 6, ingested: true });
    expect(ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1', localPath: FIXTURE }).ingested).toBe(false);

    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.sourceType).toBe('eu_source');
    expect(source.jurisdiction).toBe('EU');
    expect(source.sourceUrl).toContain('eur-lex.europa.eu');
    // Effective from the Regulation's own application provision, not its retrieval.
    expect(source.effectiveFrom).toBe('2011-07-01');

    const article = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, source.id), eq(irishActProvisions.sectionNumber, '10'))).get()!;
    expect(article.locator).toBe('art. 10');
    const check = verifyStatuteFile(source.localPath, source.sha256, article.sourceStart, article.sourceEnd);
    expect(check.exists && check.sha256Matches).toBe(true);
  });

  it('EU law ranks with legislation, above guidance', () => {
    ingestEu282FromCatalogue(db, { companyId });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, EU_282_2011.citation)).get()!;
    expect(sourceAuthorityRank(source.sourceType)).toBe(sourceAuthorityRank('legislation'));
    expect(sourceAuthorityRank(source.sourceType)).toBeLessThan(sourceAuthorityRank('revenue_guidance'));
  });

  it('derives every curated definition rule, quoting its article verbatim, unreviewed', () => {
    ingestEu282FromCatalogue(db, { companyId });
    const result = deriveEu282Rules(db, { companyId });
    expect(result).toMatchObject({ created: EU_282_2011_RULES.length, skippedNoProvision: [] });

    for (const curated of EU_282_2011_RULES) {
      const rule = db.select().from(irishTaxRules)
        .where(and(
          eq(irishTaxRules.companyId, companyId),
          eq(irishTaxRules.ruleKey, curated.ruleKey),
          eq(irishTaxRules.active, true),
        )).get();
      expect(rule, curated.ruleKey).toBeTruthy();
      expect(rule!.statement).toBe(curated.statementExcerpt);
      expect(rule!.reviewStatus).toBe('ai_extracted');
      expect(rule!.conditions).toEqual([]); // a multi-factor test a person applies, never auto-matched
      const provision = db.select().from(irishActProvisions)
        .where(eq(irishActProvisions.id, rule!.provisionId)).get()!;
      expect(provision.provisionText, curated.ruleKey).toContain(curated.statementExcerpt);
    }
    // Idempotent.
    expect(deriveEu282Rules(db, { companyId })).toMatchObject({
      created: 0, superseded: 0, unchanged: EU_282_2011_RULES.length,
    });
  });

  it('the rules cross-reference the VATCA sections that rely on the tests, and resolve', () => {
    ingestEu282FromCatalogue(db, { companyId });
    loadStatutoryKnowledgeBase(db, { companyId });
    deriveEu282Rules(db, { companyId });
    const rule = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, companyId),
        eq(irishTaxRules.ruleKey, 'eu.establishment_postal_address_not_sufficient'),
        eq(irishTaxRules.active, true),
      )).get()!;
    expect(rule.crossReferences).toEqual([
      'Value-Added Tax Consolidation Act 2010 s.12',
      'Value-Added Tax Consolidation Act 2010 s.34',
    ]);
    for (const dep of resolveRuleDependencies(db, { ruleId: rule.id })) {
      expect(dep.resolved, dep.reference).toBe(true);
    }
  });
});

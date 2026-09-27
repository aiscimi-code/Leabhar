import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestEu282Articles, deriveEu282Rules, parseEuArticles,
  EU_282_2011_MD_PATH, EU_282_2011_RULES, EU_282_2011,
} from './eu282Ingestion';
import { loadStatutoryKnowledgeBase, verifyStatuteFile } from './knowledgeBase';
import { resolveRuleDependencies } from './dependencies';
import { sourceAuthorityRank } from './sourceHierarchy';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let markdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'EU 282 Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  markdown = readFileSync(EU_282_2011_MD_PATH, 'utf8');
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

  it('ingests the articles as an eu_source, idempotently, with article locators', () => {
    const first = ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first).toMatchObject({ provisionCount: 6, ingested: true });
    expect(ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1' }).ingested).toBe(false);

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
    ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1' });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, EU_282_2011.citation)).get()!;
    expect(sourceAuthorityRank(source.sourceType)).toBe(sourceAuthorityRank('legislation'));
    expect(sourceAuthorityRank(source.sourceType)).toBeLessThan(sourceAuthorityRank('revenue_guidance'));
  });

  it('derives every curated definition rule, quoting its article verbatim, unreviewed', () => {
    ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1' });
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
    ingestEu282Articles(db, { companyId, markdown, ingestVersion: 'v1' });
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

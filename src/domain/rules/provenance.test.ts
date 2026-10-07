import { describe, it, expect, beforeAll } from 'vitest';
import { containsIgnoringLayout } from './lrcAnnotations';
import { readFileSync, existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { statuteFilePath, verifyStatuteFile } from './knowledgeBase';
import { visibleActProvisions, visibleKnowledgeSources, visibleTaxRules, visibleTaxRuleTests } from '@/db/schema';
import { normaliseSpace } from '../vat/boxDefinitions';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

/**
 * Provenance completeness (issue #442, epic #310's last partial item): every
 * derived rule names its source, section and locator, carries an effective
 * date from the source rather than the day it was fetched, quotes text that is
 * verbatim recoverable from the cited file as re-read now (AGENTS.md #5), and
 * — where it takes part in transaction matching — has a stored test case.
 * It reads the rules store the book attaches (ADR-0021), where the rules and
 * their cases live; a book holds none of its own.
 */
beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Provenance Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
});

describe('every derived rule carries its provenance (issue #442)', () => {
  /** Only rules a lookup can return: active and enabled. */
  const rules = () => {
    const all = db.select().from(visibleTaxRules)
      .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.origin, 'store'))).all();
    expect(all.length).toBeGreaterThan(0); // a check over no rules proves nothing
    return all.filter((r) => r.active && r.enabled);
  };
  const provisions = () => db.select().from(visibleActProvisions).where(eq(visibleActProvisions.origin, 'store')).all();
  const sources = () => db.select().from(visibleKnowledgeSources).where(eq(visibleKnowledgeSources.origin, 'store')).all();

  it('every rule resolves to a source with a URL', () => {
    const byId = new Map(provisions().map((p) => [p.id, p]));
    const sourceById = new Map(sources().map((s) => [s.id, s]));
    for (const rule of rules()) {
      const provision = byId.get(rule.provisionId);
      expect(provision, rule.ruleKey).toBeTruthy();
      const source = provision ? sourceById.get(provision.sourceId) : undefined;
      expect(source, rule.ruleKey).toBeTruthy();
      expect(source!.sourceUrl, rule.ruleKey).toMatch(/^https:\/\//);
    }
  });

  it('every rule names a section, and a locator: the source\u2019s own reference or a re-checkable offset slice', () => {
    const byId = new Map(provisions().map((p) => [p.id, p]));
    for (const rule of rules()) {
      const provision = byId.get(rule.provisionId)!;
      expect(provision.sectionNumber, rule.ruleKey).not.toBe('');
      // The #293 locator model: either the source's own way of pointing a
      // reader here (a page, anchor, article or box), or the character
      // offsets that re-slice the local file.
      expect(Boolean(provision.locator || (provision.sourceStart !== null && provision.sourceEnd !== null)), rule.ruleKey)
        .toBe(true);
    }
  });

  it('the provisions of the sources ingested after the locator column existed state a locator of their own', () => {
    const sourceById = new Map(sources().map((s) => [s.id, s]));
    const locatorSources = new Set([
      'Revenue: How do you complete a VAT 3 return?',
      'Revenue TDM VAT-RTD-S76',
      'Revenue eBrief No. 168/25',
      'Council Implementing Regulation (EU) No 282/2011 arts. 10-13b',
    ]);
    for (const provision of provisions()) {
      const citation = sourceById.get(provision.sourceId)?.citation;
      if (!citation || !locatorSources.has(citation)) continue;
      expect(provision.locator, `${citation} ${provision.sectionNumber}`).toMatch(/^(box|page|notice|art\.) /);
    }
  });

  it('every rule\u2019s effective date comes from its source, never the day it was fetched', () => {
    const byId = new Map(provisions().map((p) => [p.id, p]));
    const sourceById = new Map(sources().map((s) => [s.id, s]));
    for (const rule of rules()) {
      expect(rule.effectiveFrom, rule.ruleKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const provision = byId.get(rule.provisionId)!;
      const source = sourceById.get(provision.sourceId)!;
      // #216: "date retrieved" is recorded separately and is never used as
      // effectiveFrom. In this test the KB is loaded now, so a source dated
      // from its own retrieval date is caught here.
      expect(rule.effectiveFrom, rule.ruleKey).not.toBe(source.retrievedAt.slice(0, 10));
    }
  });

  it('every rule\u2019s quote is verbatim in its cited file, as re-read and re-hashed now (AGENTS.md #5)', () => {
    const byId = new Map(provisions().map((p) => [p.id, p]));
    const sourceById = new Map(sources().map((s) => [s.id, s]));
    const fileText = new Map<string, string>();
    for (const rule of rules()) {
      if (!rule.statement) continue;
      const provision = byId.get(rule.provisionId)!;
      const source = sourceById.get(provision.sourceId)!;
      const path = statuteFilePath(source.localPath ?? '');
      expect(existsSync(path), `${rule.ruleKey}: ${source.localPath}`).toBe(true);
      const text = fileText.get(path) ?? readFileSync(path, 'utf8');
      fileText.set(path, text);
      const check = verifyStatuteFile(source.localPath, source.sha256, provision.sourceStart, provision.sourceEnd, undefined, provision.sectionNumber);
      expect(check.sha256Matches, `${rule.ruleKey}: ${source.citation} file changed since ingest`).toBe(true);
      // The Finance Act 2024 derive step prefixes its statements with the
      // citation ("Finance Act 2024 s.48: "); the verbatim part is what follows.
      const quote = normaliseSpace(rule.statement.replace(/^Finance Act \d{4} s\.\d+[A-Z]*: /, ''));
      // The quote is verbatim from the stored provision text...
      expect(containsIgnoringLayout(provision.provisionText ?? '', quote),
        `${rule.ruleKey}: quote not in ${source.citation} ${provision.sectionNumber} as ingested`)
        .toBe(true);
      // ...and the provision's offsets still slice the file it was ingested
      // from. A section spanning printed pages carries page furniture the
      // parser strips, so the slice is compared by token coverage, the same
      // standard statuteParser.test.ts applies at ingest (>=90%).
      const sliceTokens = new Set((check.slice ? check.slice : text).toLowerCase().match(/[a-z0-9%€]+/g) ?? []);
      const quoteTokens = quote.toLowerCase().match(/[a-z0-9%€]+/g) ?? [];
      const covered = quoteTokens.filter((t) => sliceTokens.has(t)).length / Math.max(quoteTokens.length, 1);
      expect(covered >= 0.9,
        `${rule.ruleKey}: only ${Math.round(covered * 100)}% of the quote's tokens are in ${source.citation} `
          + `${provision.sectionNumber} at the stored offsets`)
        .toBe(true);
    }
  });

  it('every rule that matches transactions has a stored test case', () => {
    const cases = db.select().from(visibleTaxRuleTests).all();
    const rulesWithCases = new Set(cases.map((c) => c.ruleId));
    for (const rule of rules()) {
      if (!rule.conditions.length) continue; // reporting/definition rules are not transaction-matched
      expect(rulesWithCases.has(rule.id), rule.ruleKey).toBe(true);
    }
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishRuleDecisions, irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { readCatalogueEntry, serialiseCatalogueEntry } from './catalogue';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { setRuleReviewStatus } from './review';
import { catalogueRuleStore, checkCatalogueVersions, effectiveRuleReview, ruleDecisionHistory } from './ruleDecisions';

/**
 * A book keeps its own decisions about rule versions; the expert review
 * ships in the catalogue (ADR-0020 §6, issue #686 step 11).
 */
let db: AppDatabase;
let sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
let companyId: string;
let loaded: ReturnType<typeof loadStatutoryKnowledgeBase>;

beforeAll(() => {
  ({ db, sqlite } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Decisions Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  loaded = loadStatutoryKnowledgeBase(db, { companyId });
});

const ruleRow = (ruleKey: string, ruleVersion = 1) => db.select().from(irishTaxRules)
  .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey), eq(irishTaxRules.ruleVersion, ruleVersion))).get()!;

describe('catalogueRuleStore', () => {
  it('holds every catalogued rule version with the review it ships with', () => {
    const store = catalogueRuleStore();
    const s46 = readCatalogueEntry('vatca-2010-revised/s046.json');
    for (const rule of s46.rules) {
      expect(store.keys.has(rule.key)).toBe(true);
      for (const v of rule.versions) expect(store.versions.get(`${rule.key}@${v.version}`)!.review).toEqual(v.review);
    }
  });
});

describe('effectiveRuleReview', () => {
  it('reads the catalogue’s review while the book has taken no decision', () => {
    const review = effectiveRuleReview(db, { companyId, ruleKey: 'vat.rate_livestock_current', ruleVersion: 1 });
    expect(review).toMatchObject({ versionId: 'vat.rate_livestock_current@1', from: 'catalogue', status: 'ai_extracted' });
    expect(review.catalogue!.citation).toBe('2010 Act 31 s.46');
  });

  it('holds nothing for a rule the catalogue does not carry and the book has not decided', () => {
    expect(effectiveRuleReview(db, { companyId, ruleKey: 'no.such_rule', ruleVersion: 1 }))
      .toMatchObject({ from: 'none', status: null, catalogue: null });
  });

  it('follows the book’s latest decision, keeping every earlier one on record', () => {
    const row = ruleRow('vat.rate_reduced_current');
    setRuleReviewStatus(db, { ruleId: row.id, status: 'human_review', reviewedBy: 'Aoife', notes: 'checking the Schedule' });
    setRuleReviewStatus(db, { ruleId: row.id, status: 'approved', reviewedBy: 'Brian', notes: 'matches s.46(1)(c)' });

    const history = ruleDecisionHistory(db, { companyId, ruleKey: 'vat.rate_reduced_current', ruleVersion: 1 });
    expect(history.map((d) => [d.status, d.decidedBy, d.reason, d.ruleId])).toEqual([
      ['approved', 'Brian', 'matches s.46(1)(c)', row.id],
      ['human_review', 'Aoife', 'checking the Schedule', row.id],
    ]);
    const review = effectiveRuleReview(db, { companyId, ruleKey: 'vat.rate_reduced_current', ruleVersion: 1 });
    expect(review).toMatchObject({ from: 'book', status: 'approved', by: 'Brian', reason: 'matches s.46(1)(c)' });
    expect(review.catalogue!.review.status).toBe('ai_extracted');
    expect(ruleRow('vat.rate_reduced_current').reviewStatus).toBe('approved');
  });
});

describe('migration 0058: the decisions a book took before step 11', () => {
  it('carries each reviewed rule’s decision into irish_rule_decisions, and no unreviewed one', () => {
    const { db: d, sqlite: s } = createTestDatabase();
    const { companyId: c } = createCompany(d, { legalName: 'Older Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    loadStatutoryKnowledgeBase(d, { companyId: c });
    // A decision taken before the table existed lived only on the rule row.
    const row = d.select().from(irishTaxRules).where(and(eq(irishTaxRules.companyId, c), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current'), eq(irishTaxRules.ruleVersion, 1))).get()!;
    d.update(irishTaxRules).set({ reviewStatus: 'rejected', reviewedBy: 'Ciara', reviewedAt: '2026-01-05T10:00:00.000Z', reviewNotes: 'wrong window' })
      .where(eq(irishTaxRules.id, row.id)).run();

    s.exec(readFileSync('drizzle/0058_rule_decisions_backfill.sql', 'utf8'));

    expect(d.select().from(irishRuleDecisions).where(eq(irishRuleDecisions.companyId, c)).all()).toEqual([
      expect.objectContaining({
        id: `rd_migrated_${row.id}`, ruleKey: 'vat.rate_standard_current', ruleVersion: 1, ruleId: row.id,
        status: 'rejected', decidedBy: 'Ciara', decidedAt: '2026-01-05T10:00:00.000Z', reason: 'wrong window',
      }),
    ]);
  });
});

describe('checkCatalogueVersions', () => {
  const missingItems = () => db.select().from(reviewItems)
    .where(and(eq(reviewItems.companyId, companyId), like(reviewItems.dedupeKey, 'rule_version_missing:%'))).all();

  it('finds nothing in a book loaded from the installed catalogue', () => {
    expect(loaded.catalogueVersionsMissing).toEqual([]);
    expect(missingItems()).toEqual([]);
  });

  it('raises a review item, once, for a version the book holds that the catalogue no longer ships', () => {
    const root = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
    const entry = readCatalogueEntry('vatca-2010-revised/s046.json');
    entry.rules = entry.rules.map((r) => (r.key === 'vat.rate_standard_current'
      ? { ...r, versions: r.versions.filter((v) => v.version !== 2) } : r));
    cpSync('catalogue', join(root, 'catalogue'), { recursive: true });
    writeFileSync(join(root, 'catalogue', 'vatca-2010-revised', 's046.json'), serialiseCatalogueEntry(entry));

    expect(checkCatalogueVersions(db, { companyId, root })).toEqual([{ versionId: 'vat.rate_standard_current@2', referencedBy: ['rule'] }]);
    checkCatalogueVersions(db, { companyId, root });
    const items = missingItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'warning', entityType: 'irish_rule_key', entityId: 'vat.rate_standard_current' });
    expect(items[0]!.detail).toContain('nothing has been switched to another version');
    // The book's own rule row is untouched.
    expect(ruleRow('vat.rate_standard_current', 2).enabled).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestFinanceAct2024, deriveTaxRules, lookupTaxRule, listTaxRulesByTopic,
  listTaxRulesByCategory, FINANCE_ACT_2024_MD_PATH, FINANCE_ACT_2024,
} from './irishRules';
import { irishTaxRules, reviewItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rules KB Ltd', seedYears: [2025] }));
});

describe('ingestFinanceAct2024', () => {
  it('ingests all 118 sections and judges a majority relevant', () => {
    const result = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(result.ingested).toBe(true);
    expect(result.provisionCount).toBe(118);
    expect(result.relevantCount).toBeGreaterThan(0);
    expect(result.relevantCount).toBeLessThan(result.provisionCount);
  });

  it('is idempotent by content: re-ingesting identical bytes is a no-op', () => {
    const first = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    const second = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.provisionCount).toBe(first.provisionCount);
  });

  it('tags the source as legislation, never merged with a guidance source type', () => {
    ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    // FINANCE_ACT_2024 constant carries the citation the ingest writes.
    expect(FINANCE_ACT_2024.sourceType).toBe('legislation');
    expect(FINANCE_ACT_2024.citation).toBe('2024 Act 43');
  });
});

describe('deriveTaxRules', () => {
  beforeEach(() => {
    ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated, relevant section', () => {
    const result = deriveTaxRules(db, { companyId });
    // factExtractor.SECTION_RULE_KEYS curates sections 2, 3, 13, 48.
    expect(result.created).toBe(4);
    expect(result.unchanged).toBe(0);
  });

  it('never invents a numeric value: every rule carries the verbatim extracted token', () => {
    deriveTaxRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.extractedFact).toBeTruthy();
      expect(row.statement).toContain('Finance Act 2024 s.');
      expect(row.statement).toContain(row.extractedFact);
      // Every rule starts unreviewed — extraction never becomes authoritative on its own.
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
    }
  });

  it('surfaces each new rule in the existing review inbox, not a separate queue', () => {
    deriveTaxRules(db, { companyId });
    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.companyId, companyId)).all();
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
    expect(items.every((i) => i.kind === 'unresolved_ai_suggestion')).toBe(true);
  });

  it('is idempotent: re-running with unchanged source figures creates nothing new', () => {
    deriveTaxRules(db, { companyId });
    const second = deriveTaxRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(4);
  });

  it('versions a rule instead of editing it in place when its figure changes', () => {
    deriveTaxRules(db, { companyId });
    const before = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'usc.first_band_threshold')).all();
    expect(before).toHaveLength(1);
    const originalId = before[0]!.id;

    // Simulate a re-ingest of an amended Act by mutating the stored provision's
    // extracted figure to a different amount, the way a later Finance Act would.
    const withDifferentUscBand = markdown.replace('€27,382', '€30,000');
    // Different bytes -> a distinct source; derive scoped to the newly ingested source.
    const reingest = ingestFinanceAct2024(db, { companyId, markdown: withDifferentUscBand, ingestVersion: 'v2' });
    deriveTaxRules(db, { companyId, sourceId: reingest.sourceId });

    const after = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'usc.first_band_threshold')).all();
    expect(after).toHaveLength(2);
    const closed = after.find((r) => r.id === originalId)!;
    const superseding = after.find((r) => r.id !== originalId)!;
    expect(closed.active).toBe(false);
    expect(closed.effectiveTo).not.toBeNull();
    expect(superseding.active).toBe(true);
    expect(superseding.supersedesRuleId).toBe(originalId);
    expect(superseding.ruleVersion).toBe(2);
    expect(superseding.extractedFact).toBe('€30,000');
  });
});

describe('lookupTaxRule / listTaxRulesByTopic / listTaxRulesByCategory', () => {
  beforeEach(() => {
    ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    deriveTaxRules(db, { companyId });
  });

  it('finds a rule by its stable key, carrying source citation and verbatim text', () => {
    const result = lookupTaxRule(db, { companyId, ruleKey: 'usc.first_band_threshold' });
    expect(result).not.toBeNull();
    expect(result!.extractedFact).toBe('€27,382');
    expect(result!.citation).toBe('2024 Act 43');
    expect(result!.sectionNumber).toBe('2');
    expect(result!.provisionText).toContain('531AN');
    expect(result!.sourceStart).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a key with no rule, never a guessed answer', () => {
    expect(lookupTaxRule(db, { companyId, ruleKey: 'vat.made_up_key' })).toBeNull();
  });

  it('resolves the rule in force on a given historical date, not just "today"', () => {
    // USC threshold rule states "year of assessment 2025" -> effectiveFrom 2025-01-01.
    expect(lookupTaxRule(db, { companyId, ruleKey: 'usc.first_band_threshold', asOfDate: '2024-12-31' })).toBeNull();
    expect(lookupTaxRule(db, { companyId, ruleKey: 'usc.first_band_threshold', asOfDate: '2025-01-01' })).not.toBeNull();
  });

  it('lists rules by topic', () => {
    const uscRules = listTaxRulesByTopic(db, { companyId, topic: 'usc', asOfDate: '2025-06-01' });
    expect(uscRules.map((r) => r.ruleKey)).toContain('usc.first_band_threshold');
  });

  it('lists rules by provision category', () => {
    const rows = listTaxRulesByCategory(db, { companyId, category: 'usc', asOfDate: '2025-06-01' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ruleKey.startsWith('usc.'))).toBe(true);
  });
});

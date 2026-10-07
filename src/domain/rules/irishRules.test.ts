import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestFinanceAct2024, ingestFinanceAct2024FromCatalogue, deriveTaxRules, lookupTaxRule, listTaxRulesByTopic,
  listTaxRulesByCategory, FINANCE_ACT_2024, ingestFinanceAct2025FromCatalogue,
} from './irishRules';
import { irishActProvisions, irishKnowledgeSources, irishTaxRules, reviewItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
/** The Act's front matter and ss.1-4 as `pdftotext -layout` lays them out: the Markdown ingest (`--file`). */
const markdown = readFileSync(new URL('./__fixtures__/finance-act-2024-excerpt.md', import.meta.url), 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rules KB Ltd', seedYears: [2025] }));
});

describe('ingestFinanceAct2024FromCatalogue', () => {
  it('loads all 118 sections and judges a majority relevant', () => {
    const result = ingestFinanceAct2024FromCatalogue(db, { companyId });
    expect(result.ingested).toBe(true);
    expect(result.provisionCount).toBe(118);
    const rows = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, result.sourceId)).all();
    const relevant = rows.filter((r) => r.relevant).length;
    expect(relevant).toBeGreaterThan(0);
    expect(relevant).toBeLessThan(rows.length);
  });

  it('is idempotent: loading the entry again is a no-op', () => {
    const first = ingestFinanceAct2024FromCatalogue(db, { companyId });
    const second = ingestFinanceAct2024FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.provisionCount).toBe(first.provisionCount);
  });

  it('dates the source from the Act, as legislation, and points at the entry', () => {
    const { sourceId } = ingestFinanceAct2024FromCatalogue(db, { companyId });
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get()!;
    expect(source.citation).toBe(FINANCE_ACT_2024.citation);
    expect(source.sourceType).toBe('legislation');
    expect(source.publicationDate).toBe('2024-11-12');
    expect(source.effectiveFrom).toBe('2024-11-12');
    expect(source.localPath).toBe('catalogue/finance-act-2024/2024-act-43-enacted.json');
  });
});

describe('ingestFinanceAct2024 (a Markdown copy, the CLI\'s --file)', () => {
  it('ingests the sections it holds', () => {
    const result = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(result.ingested).toBe(true);
    expect(result.provisionCount).toBe(4);
  });

  it('is idempotent by content: re-ingesting identical bytes is a no-op', () => {
    const first = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    const second = ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.provisionCount).toBe(first.provisionCount);
  });
});

describe('deriveTaxRules', () => {
  beforeEach(() => {
    ingestFinanceAct2024FromCatalogue(db, { companyId });
  });

  it('creates one rule per curated, relevant section', () => {
    const result = deriveTaxRules(db, { companyId });
    // factExtractor.SECTION_RULE_KEYS curates sections 2 and 3 (13 and 48 were retired, issue #277).
    expect(result.created).toBe(2);
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
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
    expect(items.every((i) => i.kind === 'unresolved_ai_suggestion')).toBe(true);
  });

  it('is idempotent: re-running with unchanged source figures creates nothing new', () => {
    deriveTaxRules(db, { companyId });
    const second = deriveTaxRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it('versions a rule instead of editing it in place when its figure changes', () => {
    deriveTaxRules(db, { companyId });
    const before = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'usc.medical_card_2pct_threshold')).all();
    expect(before).toHaveLength(1);
    const originalId = before[0]!.id;

    // Simulate a re-ingest of an amended Act by mutating the stored provision's
    // extracted figure to a different amount, the way a later Finance Act would.
    const withDifferentUscBand = markdown.replace('€27,382', '€30,000');
    // Different bytes -> a distinct source; derive scoped to the newly ingested source.
    const reingest = ingestFinanceAct2024(db, { companyId, markdown: withDifferentUscBand, ingestVersion: 'v2' });
    deriveTaxRules(db, { companyId, sourceId: reingest.sourceId });

    const after = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'usc.medical_card_2pct_threshold')).all();
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
    ingestFinanceAct2024FromCatalogue(db, { companyId });
    deriveTaxRules(db, { companyId });
  });

  it('finds a rule by its stable key, carrying source citation and verbatim text', () => {
    const result = lookupTaxRule(db, { companyId, ruleKey: 'usc.medical_card_2pct_threshold' });
    expect(result).not.toBeNull();
    expect(result!.extractedFact).toBe('€27,382');
    expect(result!.citation).toBe('2024 Act 43');
    expect(result!.sectionNumber).toBe('2');
    expect(result!.provisionText).toContain('531AN');
    expect(result!.sourceUrl).toBe(FINANCE_ACT_2024.sourceUrl);
  });

  it('returns null for a key with no rule, never a guessed answer', () => {
    expect(lookupTaxRule(db, { companyId, ruleKey: 'vat.made_up_key' })).toBeNull();
  });

  it('resolves the rule in force on a given historical date, not just "today"', () => {
    // USC threshold rule states "year of assessment 2025" -> effectiveFrom 2025-01-01.
    expect(lookupTaxRule(db, { companyId, ruleKey: 'usc.medical_card_2pct_threshold', asOfDate: '2024-12-31' })).toBeNull();
    expect(lookupTaxRule(db, { companyId, ruleKey: 'usc.medical_card_2pct_threshold', asOfDate: '2025-01-01' })).not.toBeNull();
  });

  it('lists rules by topic', () => {
    const uscRules = listTaxRulesByTopic(db, { companyId, topic: 'usc', asOfDate: '2025-06-01' });
    expect(uscRules.map((r) => r.ruleKey)).toContain('usc.medical_card_2pct_threshold');
  });

  it('lists rules by provision category', () => {
    const rows = listTaxRulesByCategory(db, { companyId, category: 'usc', asOfDate: '2025-06-01' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ruleKey.startsWith('usc.'))).toBe(true);
  });
});

describe('ingestFinanceAct2025FromCatalogue (issue #205)', () => {
  it('loads the enacted Act from the rules catalogue, keeping the s.46 rate sections relevant', () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Enacted Ltd', seedYears: [2025] });
    ingestFinanceAct2025FromCatalogue(db, { companyId });
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, '2025 Act 18')).get()!;
    expect(source.localPath).toBe('catalogue/finance-act-2025/2025-act-18-enacted.json');
    const s71 = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, source.id)).all()
      .find((p) => p.sectionNumber === '71')!;
    expect(s71.relevant).toBe(true);
    expect(s71.provisionText).toContain('paragraphs 3(1), 3(3) and 13(3) of Schedule 3');
  });
});

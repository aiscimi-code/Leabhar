import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from './vatcaRevisedIngestion';
import { ingestVatca2010, VATCA_2010_MD_PATH } from './vatcaIngestion';
import { lookupTaxRule } from './irishRules';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s46Markdown = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rates Ltd', seedYears: [2025] }));
});

describe('ingestVatcaRevisedSection', () => {
  it('ingests s.46 under its own citation and is idempotent by content', () => {
    const first = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.sectionNumber).toBe('46');

    const second = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('2010 Act 31 s.46');
    expect(source.sourceType).toBe('legislation');
  });

  it('never collides with the as-enacted whole-Act source, even though both cite "2010 Act 31"-family text', () => {
    ingestVatca2010(db, { companyId, markdown: readFileSync(VATCA_2010_MD_PATH, 'utf8'), ingestVersion: 'v1' });
    const revised = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(revised.ingested).toBe(true);

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('2010 Act 31')).toBe(true);
    expect(citations.has('2010 Act 31 s.46')).toBe(true);
  });
});

describe('deriveVatcaRevisedRules', () => {
  beforeEach(() => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated revised rate', () => {
    const result = deriveVatcaRevisedRules(db, { companyId });
    expect(result.created).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the standard-rate rule states 23%, never the stale as-enacted 21%', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_standard_current' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(23);
    expect(rule!.unit).toBe('percent');
    expect(rule!.citation).toBe('2010 Act 31 s.46');
    expect(rule!.effectiveFrom).toBe('2021-03-01');
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      // vat.rate_hospitality_9pct_not_modelled deliberately states no figure
      // (issue #136 bug 8) — every rule that DOES claim to state a rate has one.
      if (row.ruleKey !== 'vat.rate_hospitality_9pct_not_modelled') {
        expect(row.numericValue).not.toBeNull();
      } else {
        expect(row.numericValue).toBeNull();
      }
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const second = deriveVatcaRevisedRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(VATCA_REVISED_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });
});

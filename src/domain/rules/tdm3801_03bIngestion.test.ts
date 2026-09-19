import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestTdm3801_03bCapacityExclusion, deriveTdm3801_03bCapacityExclusionRule, TDM_38_01_03B_MD_PATH } from './tdm3801_03bIngestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let markdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'TDM 3801-03b Ltd', seedYears: [2025] }));
  markdown = readFileSync(TDM_38_01_03B_MD_PATH, 'utf8');
});

describe('ingestTdm3801_03bCapacityExclusion', () => {
  it('ingests the one extracted provision under its own citation and is idempotent by content', () => {
    const first = ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(1);
    expect(first.relevantCount).toBe(1);

    const second = ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('Revenue TDM Part 38-01-03b');
    expect(source.sourceType).toBe('revenue_guidance');
  });
});

describe('deriveTdm3801_03bCapacityExclusionRule', () => {
  beforeEach(() => {
    ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown, ingestVersion: 'v1' });
  });

  it('creates the capacity exclusion rule', () => {
    const result = deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    expect(result.created).toBe(1);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the rule states the real application procedure and capacity definition, no invented criteria', () => {
    deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.mandatory_electronic_filing_capacity_exclusion' });
    expect(rule).not.toBeNull();
    expect(rule!.citation).toBe('Revenue TDM Part 38-01-03b');
    expect(rule!.statement).toContain('apply in writing');
    expect(rule!.statement).toContain('Capacity means sufficient access to the Internet');
    expect(rule!.value).toBeNull();
  });

  it('starts unreviewed with ai_suggestion provenance', () => {
    deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    const row = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'vat.mandatory_electronic_filing_capacity_exclusion')).get()!;
    expect(row.humanReviewRequired).toBe(true);
    expect(row.reviewStatus).toBe('ai_extracted');
    expect(row.provenanceStatus).toBe('ai_suggestion');
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    const second = deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it('surfaces the new rule in the existing review inbox', () => {
    deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('a VAT-registered transaction surfaces the capacity exclusion rule alongside the mandatory e-filing rule', () => {
    deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-06-15',
        amountMinor: 50000,
        description: 'Quarterly VAT3 return preparation',
        vatRegistered: true,
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.mandatory_electronic_filing_capacity_exclusion');
  });
});

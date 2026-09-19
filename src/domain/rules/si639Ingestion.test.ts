import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestSi639, deriveSi639Rules, SI_639_2010_MD_PATH } from './si639Ingestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { SI_639_CURATED_RULES } from './si639Curation';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let markdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'SI 639 Ltd', seedYears: [2025] }));
  markdown = readFileSync(SI_639_2010_MD_PATH, 'utf8');
});

describe('ingestSi639', () => {
  it('ingests all 47 regulations under its own citation and is idempotent by content', () => {
    const first = ingestSi639(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.regulationCount).toBe(47);
    expect(first.relevantCount).toBeGreaterThanOrEqual(1); // curated override for reg.25

    const second = ingestSi639(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('S.I. 639/2010');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('deriveSi639Rules', () => {
  beforeEach(() => {
    ingestSi639(db, { companyId, markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated regulation', () => {
    const result = deriveSi639Rules(db, { companyId });
    expect(result.created).toBe(SI_639_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the cash-accounting rule requires authorisation and states no stale numeric threshold', () => {
    deriveSi639Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.cash_accounting_requires_authorisation' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBeNull();
    expect(rule!.citation).toBe('S.I. 639/2010');
    expect(rule!.vatEffect).toContain('written authorisation from Revenue');
    expect(rule!.extractedFact).toBeNull();
    expect(rule!.unit).toBeNull();
  });

  it('every rule starts unreviewed with ai_suggestion provenance', () => {
    deriveSi639Rules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(SI_639_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveSi639Rules(db, { companyId });
    const second = deriveSi639Rules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(SI_639_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveSi639Rules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(SI_639_CURATED_RULES.length);
  });

  it('a cash-basis transaction description routes to the vat topic and surfaces the authorisation rule', () => {
    deriveSi639Rules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 50000,
        description: 'Switching to moneys received basis for VAT',
      },
    });
    expect(result.identifiedTopics).toContain('vat');
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.cash_accounting_requires_authorisation');
  });

  it('a routine invoice-basis transaction does not surface the cash-accounting rule', () => {
    deriveSi639Rules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 12000,
        description: 'Office stationery purchase',
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.cash_accounting_requires_authorisation');
  });
});

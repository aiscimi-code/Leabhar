import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestTca1997S284, deriveCapitalAllowancesRules } from './capitalAllowancesIngestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { CAPITAL_ALLOWANCES_CURATED_RULES } from './capitalAllowancesCuration';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Capital Allowances Ltd', seedYears: [2025] }));
});

describe('ingestTca1997S284', () => {
  it('ingests s.284 under its own citation and is idempotent by content', () => {
    const first = ingestTca1997S284(db, { companyId, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.sectionNumber).toBe('284');
    expect(first.relevantCount).toBe(1); // curated override

    const second = ingestTca1997S284(db, { companyId, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('1997 Act 39 s.284');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('deriveCapitalAllowancesRules', () => {
  beforeEach(() => {
    ingestTca1997S284(db, { companyId, ingestVersion: 'v1' });
  });

  it('creates one rule per curated capital allowance', () => {
    const result = deriveCapitalAllowancesRules(db, { companyId });
    expect(result.created).toBe(CAPITAL_ALLOWANCES_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the wear-and-tear rule never states a numeric rate', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'income_tax.wear_and_tear_allowance_qualifies' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBeNull();
    expect(rule!.taxEffect).toContain('NOT determined by this rule');
    expect(rule!.citation).toBe('1997 Act 39 s.284');
  });

  it('every rule starts unreviewed with ai_suggestion provenance', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(CAPITAL_ALLOWANCES_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const second = deriveCapitalAllowancesRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(CAPITAL_ALLOWANCES_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(CAPITAL_ALLOWANCES_CURATED_RULES.length);
  });

  it('a machinery purchase routes to the capital_allowances topic and surfaces the qualification rule', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 500000,
        description: 'Purchase of new machinery for the workshop',
        businessUsePercent: 100,
        isCapitalExpenditure: true,
      },
    });
    expect(result.identifiedTopics).toContain('capital_allowances');
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('income_tax.wear_and_tear_allowance_qualifies');
  });

  it('a routine office-supplies purchase does not route to capital_allowances', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 2000,
        description: 'Printer paper and pens',
      },
    });
    expect(result.identifiedTopics).not.toContain('capital_allowances');
  });
});

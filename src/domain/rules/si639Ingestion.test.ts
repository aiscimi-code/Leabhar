import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestSi639FromCatalogue, deriveSi639Rules } from './si639Ingestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { SI_639_CURATED_RULES } from './si639Curation';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'SI 639 Ltd', seedYears: [2025] }));
});

describe('ingestSi639FromCatalogue', () => {
  it('ingests all 47 regulations under its own citation and is idempotent by content', () => {
    const first = ingestSi639FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(47);
    const relevant = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, first.sourceId)).all().filter((p) => p.relevant);
    expect(relevant.length).toBeGreaterThanOrEqual(1); // curated override for reg.25

    const second = ingestSi639FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('S.I. 639/2010');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('deriveSi639Rules', () => {
  beforeEach(() => {
    ingestSi639FromCatalogue(db, { companyId });
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

  it('a cash_receipts company profile routes to the vat topic and surfaces the authorisation rule', () => {
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

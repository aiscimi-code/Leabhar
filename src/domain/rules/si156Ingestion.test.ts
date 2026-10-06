import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestSi156FromCatalogue, deriveSi156Rules } from './si156Ingestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { SI_156_CURATED_RULES } from './si156Curation';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'SI 156 Ltd', seedYears: [2025] }));
});

describe('ingestSi156FromCatalogue', () => {
  it('ingests only regs 1, 2 and 4 under its own citation and is idempotent by content', () => {
    const first = ingestSi156FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(3);
    const relevant = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, first.sourceId)).all().filter((p) => p.relevant);
    expect(relevant.length).toBe(1); // curated override for reg.4

    const second = ingestSi156FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('S.I. 156/2012');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('deriveSi156Rules', () => {
  beforeEach(() => {
    ingestSi156FromCatalogue(db, { companyId });
  });

  it('creates one rule for the mandatory electronic filing obligation', () => {
    const result = deriveSi156Rules(db, { companyId });
    expect(result.created).toBe(SI_156_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the mandatory e-filing rule states no numeric figure and flags the un-curated capacity exclusion', () => {
    deriveSi156Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.mandatory_electronic_filing' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBeNull();
    expect(rule!.citation).toBe('S.I. 156/2012');
    expect(rule!.vatEffect).toContain('mandatory');
  });

  it('every rule starts unreviewed with ai_suggestion provenance', () => {
    deriveSi156Rules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(SI_156_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveSi156Rules(db, { companyId });
    const second = deriveSi156Rules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(SI_156_CURATED_RULES.length);
  });

  it('surfaces the new rule in the existing review inbox', () => {
    deriveSi156Rules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(SI_156_CURATED_RULES.length);
  });

  it('a VAT-registered transaction context surfaces the mandatory e-filing rule', () => {
    deriveSi156Rules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 50000,
        description: 'Quarterly VAT3 return preparation',
        vatRegistered: true,
      },
    });
    expect(result.identifiedTopics).toContain('vat');
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.mandatory_electronic_filing');
  });

  it('a transaction with no VAT registration does not surface the mandatory e-filing rule', () => {
    deriveSi156Rules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 12000,
        description: 'Office stationery purchase',
        vatRegistered: false,
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.mandatory_electronic_filing');
  });
});

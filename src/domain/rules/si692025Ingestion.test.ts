import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestSi692025Reg5, ingestSi692025Reg7, ingestSi692025Reg8, ingestSi692025Reg9, deriveSi692025Rules,
  SI_69_2025_MD_PATH,
} from './si692025Ingestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let markdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'SI 69 Ltd', seedYears: [2025] }));
  markdown = readFileSync(SI_69_2025_MD_PATH, 'utf8');
});

describe('ingestSi692025Reg8', () => {
  it('ingests regulation 8 under its own citation and is idempotent by content', () => {
    const first = ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.regulationCount).toBe(1);
    expect(first.relevantCount).toBe(1);

    const second = ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('S.I. 69/2025');
    expect(source.sourceType).toBe('legislation');
    expect(source.effectiveFrom).toBe('2025-03-06');
  });
});

describe('ingestSi692025Reg5 / ingestSi692025Reg7 / ingestSi692025Reg9 (share one source document with reg.8)', () => {
  it('reg.5, reg.7 and reg.9 each get their own provision row under the shared S.I. 69/2025 source', () => {
    const reg8 = ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1' });
    const reg5 = ingestSi692025Reg5(db, { companyId, markdown, ingestVersion: 'v1' });
    const reg7 = ingestSi692025Reg7(db, { companyId, markdown, ingestVersion: 'v1' });
    const reg9 = ingestSi692025Reg9(db, { companyId, markdown, ingestVersion: 'v1' });

    // Same physical instrument, same content hash -> one shared knowledge-source row.
    expect(reg5.sourceId).toBe(reg8.sourceId);
    expect(reg7.sourceId).toBe(reg8.sourceId);
    expect(reg9.sourceId).toBe(reg8.sourceId);
    expect(reg5.ingested).toBe(true);
    expect(reg7.ingested).toBe(true);
    expect(reg9.ingested).toBe(true);

    const provisions = db.select({ sectionNumber: irishActProvisions.sectionNumber })
      .from(irishActProvisions).where(eq(irishActProvisions.sourceId, reg8.sourceId)).all();
    expect(provisions.map((p) => p.sectionNumber).sort()).toEqual(['5', '7', '8', '9']);
  });

  it('ingesting reg.5 or reg.9 a second time is idempotent, independently of the other regulations', () => {
    ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1' });
    const first = ingestSi692025Reg5(db, { companyId, markdown, ingestVersion: 'v1' });
    const second = ingestSi692025Reg5(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(false);
  });

  it('order of ingestion does not matter — reg.9 first still gets its own row when reg.8 has not been ingested yet', () => {
    const reg9 = ingestSi692025Reg9(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(reg9.ingested).toBe(true);
    const provisions = db.select({ sectionNumber: irishActProvisions.sectionNumber })
      .from(irishActProvisions).where(eq(irishActProvisions.sourceId, reg9.sourceId)).all();
    expect(provisions.map((p) => p.sectionNumber)).toEqual(['9']);
  });
});

describe('deriveSi692025Rules', () => {
  beforeEach(() => {
    ingestSi692025Reg5(db, { companyId, markdown, ingestVersion: 'v1' });
    ingestSi692025Reg7(db, { companyId, markdown, ingestVersion: 'v1' });
    ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1' });
    ingestSi692025Reg9(db, { companyId, markdown, ingestVersion: 'v1' });
  });

  it('creates every curated rule once all four regulations are ingested', () => {
    const result = deriveSi692025Rules(db, { companyId });
    expect(result.created).toBe(SI_69_2025_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('skips a rule whose regulation was not ingested', () => {
    const { db: freshDb } = createTestDatabase();
    const { companyId: freshCompanyId } = createCompany(freshDb, { legalName: 'Reg8 Only Ltd', seedYears: [2025] });
    ingestSi692025Reg8(freshDb, { companyId: freshCompanyId, markdown, ingestVersion: 'v1' });
    const result = deriveSi692025Rules(freshDb, { companyId: freshCompanyId });
    expect(result.created).toBe(2); // only the two reg.8 rules
    expect(result.skippedNoProvision).toEqual(
      expect.arrayContaining([
        'vat.registration_threshold_turnover_test',
        'vat.annual_turnover_definition',
        'vat.cross_border_sme_scheme_input_deductibility_restriction',
        'vat.cross_border_sme_scheme_union_threshold',
      ]),
    );
  });

  it('the €2,000,000 turnover threshold rule states the real current figure in integer minor units', () => {
    deriveSi692025Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.cash_accounting_turnover_threshold' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(200_000_000); // €2,000,000 in cents
    expect(rule!.unit).toBe('eur_minor');
    expect(rule!.citation).toBe('S.I. 69/2025');
    expect(rule!.effectiveFrom).toBe('2025-03-06');
  });

  it('the 90% supplies-to-unregistered-persons test rule states the real current figure', () => {
    deriveSi692025Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.cash_accounting_supplies_to_unregistered_persons_test' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(90);
    expect(rule!.unit).toBe('percent');
  });

  describe('issue #130: regulation 7 deductibility restriction + the union threshold', () => {
    it('the cross-border SME scheme deductibility restriction rule resolves, with no numeric value', () => {
      deriveSi692025Rules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.cross_border_sme_scheme_input_deductibility_restriction' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBeNull();
      expect(rule!.citation).toBe('S.I. 69/2025');
    });

    it('the union threshold rule states €100,000 in integer minor units', () => {
      deriveSi692025Rules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.cross_border_sme_scheme_union_threshold' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBe(10_000_000); // €100,000 in cents
      expect(rule!.unit).toBe('eur_minor');
    });
  });

  it('every rule starts unreviewed with ai_suggestion provenance', () => {
    deriveSi692025Rules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(SI_69_2025_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveSi692025Rules(db, { companyId });
    const second = deriveSi692025Rules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(SI_69_2025_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveSi692025Rules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(SI_69_2025_CURATED_RULES.length);
  });

  it('a cash-basis transaction description surfaces both eligibility threshold rules', () => {
    deriveSi692025Rules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 50000,
        description: 'Applying for cash basis VAT accounting',
      },
    });
    expect(result.identifiedTopics).toContain('vat');
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).toContain('vat.cash_accounting_turnover_threshold');
    expect(keys).toContain('vat.cash_accounting_supplies_to_unregistered_persons_test');
  });
});

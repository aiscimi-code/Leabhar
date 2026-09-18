import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH, VATCA_2010 } from './vatcaIngestion';
import { lookupTaxRule, ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { VATCA_CURATED_RULES } from './vatcaCuration';
import { irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const markdown = readFileSync(VATCA_2010_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'VATCA Ltd', seedYears: [2025] }));
});

describe('ingestVatca2010', () => {
  it('ingests the body sections and is idempotent by content', () => {
    const first = ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBeGreaterThan(100);
    expect(first.relevantCount).toBeGreaterThan(0);

    const second = ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it('tags the source as legislation with its own citation, distinct from the Finance Act', () => {
    ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(VATCA_2010.sourceType).toBe('legislation');
    expect(VATCA_2010.citation).toBe('2010 Act 31');
  });
});

describe('deriveVatcaRules', () => {
  beforeEach(() => {
    ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated section', () => {
    const result = deriveVatcaRules(db, { companyId });
    expect(result.created).toBe(VATCA_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveVatcaRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(VATCA_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      expect(row.statement).toBeTruthy();
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveVatcaRules(db, { companyId });
    const second = deriveVatcaRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(VATCA_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveVatcaRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(VATCA_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });

  it('the reverse-charge rule is findable by its stable key with correct source citation', () => {
    deriveVatcaRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.reverse_charge_services_from_abroad' });
    expect(rule).not.toBeNull();
    expect(rule!.sectionNumber).toBe('12');
    expect(rule!.citation).toBe('2010 Act 31');
    expect(rule!.provisionText).toContain('supplier established outside the State');
  });

  it('never matches a curated section number against a DIFFERENT source\'s provision with the same number', () => {
    // Regression test: both the Finance Act 2024 and VATCA 2010 have their own
    // "section 3", "section 12", etc. Deriving VATCA's rules must resolve
    // against VATCA's own provisions, not whichever source's row for that
    // section number happens to be in the table first.
    const financeActMd = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
    ingestFinanceAct2024(db, { companyId, markdown: financeActMd, ingestVersion: 'v1' });
    deriveTaxRules(db, { companyId });

    const result = deriveVatcaRules(db, { companyId });
    expect(result.created).toBe(VATCA_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);

    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.charge_general' });
    expect(rule).not.toBeNull();
    expect(rule!.citation).toBe('2010 Act 31'); // not '2024 Act 43'
    expect(rule!.provisionText).toContain('value-added tax');
  });
});

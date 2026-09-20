import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestCompaniesAct2014Section, ingestAllCompaniesAct2014Sections, deriveCompaniesAct2014Rules,
  COMPANIES_ACT_2014_SECTION_NUMBERS,
} from './companiesAct2014Ingestion';
import { companiesAct2014SectionPath } from './companiesAct2014SectionParser';
import { lookupTaxRule } from './irishRules';
import { COMPANIES_ACT_2014_CURATED_RULES } from './companiesAct2014Curation';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s280aMarkdown = readFileSync(companiesAct2014SectionPath('280A'), 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Filing Ltd', seedYears: [2025] }));
});

describe('ingestCompaniesAct2014Section', () => {
  it('ingests s.280A under its own citation and is idempotent by content', () => {
    const first = ingestCompaniesAct2014Section(db, { companyId, markdown: s280aMarkdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.sectionNumber).toBe('280A');

    const second = ingestCompaniesAct2014Section(db, { companyId, markdown: s280aMarkdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('2014 Act 38 s.280A');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('ingestAllCompaniesAct2014Sections', () => {
  it('ingests all eight fetched sections, each under its own citation', () => {
    const result = ingestAllCompaniesAct2014Sections(db, { companyId, ingestVersion: 'v1' });
    expect(result.sections).toHaveLength(COMPANIES_ACT_2014_SECTION_NUMBERS.length);
    expect(result.sections.every((s) => s.ingested)).toBe(true);

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    for (const n of COMPANIES_ACT_2014_SECTION_NUMBERS) {
      expect(citations.has(`2014 Act 38 s.${n}`)).toBe(true);
    }
  });
});

describe('deriveCompaniesAct2014Rules', () => {
  beforeEach(() => {
    ingestAllCompaniesAct2014Sections(db, { companyId, ingestVersion: 'v1' });
  });

  it('creates one rule per curated Companies Act 2014 rule', () => {
    const result = deriveCompaniesAct2014Rules(db, { companyId });
    expect(result.created).toBe(COMPANIES_ACT_2014_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the small-company turnover rule states €15,000,000 in integer minor units, never a bare number', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'company.small_company_turnover_threshold' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(1_500_000_000);
    expect(rule!.unit).toBe('eur_minor');
    expect(rule!.citation).toBe('2014 Act 38 s.280A');
  });

  it('the small-company employee-count rule states a plain count, not currency', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'company.small_company_employee_threshold' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(50);
    expect(rule!.unit).toBe('count');
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(COMPANIES_ACT_2014_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      // Declaratory facts this KB has no company-level field to test — see
      // companiesAct2014Curation.ts's own header.
      expect(row.conditions).toEqual([]);
    }
  });

  it('none of these rules is routed to by identifyTopics, so they never pollute a transaction lookup', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const rows = db.select({ topic: irishTaxRules.topic }).from(irishTaxRules)
      .where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.every((r) => r.topic === 'company_filing_reference')).toBe(true);
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const second = deriveCompaniesAct2014Rules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(COMPANIES_ACT_2014_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveCompaniesAct2014Rules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(COMPANIES_ACT_2014_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });
});

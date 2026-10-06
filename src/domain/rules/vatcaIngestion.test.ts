import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010, ingestVatca2010FromCatalogue, deriveVatcaRules, VATCA_2010 } from './vatcaIngestion';
import { lookupTaxRule, ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { VATCA_CURATED_RULES } from './vatcaCuration';
import { irishKnowledgeSources, irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
/** A Markdown copy, as the CLI's --file takes: ss.33-35 as convert-statute-pdf.ts converts them. */
const markdown = readFileSync(new URL('./__fixtures__/vatca-2010-enacted-excerpt.md', import.meta.url), 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'VATCA Ltd', seedYears: [2025] }));
});

describe('ingestVatca2010FromCatalogue', () => {
  it('loads the body sections from the catalogue and is idempotent', () => {
    const first = ingestVatca2010FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(125);

    const second = ingestVatca2010FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it('tags the source as legislation with its own citation and commencement, distinct from the Finance Act', () => {
    const { sourceId } = ingestVatca2010FromCatalogue(db, { companyId });
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get()!;
    expect(source.sourceType).toBe('legislation');
    expect(source.citation).toBe('2010 Act 31');
    expect(source.citation).toBe(VATCA_2010.citation);
    // The Act's own commencement, never the day the PDF was fetched.
    expect(source.effectiveFrom).toBe(VATCA_2010.enactedDate);
    expect(source.publicationDate).toBe(VATCA_2010.enactedDate);
    expect(source.sourceNote).toContain('Enacted text only');
    expect(source.localPath).toBe('catalogue/vatca-2010/vatca-2010-enacted.json');
  });
});

describe('ingestVatca2010 (a Markdown copy, for the CLI)', () => {
  it('ingests the sections it holds and is idempotent by content', () => {
    const first = ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(3);
    expect(first.relevantCount).toBeGreaterThan(0);

    const second = ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });
});

describe('deriveVatcaRules', () => {
  beforeEach(() => {
    ingestVatca2010FromCatalogue(db, { companyId });
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

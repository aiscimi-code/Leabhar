import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestTca1997S530, ingestTca1997S530A, ingestTca1997S530FromCatalogue, ingestTca1997RctFa2011SectionFromCatalogue,
  ingestRctTdm18_02_04, ingestRctTdmFromCatalogue, deriveRctRules,
  RCT_FA2011_SECTIONS, type RctFa2011SectionKey,
} from './rctIngestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { RCT_CURATED_RULES } from './rctCuration';
import { irishTaxRules, irishKnowledgeSources, irishActProvisions, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
/** Markdown copies, as the CLI's --file takes: the openings of s.530 and s.530A. */
const s530Markdown = readFileSync(new URL('./__fixtures__/tca-1997-s530-excerpt.md', import.meta.url), 'utf8');
const s530AMarkdown = readFileSync(new URL('./__fixtures__/tca-1997-s530A-excerpt.md', import.meta.url), 'utf8');
const FA2011_KEYS = Object.keys(RCT_FA2011_SECTIONS) as RctFa2011SectionKey[];
/** A Markdown copy of TDM 18-02-04 (front matter, title, first page), as the CLI's --file takes. */
const tdmMarkdown = readFileSync(new URL('./__fixtures__/tdm-18-02-04-excerpt.md', import.meta.url), 'utf8');

function ingestFa2011Sections(): void {
  for (const key of FA2011_KEYS) ingestTca1997RctFa2011SectionFromCatalogue(db, key, { companyId });
}

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'RCT Ltd', seedYears: [2025] }));
});

describe('ingestTca1997S530FromCatalogue', () => {
  it('loads s.530 under its own citation, dated as enacted, and is idempotent', () => {
    const first = ingestTca1997S530FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(1);
    expect(ingestTca1997S530FromCatalogue(db, { companyId })).toMatchObject({ ingested: false, sourceId: first.sourceId });
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source).toMatchObject({
      citation: '1997 Act 39 s.530', sourceType: 'legislation', effectiveFrom: '1997-01-01', localPath: 'catalogue/tca-1997/s530.json',
    });
  });
});

describe('ingestTca1997S530 (a Markdown copy, the CLI\'s --file)', () => {
  it('ingests s.530 under its own citation and is idempotent by content', () => {
    const first = ingestTca1997S530(db, { companyId, markdown: s530Markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(1);
    expect(first.relevantCount).toBe(1);

    const second = ingestTca1997S530(db, { companyId, markdown: s530Markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('1997 Act 39 s.530');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('ingestTca1997S530A / S530E / S530G / S530H / S530I (issue #131)', () => {
  it('each gets its own citation and knowledge-source row, even though all six share one physical FA 2011 s.20 page', () => {
    const results = FA2011_KEYS.map((key) => ingestTca1997RctFa2011SectionFromCatalogue(db, key, { companyId }));
    for (const r of results) expect(r.ingested).toBe(true);

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('1997 Act 39 s.530A')).toBe(true);
    expect(citations.has('1997 Act 39 s.530E')).toBe(true);
    expect(citations.has('1997 Act 39 s.530G')).toBe(true);
    expect(citations.has('1997 Act 39 s.530H')).toBe(true);
    expect(citations.has('1997 Act 39 s.530I')).toBe(true);
    expect(new Set(results.map((r) => r.sourceId)).size).toBe(5);
    // Each entry keeps the same page, the one the inserting Act was read from.
    expect(new Set(sources.filter((s) => s.citation.startsWith('1997 Act 39 s.530')).map((s) => s.sha256)).size).toBe(1);
  });

  it('loading the same section twice is idempotent', () => {
    const first = ingestTca1997RctFa2011SectionFromCatalogue(db, 'tca1997_s530e', { companyId });
    const second = ingestTca1997RctFa2011SectionFromCatalogue(db, 'tca1997_s530e', { companyId });
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it('a Markdown copy (the CLI\'s --file) is ingested idempotently by content', () => {
    const first = ingestTca1997S530A(db, { companyId, markdown: s530AMarkdown, ingestVersion: 'v1' });
    const second = ingestTca1997S530A(db, { companyId, markdown: s530AMarkdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it('every section is tagged legislation, not revenue_guidance', () => {
    ingestTca1997RctFa2011SectionFromCatalogue(db, 'tca1997_s530g', { companyId });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, '1997 Act 39 s.530G')).get()!;
    expect(source.sourceType).toBe('legislation');
  });
});

describe('ingestRctTdmFromCatalogue', () => {
  it('loads the manual as revenue_guidance, one whole-document provision, and is idempotent', () => {
    const first = ingestRctTdmFromCatalogue(db, 'tdm_18_02_04', { companyId });
    expect(first).toMatchObject({ ingested: true, provisionCount: 1 });
    expect(ingestRctTdmFromCatalogue(db, 'tdm_18_02_04', { companyId })).toMatchObject({ ingested: false, sourceId: first.sourceId });
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source).toMatchObject({
      citation: 'Revenue TDM Part 18-02-04', sourceType: 'revenue_guidance', title: 'TDM Part 18-02-04 RCT for Principal Contractors',
      effectiveFrom: '2012-01-01', localPath: 'catalogue/rct/tdm-18-02-04.json',
    });
  });
});

describe('ingestRctTdm18_02_04 (a Markdown copy, the CLI\'s --file)', () => {
  it('ingests the TDM as legislation-distinct revenue_guidance and is idempotent by content', () => {
    const first = ingestRctTdm18_02_04(db, { companyId, markdown: tdmMarkdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.provisionCount).toBe(1);

    const second = ingestRctTdm18_02_04(db, { companyId, markdown: tdmMarkdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('Revenue TDM Part 18-02-04');
    expect(source.sourceType).toBe('revenue_guidance');
  });
});

describe('ingestRctTdm18_02_05 / ingestRctTdm18_02_11', () => {
  it('ingest each as its own revenue_guidance source, distinct from 18-02-04', () => {
    const tdm04 = ingestRctTdmFromCatalogue(db, 'tdm_18_02_04', { companyId });
    const tdm05 = ingestRctTdmFromCatalogue(db, 'tdm_18_02_05', { companyId });
    const tdm11 = ingestRctTdmFromCatalogue(db, 'tdm_18_02_11', { companyId });

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('Revenue TDM Part 18-02-04')).toBe(true);
    expect(citations.has('Revenue TDM Part 18-02-05')).toBe(true);
    expect(citations.has('Revenue TDM Part 18-02-11')).toBe(true);
    expect(new Set([tdm04.sourceId, tdm05.sourceId, tdm11.sourceId]).size).toBe(3);
  });

  it('18-02-11 is ingested for citability but not currently curated into a rule, so it is not marked relevant', () => {
    const result = ingestRctTdmFromCatalogue(db, 'tdm_18_02_11', { companyId });
    expect(result.ingested).toBe(true);
    expect(db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, result.sourceId)).get()!.relevant).toBe(false);
  });
});

describe('deriveRctRules', () => {
  beforeEach(() => {
    ingestTca1997S530FromCatalogue(db, { companyId });
    ingestFa2011Sections();
    ingestRctTdmFromCatalogue(db, 'tdm_18_02_04', { companyId });
    ingestRctTdmFromCatalogue(db, 'tdm_18_02_05', { companyId });
  });

  it('creates one rule per curated RCT rule, resolved against the correct source for each', () => {
    const result = deriveRctRules(db, { companyId });
    expect(result.created).toBe(RCT_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveRctRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(RCT_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      expect(row.requiresGuidance).toBe(true);
      expect(row.statement).toBeTruthy();
    }
  });

  it('the deduction-rate rule states the rate is not determinable, never a guessed number', () => {
    deriveRctRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.deduction_rate_not_determinable' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBeNull();
    expect(rule!.taxEffect).toContain('never stated');
    // Re-sourced from the actual statute (issue #131), not just the TDM paraphrase.
    expect(rule!.citation).toBe('1997 Act 39 s.530I');
  });

  describe('issue #131: the real 0%/standard/35% rate structure', () => {
    it('the zero rate states a real 0% figure, sourced from s.530E', () => {
      deriveRctRules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.rate_zero' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBe(0);
      expect(rule!.unit).toBe('percent');
      expect(rule!.citation).toBe('1997 Act 39 s.530E');
    });

    it('the 35% default rate states a real figure, sourced from s.530E', () => {
      deriveRctRules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.rate_default_35pct' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBe(35);
      expect(rule!.unit).toBe('percent');
    });

    it('the standard-rate reference states no numeric value (TCA 1997 s.3 is not ingested)', () => {
      deriveRctRules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.rate_standard_reference' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBeNull();
      expect(rule!.qualifier).toContain('section 3');
    });

    it('the zero-rate and standard-rate subcontractor criteria resolve to their real statute sections', () => {
      deriveRctRules(db, { companyId });
      const zero = lookupTaxRule(db, { companyId, ruleKey: 'rct.zero_rate_subcontractor_criteria' });
      const standard = lookupTaxRule(db, { companyId, ruleKey: 'rct.standard_rate_subcontractor_criteria' });
      expect(zero).not.toBeNull();
      expect(zero!.citation).toBe('1997 Act 39 s.530G');
      expect(standard).not.toBeNull();
      expect(standard!.citation).toBe('1997 Act 39 s.530H');
    });

    it('the rate-determination procedure and principal-scope rules resolve to their real statute sections', () => {
      deriveRctRules(db, { companyId });
      const procedure = lookupTaxRule(db, { companyId, ruleKey: 'rct.rate_determination_and_appeal_procedure' });
      const principal = lookupTaxRule(db, { companyId, ruleKey: 'rct.principal_obligation_scope' });
      expect(procedure).not.toBeNull();
      expect(procedure!.citation).toBe('1997 Act 39 s.530I');
      expect(principal).not.toBeNull();
      expect(principal!.citation).toBe('1997 Act 39 s.530A');
    });
  });

  it('the scope rule resolves to the legislation source, not the TDM', () => {
    deriveRctRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.relevant_operations_scope' });
    expect(rule).not.toBeNull();
    expect(rule!.citation).toBe('1997 Act 39 s.530');
    expect(rule!.provisionText).toContain('construction operations');
  });

  it('the compliance-criteria rule resolves to TDM 18-02-05, describes criteria without evaluating them', () => {
    deriveRctRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'rct.subcontractor_compliance_criteria' });
    expect(rule).not.toBeNull();
    expect(rule!.citation).toBe('Revenue TDM Part 18-02-05');
    expect(rule!.taxEffect).toContain('previous 3 years');
    expect(rule!.value).toBeNull();
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveRctRules(db, { companyId });
    const second = deriveRctRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(RCT_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveRctRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(RCT_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });

  it('a construction-invoice transaction is routed to the rct topic and surfaces every curated rule for review', () => {
    deriveRctRules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 500000,
        description: 'Subcontractor payment for construction works on site',
      },
    });
    expect(result.identifiedTopics).toContain('rct');
    const ruleKeys = result.applicableRules.map((r) => r.ruleKey);
    expect(ruleKeys).toEqual(expect.arrayContaining([
      'rct.relevant_operations_scope', 'rct.principal_obligation_scope', 'rct.payment_notification_required',
      'rct.deduction_rate_not_determinable', 'rct.rate_zero', 'rct.rate_standard_reference',
      'rct.rate_default_35pct', 'rct.zero_rate_subcontractor_criteria', 'rct.standard_rate_subcontractor_criteria',
      'rct.rate_determination_and_appeal_procedure', 'rct.subcontractor_compliance_criteria',
    ]));
    expect(ruleKeys.length).toBe(RCT_CURATED_RULES.length);
    expect(result.reviewRequired).toBe(true);
  });

  it('an unrelated transaction (e.g. a software subscription) is not routed to the rct topic', () => {
    deriveRctRules(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 2000,
        description: 'Monthly SaaS subscription',
      },
    });
    expect(result.identifiedTopics).not.toContain('rct');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestTca1997S530, ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11, deriveRctRules,
  TCA_1997_S530_MD_PATH,
} from './rctIngestion';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { RCT_CURATED_RULES } from './rctCuration';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s530Markdown = readFileSync(TCA_1997_S530_MD_PATH, 'utf8');
const tdmMarkdown = readFileSync(
  new URL('../../../docs/statutes/rct/tdm-18-02-04.md', import.meta.url).pathname,
  'utf8',
);
const tdm05Markdown = readFileSync(
  new URL('../../../docs/statutes/rct/tdm-18-02-05.md', import.meta.url).pathname,
  'utf8',
);
const tdm11Markdown = readFileSync(
  new URL('../../../docs/statutes/rct/tdm-18-02-11.md', import.meta.url).pathname,
  'utf8',
);

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'RCT Ltd', seedYears: [2025] }));
});

describe('ingestTca1997S530', () => {
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

describe('ingestRctTdm18_02_04', () => {
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
    const tdm04 = ingestRctTdm18_02_04(db, { companyId, markdown: tdmMarkdown, ingestVersion: 'v1' });
    const tdm05 = ingestRctTdm18_02_05(db, { companyId, markdown: tdm05Markdown, ingestVersion: 'v1' });
    const tdm11 = ingestRctTdm18_02_11(db, { companyId, markdown: tdm11Markdown, ingestVersion: 'v1' });

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('Revenue TDM Part 18-02-04')).toBe(true);
    expect(citations.has('Revenue TDM Part 18-02-05')).toBe(true);
    expect(citations.has('Revenue TDM Part 18-02-11')).toBe(true);
    expect(new Set([tdm04.sourceId, tdm05.sourceId, tdm11.sourceId]).size).toBe(3);
  });

  it('18-02-11 is ingested for citability but not currently curated into a rule, so it is not marked relevant', () => {
    const result = ingestRctTdm18_02_11(db, { companyId, markdown: tdm11Markdown, ingestVersion: 'v1' });
    expect(result.ingested).toBe(true);
    expect(result.relevantCount).toBe(0);
  });
});

describe('deriveRctRules', () => {
  beforeEach(() => {
    ingestTca1997S530(db, { companyId, markdown: s530Markdown, ingestVersion: 'v1' });
    ingestRctTdm18_02_04(db, { companyId, markdown: tdmMarkdown, ingestVersion: 'v1' });
    ingestRctTdm18_02_05(db, { companyId, markdown: tdm05Markdown, ingestVersion: 'v1' });
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
    expect(rule!.citation).toBe('Revenue TDM Part 18-02-04');
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

  it('a construction-invoice transaction is routed to the rct topic and surfaces all four rules for review', () => {
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
      'rct.relevant_operations_scope', 'rct.payment_notification_required', 'rct.deduction_rate_not_determinable',
      'rct.subcontractor_compliance_criteria',
    ]));
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

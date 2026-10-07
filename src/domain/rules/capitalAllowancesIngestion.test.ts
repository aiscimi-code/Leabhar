import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestTca1997S284FromCatalogue, ingestFinanceAct2003S23FromCatalogue, deriveCapitalAllowancesRules,
  TCA_1997_S284_CATALOGUE_ENTRY, FINANCE_ACT_2003_S23_CATALOGUE_ENTRY,
} from './capitalAllowancesIngestion';
import { readCatalogueEntry } from './catalogue';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { CAPITAL_ALLOWANCES_CURATED_RULES } from './capitalAllowancesCuration';
import { irishTaxRules, irishKnowledgeSources, irishActProvisions, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Capital Allowances Ltd', seedYears: [2025] }));
});

const provisionOf = (sourceId: string) => db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).get()!;

describe('ingestTca1997S284FromCatalogue', () => {
  it('loads s.284 under its own citation and is idempotent', () => {
    const first = ingestTca1997S284FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(provisionOf(first.sourceId)).toMatchObject({ sectionNumber: '284', relevant: true }); // curated override

    const second = ingestTca1997S284FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('1997 Act 39 s.284');
    expect(source.sourceType).toBe('legislation');
  });
});

describe('ingestFinanceAct2003S23FromCatalogue (issue #132)', () => {
  it('loads s.23 under its own citation, distinct from TCA 1997 s.284, and is idempotent', () => {
    const first = ingestFinanceAct2003S23FromCatalogue(db, { companyId });
    expect(first.ingested).toBe(true);
    expect(provisionOf(first.sourceId)).toMatchObject({ sectionNumber: '23', relevant: true, amendsSection: '284' }); // curated

    const second = ingestFinanceAct2003S23FromCatalogue(db, { companyId });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('2003 Act 3 s.23');
    expect(source.sourceType).toBe('legislation');
    expect(source.effectiveFrom).toBe('2002-12-04');
  });
});

describe('deriveCapitalAllowancesRules', () => {
  beforeEach(() => {
    ingestTca1997S284FromCatalogue(db, { companyId });
    ingestFinanceAct2003S23FromCatalogue(db, { companyId });
  });

  it('creates one rule per curated capital allowance', () => {
    const result = deriveCapitalAllowancesRules(db, { companyId });
    expect(result.created).toBe(CAPITAL_ALLOWANCES_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the qualification rule never states a numeric rate, and points to the rate rule instead', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'income_tax.wear_and_tear_allowance_qualifies' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBeNull();
    expect(rule!.taxEffect).toContain('income_tax.wear_and_tear_rate_current');
    expect(rule!.citation).toBe('1997 Act 39 s.284');
  });

  it('issue #132: the current wear-and-tear rate rule states 12.5% from Finance Act 2003 s.23', () => {
    deriveCapitalAllowancesRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'income_tax.wear_and_tear_rate_current' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(12.5);
    expect(rule!.unit).toBe('percent');
    expect(rule!.citation).toBe('2003 Act 3 s.23');
    expect(rule!.effectiveFrom).toBe('2002-12-04');
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

  it('a machinery purchase routes to the capital_allowances topic and surfaces both the qualification and rate rules', () => {
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
    const ruleKeys = result.applicableRules.map((r) => r.ruleKey);
    expect(ruleKeys).toEqual(expect.arrayContaining([
      'income_tax.wear_and_tear_allowance_qualifies', 'income_tax.wear_and_tear_rate_current',
    ]));
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

describe('issue #132: statementExcerpt verbatim check', () => {
  it('every curated rule\'s statement excerpt is a verbatim substring of its own source\'s parsed text', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const entriesBySection: Record<string, string> = {
      '284': TCA_1997_S284_CATALOGUE_ENTRY,
      '23': FINANCE_ACT_2003_S23_CATALOGUE_ENTRY,
    };
    for (const rule of CAPITAL_ALLOWANCES_CURATED_RULES) {
      const entry = entriesBySection[rule.sectionNumber];
      expect(entry, `${rule.ruleKey}: no source mapped for section ${rule.sectionNumber}`).toBeDefined();
      const text = norm(readCatalogueEntry(entry!).provisions[0]!.excerpt);
      expect(text, `${rule.ruleKey}: statementExcerpt must be verbatim against s.${rule.sectionNumber}`)
        .toContain(norm(rule.statementExcerpt));
    }
  });
});

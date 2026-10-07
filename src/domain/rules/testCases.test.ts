import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024FromCatalogue, deriveTaxRules } from './irishRules';
import { generateDefaultTestCases, runTestCases as runStoredTestCases } from './testCases';
import { attachRulesStoreFromBook } from './rulesStore';
import { irishTaxRules, irishTaxRuleTests } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Test Cases Ltd', seedYears: [2025] }));
  ingestFinanceAct2024FromCatalogue(db, { companyId });
  deriveTaxRules(db, { companyId });
});

/** Run the cases against a store built from what this book derived and generated (ADR-0021: readers read the store). */
function runTestCases(database: AppDatabase, params: { companyId: string }) {
  attachRulesStoreFromBook(database, params);
  return runStoredTestCases(database, params);
}

describe('generateDefaultTestCases / runTestCases', () => {
  it('writes an effective-date case per active rule, and all pass', () => {
    const gen = generateDefaultTestCases(db, { companyId });
    expect(gen.created).toBe(2); // 2 curated rules x 1 case each
    expect(gen.skipped).toBe(0);
    expect(db.select().from(irishTaxRuleTests).all().map((t) => t.testType)).toEqual(['effective_date', 'effective_date']);

    const run = runTestCases(db, { companyId });
    expect(run.total).toBe(2);
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(2);
  });

  it('is idempotent: a second generate call skips rules that already have cases', () => {
    generateDefaultTestCases(db, { companyId });
    const second = generateDefaultTestCases(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('a genuinely broken rule shows up as a failing test, not a silent pass', () => {
    generateDefaultTestCases(db, { companyId });
    // Sabotage: move a rule's start a year earlier after its case was
    // generated, so it applies on the day its case says it must not.
    db.update(irishTaxRules).set({ effectiveFrom: '2024-01-01' })
      .where(eq(irishTaxRules.ruleKey, 'usc.medical_card_2pct_threshold')).run();

    const run = runTestCases(db, { companyId });
    expect(run.failures).toEqual([expect.objectContaining({ expected: false, actual: true })]);
  });
});

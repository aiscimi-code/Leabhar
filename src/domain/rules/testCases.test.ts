import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { generateDefaultTestCases, runTestCases } from './testCases';
import { irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Test Cases Ltd', seedYears: [2025] }));
  const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
});

describe('generateDefaultTestCases / runTestCases', () => {
  it('writes a positive and an effective-date case per active rule, and all pass', () => {
    const gen = generateDefaultTestCases(db, { companyId });
    expect(gen.created).toBe(8); // 4 curated rules x 2 cases each
    expect(gen.skipped).toBe(0);

    const run = runTestCases(db, { companyId });
    expect(run.total).toBe(8);
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(8);
  });

  it('is idempotent: a second generate call skips rules that already have cases', () => {
    generateDefaultTestCases(db, { companyId });
    const second = generateDefaultTestCases(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(8);
  });

  it('a genuinely broken rule shows up as a failing test, not a silent pass', () => {
    generateDefaultTestCases(db, { companyId });
    // Sabotage: disable a rule after its "positive" test case (expects a
    // match) was generated, so the lookup can no longer find it as a candidate.
    db.update(irishTaxRules).set({ enabled: false })
      .where(eq(irishTaxRules.ruleKey, 'usc.first_band_threshold')).run();

    const run = runTestCases(db, { companyId });
    expect(run.failed).toBeGreaterThan(0);
    expect(run.failures.length).toBeGreaterThan(0);
  });
});

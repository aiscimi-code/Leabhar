/**
 * Generated test cases for extracted rules (task Phase 6: "for every
 * extracted rule where practical, generate automated tests").
 *
 * `generateDefaultTestCases` writes a positive case (the rule's topic, dated
 * on its effective-from date) and an effective-date case (the same context,
 * dated one day earlier, where the rule must NOT yet apply) per rule. This is
 * a floor, not a substitute for the hand-written positive/negative/exception/
 * boundary cases in `transactionLookup.test.ts` — those cover conditions and
 * exceptions this generator cannot infer on its own.
 */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, irishTaxRuleTests } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, asIsoDate } from '../dates';
import { lookupTransactionRules, type TransactionContext } from './transactionLookup';

export interface GenerateTestCasesResult {
  created: number;
  skipped: number;
}

export function generateDefaultTestCases(
  db: AppDatabase,
  params: { companyId: string },
): GenerateTestCasesResult {
  const activeRules = db.select().from(irishTaxRules)
    .where(eq(irishTaxRules.companyId, params.companyId))
    .all()
    .filter((r) => r.active && r.enabled);

  let created = 0;
  let skipped = 0;

  for (const rule of activeRules) {
    const existing = db.select({ id: irishTaxRuleTests.id }).from(irishTaxRuleTests)
      .where(eq(irishTaxRuleTests.ruleId, rule.id)).all();
    if (existing.length > 0) { skipped += existing.length; continue; }

    const baseInput: TransactionContext = {
      transactionDate: rule.effectiveFrom,
      amountMinor: 100000,
      transactionType: rule.topic,
      description: `Test transaction for ${rule.name}`,
    };

    db.insert(irishTaxRuleTests).values({
      id: ids.taxRuleTest(),
      ruleId: rule.id,
      testType: 'positive',
      description: `${rule.name} applies on its effective-from date (${rule.effectiveFrom}).`,
      input: baseInput,
      expected: { matches: true },
    }).run();
    created++;

    const dayBefore = addDays(asIsoDate(rule.effectiveFrom), -1);
    db.insert(irishTaxRuleTests).values({
      id: ids.taxRuleTest(),
      ruleId: rule.id,
      testType: 'effective_date',
      description: `${rule.name} does not yet apply the day before it takes effect (${dayBefore}).`,
      input: { ...baseInput, transactionDate: dayBefore },
      expected: { matches: false },
    }).run();
    created++;
  }

  return { created, skipped };
}

export interface RunTestCasesResult {
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ testId: string; ruleId: string; description: string; expected: boolean; actual: boolean }>;
}

/** Run every stored test case, comparing expected applicability against a live lookup. */
export function runTestCases(
  db: AppDatabase,
  params: { companyId: string },
): RunTestCasesResult {
  const tests = db.select().from(irishTaxRuleTests).all();
  const rulesById = new Map(
    db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, params.companyId)).all()
      .map((r) => [r.id, r]),
  );

  let passed = 0;
  let failed = 0;
  const failures: RunTestCasesResult['failures'] = [];

  for (const test of tests) {
    const rule = rulesById.get(test.ruleId);
    if (!rule) continue;

    const result = lookupTransactionRules(db, {
      companyId: params.companyId,
      transaction: test.input as TransactionContext,
    });
    const actual = result.applicableRules.some((r) => r.ruleKey === rule.ruleKey);
    const ok = actual === test.expected.matches;

    db.update(irishTaxRuleTests)
      .set({ lastRunAt: new Date().toISOString(), lastRunPassed: ok })
      .where(eq(irishTaxRuleTests.id, test.id)).run();

    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push({
        testId: test.id, ruleId: test.ruleId, description: test.description,
        expected: test.expected.matches, actual,
      });
    }
  }

  return { total: tests.length, passed, failed, failures };
}

/**
 * Generated test cases for extracted rules (task Phase 6: "for every
 * extracted rule where practical, generate automated tests").
 *
 * `generateDefaultTestCases` writes one effective-date case per active rule:
 * a transaction on the rule's topic dated the day before the rule takes
 * effect, where that version must NOT apply. The store build runs it, so the
 * cases ship in `rules.db` with every version (ADR-0021, #723); a book never
 * holds cases of its own. This is a floor, not a substitute for the
 * hand-written positive/negative/exception/boundary cases in
 * `transactionLookup.test.ts`.
 *
 * It writes no positive case. A lookup works out a transaction's topics from
 * what the transaction says (its description, supply type, registration and
 * so on), not from a topic name, so a context that only names the topic never
 * brings most rules into the lookup, with or without conditions. A positive
 * case waits until the generator can build a transaction that does (see
 * docs/RULES_KB.md "Limitations").
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, irishTaxRuleTests, visibleTaxRules, visibleTaxRuleTests } from '@/db/schema';
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

    const dayBefore = addDays(asIsoDate(rule.effectiveFrom), -1);
    db.insert(irishTaxRuleTests).values({
      id: ids.taxRuleTest(),
      ruleId: rule.id,
      testType: 'effective_date',
      description: `${rule.name} does not yet apply the day before it takes effect (${dayBefore}).`,
      input: {
        transactionDate: dayBefore,
        amountMinor: 100000,
        transactionType: rule.topic,
        description: `Test transaction for ${rule.name}`,
      } satisfies TransactionContext,
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

/**
 * Run every test case the store holds for a rule the book can see, comparing
 * expected applicability against a live lookup. The store is read-only
 * (ADR-0021), so a run's outcome is returned, not recorded on the test.
 */
export function runTestCases(
  db: AppDatabase,
  params: { companyId: string },
): RunTestCasesResult {
  const tests = db.select().from(visibleTaxRuleTests).all();
  const rulesById = new Map(
    db.select().from(visibleTaxRules)
      .where(and(eq(visibleTaxRules.companyId, params.companyId), eq(visibleTaxRules.origin, 'store'))).all()
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
    // The case is about this version. The day before a later version takes
    // effect, the earlier version of the same key applies, and that is no match.
    const actual = result.applicableRules.some((r) => r.ruleId === rule.id);
    const ok = actual === test.expected.matches;

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

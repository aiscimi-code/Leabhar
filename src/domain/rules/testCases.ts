/**
 * Generated test cases for extracted rules (task Phase 6: "for every
 * extracted rule where practical, generate automated tests").
 *
 * The store build runs this, so the cases ship in `rules.db` with every
 * version (ADR-0021, #723). A book never holds cases of its own. This is a
 * floor, not a substitute for the hand-written positive, negative, exception
 * and boundary cases in `transactionLookup.test.ts`.
 *
 * For each active version it tries to build a transaction the lookup actually
 * matches on the version's start date (#727): the rule's topic, then a value
 * that satisfies each condition. Where that transaction matches, the store
 * holds a pair that differs only in the date — matches on `effectiveFrom`,
 * does not match the day before. Where it cannot (a condition it cannot
 * satisfy, or an exception the lookup only flags), it writes the day-before
 * case alone and counts the miss.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, irishTaxRuleTests, visibleTaxRules, visibleTaxRuleTests } from '@/db/schema';
import type { IrishRuleCondition, IrishRuleException } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, asIsoDate } from '../dates';
import { lookupTransactionRules, type TransactionContext } from './transactionLookup';
import { ruleVersionId } from './irishRules';

export interface GenerateTestCasesResult {
  created: number;
  skipped: number;
  /** Active versions for which no matching transaction could be built (#727). */
  noPositive: number;
}

/** A word that opens the rule's topic in the lookup. Topics with no cue are always candidates. */
const TOPIC_CUE: Record<string, string> = {
  vat: 'vat',
  banking: 'bank',
  rct: 'construction',
  capital_allowances: 'equipment',
  director_transaction: 'director',
  usc: 'payroll',
  income_tax: 'payroll',
  pension: 'pension',
  corporation_tax_relief: 'r&d',
};

/** A string the pattern matches, from its first plain alternative. Null when none can be read. */
function sampleForPattern(pattern: string): string | null {
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  for (const alt of pattern.split('|')) {
    const words = alt
      .replace(/\\b/g, ' ')
      .replace(/\\w\*/g, '')
      .replace(/\\w\+/g, 'x')
      .replace(/\\d\+?/g, '1')
      .replace(/\\s\+?/g, ' ')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[+*?()]/g, '')
      .replace(/\\/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (words && re.test(words)) return words;
  }
  return null;
}

/**
 * A transaction that satisfies the rule's conditions and names its topic.
 * Null when a condition cannot be given a value, or the rule has an exception
 * the lookup does not evaluate. The caller still checks the live lookup.
 */
export function matchingTransaction(
  rule: { topic: string; conditions: IrishRuleCondition[]; exceptions: IrishRuleException[] },
  on: string,
): TransactionContext | null {
  if (rule.exceptions.length > 0) return null;
  const input: Record<string, unknown> = {
    transactionDate: on,
    amountMinor: 100000,
    description: ['Test transaction', TOPIC_CUE[rule.topic]].filter(Boolean).join(' '),
  };
  for (const condition of rule.conditions) {
    const value = satisfyingValue(condition, input);
    if (value === undefined) return null;
    if (condition.field === 'description' && typeof value === 'string') {
      input.description = `${input.description} ${value}`;
    } else if (value !== null) {
      input[condition.field] = value;
    }
  }
  return input as TransactionContext;
}

/** A value that passes one condition, or null to leave the field empty. Undefined when none can be built. */
function satisfyingValue(condition: IrishRuleCondition, input: Record<string, unknown>): unknown {
  const { operator, value, field } = condition;
  if (operator === 'is_null') return null;
  if (operator === 'matches' && field === 'description') return sampleForPattern(String(value));
  if (operator === 'equals') return value === 'true' ? true : value === 'false' ? false : value;
  if (operator === 'not_equals') return value === 'other' ? 'x' : 'other';
  if (operator === 'in') return Array.isArray(value) ? value[0] : value;
  if (operator === 'contains' || operator === 'starts_with' || operator === 'ends_with') return String(value);
  if (operator === 'not_contains') return input[field] ?? 'unrelated';
  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    const bound = Number(value);
    if (!Number.isFinite(bound)) return undefined;
    if (operator === 'gt') return bound + 1;
    if (operator === 'gte') return bound;
    if (operator === 'lt') return bound - 1;
    return bound;
  }
  if (operator === 'between' && Array.isArray(value)) {
    const [low, high] = [Number(value[0]), Number(value[1])];
    return Number.isFinite(low) && Number.isFinite(high) ? low : undefined;
  }
  return undefined;
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
  let noPositive = 0;

  for (const rule of activeRules) {
    const existing = db.select({ id: irishTaxRuleTests.id }).from(irishTaxRuleTests)
      .where(eq(irishTaxRuleTests.ruleId, rule.id)).all();
    if (existing.length > 0) { skipped += existing.length; continue; }

    const on = rule.effectiveFrom;
    const dayBefore = addDays(asIsoDate(on), -1);
    const matched = matchingTransaction(rule, on);
    const applies = matched !== null && lookupTransactionRules(db, {
      companyId: params.companyId,
      transaction: matched,
    }).applicableRules.some((r) => r.ruleId === ruleVersionId(rule.ruleKey, rule.ruleVersion));
    const base = applies ? matched! : {
      transactionDate: on,
      amountMinor: 100000,
      transactionType: rule.topic,
      description: `Test transaction for ${rule.name}`,
    } satisfies TransactionContext;

    if (applies) {
      db.insert(irishTaxRuleTests).values({
        id: ids.taxRuleTest(),
        ruleId: rule.id,
        testType: 'positive',
        description: `${rule.name} applies on its effective-from date (${on}).`,
        input: { ...base, transactionDate: on },
        expected: { matches: true },
      }).run();
      created++;
    } else {
      noPositive++;
    }

    db.insert(irishTaxRuleTests).values({
      id: ids.taxRuleTest(),
      ruleId: rule.id,
      testType: 'effective_date',
      description: `${rule.name} does not yet apply the day before it takes effect (${dayBefore}).`,
      input: { ...base, transactionDate: dayBefore },
      expected: { matches: false },
    }).run();
    created++;
  }

  return { created, skipped, noPositive };
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

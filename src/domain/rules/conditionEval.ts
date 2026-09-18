import { normaliseDescription } from '../banking/fingerprint';

/**
 * The condition shape shared by the coding-rules engine (`engine.ts`,
 * evaluating a bank transaction) and the statute-derived rules engine
 * (`transactionLookup.ts`, evaluating a transaction context against the
 * Irish rules knowledge base). One evaluator, one set of operator semantics,
 * used by both — a statutory condition and a user-authored coding-rule
 * condition are never silently interpreted two different ways.
 */
export type RuleCondition = {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with'
    | 'ends_with' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_null';
  value: string | number | Array<string | number> | null;
  caseSensitive?: boolean;
};

export interface ConditionResult {
  condition: RuleCondition;
  passed: boolean;
  detail: string;
}

/** Evaluate one condition against a plain-object subject. Total, side-effect free. */
export function evaluateCondition(
  condition: RuleCondition,
  subject: Record<string, unknown>,
  labelFor: (field: string) => string = (field) => `"${field}"`,
  formatNumber: (n: number) => string = String,
): ConditionResult {
  const raw = subject[condition.field];
  const label = labelFor(condition.field);

  if (condition.operator === 'is_null') {
    const passed = raw === null || raw === undefined || raw === '';
    return { condition, passed, detail: `${label} is ${passed ? '' : 'not '}empty` };
  }

  if (raw === null || raw === undefined) {
    return { condition, passed: false, detail: `${label} is empty` };
  }

  const numericOperators = ['gt', 'gte', 'lt', 'lte', 'between'];
  if (numericOperators.includes(condition.operator)) {
    const actual = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(actual)) {
      return { condition, passed: false, detail: `${label} is not a number` };
    }
    return { condition, ...evaluateNumeric(condition, actual, label, formatNumber) };
  }

  const caseSensitive = condition.caseSensitive ?? false;
  const actual = String(raw);
  const haystack = caseSensitive ? actual : actual.toLowerCase();

  const asText = (value: unknown): string => {
    const text = String(value);
    return caseSensitive ? text : text.toLowerCase();
  };

  switch (condition.operator) {
    case 'equals': {
      const passed = haystack === asText(condition.value);
      return { condition, passed, detail: `${label} ${passed ? 'is' : 'is not'} "${condition.value}"` };
    }
    case 'not_equals': {
      const passed = haystack !== asText(condition.value);
      return { condition, passed, detail: `${label} ${passed ? 'is not' : 'is'} "${condition.value}"` };
    }
    case 'contains': {
      const passed = normaliseDescription(actual).includes(normaliseDescription(String(condition.value)));
      return { condition, passed, detail: `${label} ${passed ? 'contains' : 'does not contain'} "${condition.value}"` };
    }
    case 'not_contains': {
      const passed = !normaliseDescription(actual).includes(normaliseDescription(String(condition.value)));
      return { condition, passed, detail: `${label} ${passed ? 'does not contain' : 'contains'} "${condition.value}"` };
    }
    case 'starts_with': {
      const passed = haystack.startsWith(asText(condition.value));
      return { condition, passed, detail: `${label} ${passed ? 'starts with' : 'does not start with'} "${condition.value}"` };
    }
    case 'ends_with': {
      const passed = haystack.endsWith(asText(condition.value));
      return { condition, passed, detail: `${label} ${passed ? 'ends with' : 'does not end with'} "${condition.value}"` };
    }
    case 'matches': {
      try {
        const passed = new RegExp(String(condition.value), caseSensitive ? '' : 'i').test(actual);
        return { condition, passed, detail: `${label} ${passed ? 'matches' : 'does not match'} /${condition.value}/` };
      } catch {
        return { condition, passed: false, detail: `${label}: the pattern /${condition.value}/ is not valid` };
      }
    }
    case 'in': {
      const list = Array.isArray(condition.value) ? condition.value : [condition.value];
      const passed = list.some((v) => asText(v) === haystack);
      return { condition, passed, detail: `${label} ${passed ? 'is' : 'is not'} one of ${list.join(', ')}` };
    }
    default:
      return { condition, passed: false, detail: `${label}: unknown operator` };
  }
}

function evaluateNumeric(
  condition: RuleCondition, actual: number, label: string, fmt: (n: number) => string,
): { passed: boolean; detail: string } {
  if (condition.operator === 'between') {
    const [low, high] = Array.isArray(condition.value)
      ? [Number(condition.value[0]), Number(condition.value[1])]
      : [NaN, NaN];
    const passed = actual >= low && actual <= high;
    return {
      passed,
      detail: `${label} (${fmt(actual)}) is ${passed ? '' : 'not '}between ${fmt(low)} and ${fmt(high)}`,
    };
  }

  const bound = Number(condition.value);
  const comparisons: Record<string, [boolean, string]> = {
    gt: [actual > bound, 'greater than'],
    gte: [actual >= bound, 'at least'],
    lt: [actual < bound, 'less than'],
    lte: [actual <= bound, 'at most'],
  };
  const [passed, word] = comparisons[condition.operator] ?? [false, '?'];
  return { passed, detail: `${label} (${fmt(actual)}) is ${passed ? '' : 'not '}${word} ${fmt(bound)}` };
}

/** Evaluate every condition (AND). A rule with no conditions matches nothing (see AGENTS.md). */
export function evaluateAllConditions(
  conditions: RuleCondition[],
  subject: Record<string, unknown>,
  labelFor?: (field: string) => string,
  formatNumber?: (n: number) => string,
): { allPassed: boolean; results: ConditionResult[] } {
  const results = conditions.map((c) => evaluateCondition(c, subject, labelFor, formatNumber));
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  return { allPassed, results };
}

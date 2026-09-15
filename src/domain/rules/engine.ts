import { and, eq, asc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { rules, bankTransactions, suppliers, auditEvents, accounts, vatTreatments } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { normaliseDescription } from '../banking/fingerprint';

/**
 * Deterministic rules engine (README §18).
 *
 * Rules are data, not code: the user can read, edit, reorder and disable every
 * one of them. That is the point. README §18 says confirmed deterministic rules
 * take precedence over AI suggestions, and a rule the user cannot inspect is
 * indistinguishable from the "AI magic" README §42 asks us to avoid.
 *
 * Evaluation is total and side-effect free. Applying the result is a separate,
 * explicit step.
 */

export type RuleCondition = {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with'
    | 'ends_with' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_null';
  value: string | number | Array<string | number> | null;
  caseSensitive?: boolean;
};

export type RuleAction = {
  field: 'accountId' | 'vatTreatmentId' | 'supplierId' | 'customerId'
    | 'status' | 'notes' | 'documentType' | 'isCapital';
  value: string | null;
};

export interface RuleSubject {
  description?: string | null;
  counterpartyName?: string | null;
  bankReference?: string | null;
  amountMinor?: number | null;
  /** Absolute value, which is what a user means by "over €500". */
  absAmountMinor?: number | null;
  currency?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  supplierCountry?: string | null;
  supplierVatNumber?: string | null;
  customerId?: string | null;
  transactionType?: string | null;
  direction?: 'in' | 'out' | null;
  documentType?: string | null;
  invoiceNumber?: string | null;
  [key: string]: unknown;
}

export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  priority: number;
  actions: RuleAction[];
  autoApply: boolean;
  /** Why this rule matched, in the user's terms. */
  explanation: string;
  conditionResults: Array<{ condition: RuleCondition; passed: boolean; detail: string }>;
}

export interface RuleEvaluation {
  matches: RuleMatch[];
  /** The rule whose actions win, after priority and stopOnMatch. */
  winner: RuleMatch | null;
  /** Merged actions from every applicable rule, earliest priority winning. */
  effectiveActions: Record<string, string | null>;
}

/**
 * Evaluate a subject against a company's rules.
 *
 * Rules run in priority order. The first matching rule with `stopOnMatch`
 * halts evaluation; otherwise later rules can add actions for fields an
 * earlier rule did not set. An earlier rule's action is never overwritten by
 * a later one, so priority means what a user expects it to mean.
 */
export function evaluateRules(
  db: AppDatabase,
  params: {
    companyId: string;
    subject: RuleSubject;
    appliesTo?: 'bank_transaction' | 'document' | 'invoice';
  },
): RuleEvaluation {
  const candidates = db.select().from(rules)
    .where(and(eq(rules.companyId, params.companyId), eq(rules.enabled, true)))
    .orderBy(asc(rules.priority), asc(rules.createdAt))
    .all()
    .filter((rule) => rule.appliesTo === 'any'
      || params.appliesTo === undefined
      || rule.appliesTo === params.appliesTo);

  const matches: RuleMatch[] = [];
  const effectiveActions: Record<string, string | null> = {};

  for (const rule of candidates) {
    const conditionResults = (rule.conditions as RuleCondition[]).map((condition) => {
      const { passed, detail } = evaluateCondition(condition, params.subject);
      return { condition, passed, detail };
    });

    // Every condition must hold. A rule with no conditions matches nothing,
    // rather than matching everything — a blank rule is almost certainly
    // half-finished, and treating it as "always" would silently reclassify
    // the entire ledger.
    const allPassed = conditionResults.length > 0 && conditionResults.every((r) => r.passed);
    if (!allPassed) continue;

    const match: RuleMatch = {
      ruleId: rule.id,
      ruleName: rule.name,
      priority: rule.priority,
      actions: rule.actions as RuleAction[],
      autoApply: rule.autoApply,
      explanation: `Rule "${rule.name}" matched because `
        + conditionResults.map((r) => r.detail).join(', and ')
        + '.',
      conditionResults,
    };
    matches.push(match);

    for (const action of match.actions) {
      // Earliest priority wins; a later rule may only fill a gap.
      if (!(action.field in effectiveActions)) {
        effectiveActions[action.field] = action.value;
      }
    }

    if (rule.stopOnMatch) break;
  }

  return { matches, winner: matches[0] ?? null, effectiveActions };
}

function evaluateCondition(
  condition: RuleCondition, subject: RuleSubject,
): { passed: boolean; detail: string } {
  const raw = subject[condition.field];
  const label = humaniseField(condition.field);

  if (condition.operator === 'is_null') {
    const passed = raw === null || raw === undefined || raw === '';
    return { passed, detail: `${label} is ${passed ? '' : 'not '}empty` };
  }

  if (raw === null || raw === undefined) {
    return { passed: false, detail: `${label} is empty` };
  }

  const numericOperators = ['gt', 'gte', 'lt', 'lte', 'between'];
  if (numericOperators.includes(condition.operator)) {
    const actual = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(actual)) {
      return { passed: false, detail: `${label} is not a number` };
    }
    return evaluateNumeric(condition, actual, label);
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
      return { passed, detail: `${label} ${passed ? 'is' : 'is not'} "${condition.value}"` };
    }
    case 'not_equals': {
      const passed = haystack !== asText(condition.value);
      return { passed, detail: `${label} ${passed ? 'is not' : 'is'} "${condition.value}"` };
    }
    case 'contains': {
      // Normalised, so "VERCEL INC." in a bank narrative matches "vercel inc".
      const passed = normaliseDescription(actual).includes(normaliseDescription(String(condition.value)));
      return { passed, detail: `${label} ${passed ? 'contains' : 'does not contain'} "${condition.value}"` };
    }
    case 'not_contains': {
      const passed = !normaliseDescription(actual).includes(normaliseDescription(String(condition.value)));
      return { passed, detail: `${label} ${passed ? 'does not contain' : 'contains'} "${condition.value}"` };
    }
    case 'starts_with': {
      const passed = haystack.startsWith(asText(condition.value));
      return { passed, detail: `${label} ${passed ? 'starts with' : 'does not start with'} "${condition.value}"` };
    }
    case 'ends_with': {
      const passed = haystack.endsWith(asText(condition.value));
      return { passed, detail: `${label} ${passed ? 'ends with' : 'does not end with'} "${condition.value}"` };
    }
    case 'matches': {
      try {
        const passed = new RegExp(String(condition.value), caseSensitive ? '' : 'i').test(actual);
        return { passed, detail: `${label} ${passed ? 'matches' : 'does not match'} /${condition.value}/` };
      } catch {
        // An invalid pattern must never match everything by accident.
        return { passed: false, detail: `${label}: the pattern /${condition.value}/ is not valid` };
      }
    }
    case 'in': {
      const list = Array.isArray(condition.value) ? condition.value : [condition.value];
      const passed = list.some((v) => asText(v) === haystack);
      return { passed, detail: `${label} ${passed ? 'is' : 'is not'} one of ${list.join(', ')}` };
    }
    default:
      return { passed: false, detail: `${label}: unknown operator` };
  }
}

function evaluateNumeric(
  condition: RuleCondition, actual: number, label: string,
): { passed: boolean; detail: string } {
  const money = (n: number): string => (n / 100).toFixed(2);

  if (condition.operator === 'between') {
    const [low, high] = Array.isArray(condition.value)
      ? [Number(condition.value[0]), Number(condition.value[1])]
      : [NaN, NaN];
    const passed = actual >= low && actual <= high;
    return {
      passed,
      detail: `${label} (${money(actual)}) is ${passed ? '' : 'not '}between `
        + `${money(low)} and ${money(high)}`,
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
  return {
    passed,
    detail: `${label} (${money(actual)}) is ${passed ? '' : 'not '}${word} ${money(bound)}`,
  };
}

function humaniseField(field: string): string {
  const names: Record<string, string> = {
    description: 'The description',
    counterpartyName: 'The counterparty name',
    bankReference: 'The bank reference',
    amountMinor: 'The amount',
    absAmountMinor: 'The amount',
    currency: 'The currency',
    supplierName: 'The supplier name',
    supplierCountry: 'The supplier country',
    supplierVatNumber: 'The supplier VAT number',
    supplierId: 'The supplier',
    direction: 'The direction',
    transactionType: 'The transaction type',
    documentType: 'The document type',
    invoiceNumber: 'The invoice number',
  };
  return names[field] ?? `"${field}"`;
}

/** Build the subject a bank transaction presents to the rules engine. */
export function subjectFromTransaction(
  db: AppDatabase, transaction: typeof bankTransactions.$inferSelect,
): RuleSubject {
  const supplier = transaction.supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, transaction.supplierId)).get()
    : undefined;

  return {
    description: transaction.description,
    counterpartyName: transaction.counterpartyName,
    bankReference: transaction.bankReference,
    amountMinor: transaction.amountMinor,
    absAmountMinor: Math.abs(transaction.amountMinor),
    currency: transaction.currency,
    supplierId: transaction.supplierId,
    supplierName: supplier?.name ?? null,
    supplierCountry: supplier?.countryCode ?? null,
    supplierVatNumber: supplier?.vatNumber ?? null,
    customerId: transaction.customerId,
    transactionType: transaction.transactionType,
    direction: transaction.amountMinor < 0 ? 'out' : 'in',
  };
}

export interface CreateRuleInput {
  companyId: string;
  name: string;
  description?: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  priority?: number;
  appliesTo?: 'bank_transaction' | 'document' | 'invoice' | 'any';
  autoApply?: boolean;
  stopOnMatch?: boolean;
  supplierId?: string | null;
  derivedFromHistory?: boolean;
  actor?: string;
}

export function createRule(db: AppDatabase, input: CreateRuleInput): string {
  if (input.conditions.length === 0) {
    throw new Error(
      'A rule with no conditions would match every transaction. Add at least one condition.',
    );
  }
  if (input.actions.length === 0) {
    throw new Error('A rule with no actions would do nothing. Add at least one action.');
  }

  const id = ids.rule();
  db.transaction((tx) => {
    tx.insert(rules).values({
      id,
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? null,
      priority: input.priority ?? 100,
      appliesTo: input.appliesTo ?? 'bank_transaction',
      conditions: input.conditions,
      actions: input.actions,
      autoApply: input.autoApply ?? false,
      stopOnMatch: input.stopOnMatch ?? true,
      supplierId: input.supplierId ?? null,
      derivedFromHistory: input.derivedFromHistory ?? false,
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'rule',
      entityId: id,
      action: 'created',
      newValue: JSON.stringify({
        name: input.name, conditions: input.conditions, actions: input.actions,
      }),
      source: input.derivedFromHistory ? 'system' : 'user',
      actor: input.actor ?? 'user',
      reason: input.derivedFromHistory ? 'Learned from confirmed history' : null,
    }).run();
  });
  return id;
}

/**
 * Propose a rule from a confirmed classification (README §17).
 *
 * This is how the system "learns" without anything probabilistic: a user
 * confirms a treatment for a supplier, and that confirmed decision becomes an
 * inspectable rule that suggests the same treatment next time. The rule is
 * created with autoApply off, so it proposes rather than decides until the user
 * says otherwise.
 */
export function proposeRuleFromClassification(
  db: AppDatabase,
  params: {
    companyId: string;
    supplierId: string;
    accountId: string;
    vatTreatmentId: string;
    actor?: string;
  },
): { ruleId: string | null; reason: string } {
  const supplier = db.select().from(suppliers)
    .where(eq(suppliers.id, params.supplierId)).get();
  if (!supplier) return { ruleId: null, reason: 'Supplier not found.' };

  const existing = db.select().from(rules)
    .where(and(
      eq(rules.companyId, params.companyId),
      eq(rules.supplierId, params.supplierId),
    )).get();

  if (existing) {
    return {
      ruleId: existing.id,
      reason: `A rule for ${supplier.name} already exists. Edit it rather than adding a second.`,
    };
  }

  const account = db.select({ name: accounts.name }).from(accounts)
    .where(eq(accounts.id, params.accountId)).get();
  const treatment = db.select({ name: vatTreatments.name }).from(vatTreatments)
    .where(eq(vatTreatments.id, params.vatTreatmentId)).get();

  const ruleId = createRule(db, {
    companyId: params.companyId,
    name: `${supplier.name} → ${account?.name ?? 'account'}`,
    description: `Learned from a confirmed classification: ${supplier.name} was coded to `
      + `${account?.name ?? 'an account'} with VAT treatment ${treatment?.name ?? 'set'}. `
      + 'This rule suggests the same treatment next time. It proposes rather than decides '
      + 'until you turn on automatic application.',
    conditions: [{ field: 'supplierId', operator: 'equals', value: params.supplierId }],
    actions: [
      { field: 'accountId', value: params.accountId },
      { field: 'vatTreatmentId', value: params.vatTreatmentId },
    ],
    priority: 50,
    autoApply: false,
    supplierId: params.supplierId,
    derivedFromHistory: true,
    actor: params.actor,
  });

  return {
    ruleId,
    reason: `Created a rule so future ${supplier.name} transactions suggest the same treatment.`,
  };
}

/** Record that a rule fired, for the "times applied" figure the UI shows. */
export function recordRuleApplication(db: AppDatabase, ruleId: string): void {
  const rule = db.select({ n: rules.timesApplied }).from(rules)
    .where(eq(rules.id, ruleId)).get();
  if (!rule) return;
  db.update(rules).set({ timesApplied: rule.n + 1, lastAppliedAt: nowIso() })
    .where(eq(rules.id, ruleId)).run();
}

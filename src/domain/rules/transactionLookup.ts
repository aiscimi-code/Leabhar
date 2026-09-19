/**
 * Deterministic transaction-rule lookup (docs/RULES_KB.md "Lookup algorithm").
 *
 * transaction -> normalise -> identify topics -> deterministic candidate
 * retrieval -> evaluate conditions -> evaluate exceptions -> apply effective
 * dates -> applicable rules -> unresolved conditions -> possible treatment ->
 * source citations -> review-required.
 *
 * This is the "DETERMINISTIC RULE LOOKUP" step of the architecture in the
 * task brief. It never ranks candidates by semantic similarity and never asks
 * an LLM what the treatment should be: topic identification is keyword
 * matching against a fixed, versioned table, and applicability is
 * conditions-on-fields evaluation using the same evaluator the coding-rules
 * engine uses (`conditionEval.ts`). Where the knowledge base holds no rule
 * for a topic, the result says so — it does not fall back to guessing.
 */
import { eq, and } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources } from '@/db/schema';
import type { IrishRuleException } from '@/db/schema';
import { evaluateAllConditions, type ConditionResult } from './conditionEval';
import { today, isIsoDate } from '../dates';
import { listTaxRulesByTopic, listIngestedCitations, type LookupResult } from './irishRules';
import { RCT_SCOPE_RE } from './rctCuration';

/**
 * A transaction as presented for classification — the task's example shape,
 * in the project's camelCase convention. Every field is optional except the
 * three needed to run the lookup at all: a rule that depends on a field the
 * caller did not supply becomes an *unresolved* condition, not a false "no".
 */
export interface TransactionContext {
  transactionDate: string; // ISO date; the rule lookup is always as-of this date
  amountMinor: number;
  currency?: string;
  entityType?: string | null; // e.g. "Irish_LTD"
  vatRegistered?: boolean | null;
  supplierCountry?: string | null; // ISO country code
  supplierType?: string | null; // e.g. "software_service"
  transactionType?: string | null; // e.g. "AI_SaaS", "bank_charge", "payroll"
  description?: string | null;
  businessUsePercent?: number | null; // 0-100; undefined means not yet assessed
  invoiceAvailable?: boolean | null;
  /** "goods" or "services" — several VATCA 2010 rules (place of supply, reverse
   *  charge) turn on this distinction and it is not safely inferable from free text. */
  supplyType?: 'goods' | 'services' | null;
  [key: string]: unknown;
}

/**
 * Fill in what normalisation can safely infer; invent nothing else.
 *
 * `currency` is deliberately left as the caller supplied it, including
 * omitted — defaulting an omitted currency to EUR would be inventing a fact
 * no one stated (see issue #136 bug 5). A rule that actually depends on the
 * currency will surface it via the normal unresolved-condition path instead.
 */
export function normaliseTransactionContext(input: TransactionContext): TransactionContext {
  return {
    ...input,
    transactionDate: input.transactionDate,
  };
}

interface TopicRule {
  topic: string;
  test: (ctx: TransactionContext) => boolean;
}

const TEXT_FIELDS = (ctx: TransactionContext): string =>
  [ctx.transactionType, ctx.supplierType, ctx.description].filter(Boolean).join(' ').toLowerCase();

/**
 * Deterministic keyword -> topic table. Extend this when a new rule topic is
 * added to the knowledge base; a transaction is never routed to a topic by
 * semantic similarity alone (task: "semantic search may retrieve candidates;
 * it must not by itself determine the accounting treatment").
 */
const TOPIC_RULES: TopicRule[] = [
  {
    topic: 'vat',
    // VAT deductibility (section 59/60) is a candidate question for any
    // VAT-registered entity's purchase, not only cross-border ones — a
    // narrower test here would miss ordinary domestic input VAT questions
    // (e.g. "is the VAT on this bank charge deductible?").
    test: (ctx) => ctx.vatRegistered === true
      || /\bvat\b|saas|software|digital service|reverse charge/i.test(TEXT_FIELDS(ctx))
      || (!!ctx.supplierCountry && ctx.supplierCountry.toUpperCase() !== 'IE'),
  },
  {
    topic: 'banking',
    // Deliberately narrower than a bare `fee|charge` match: those words alone
    // also hit "service charge", "card charge" (retail, not a bank fee) and
    // "charging point" (EV charging) — none of them a banking-topic question
    // (issue #136 bug 7). Require the word "bank"/"banking" itself, or a
    // small set of unambiguous banking terms.
    test: (ctx) => /\bbank(ing)?\b|\batm\b|\boverdraft\b|\biban\b|\bswift\b/i.test(TEXT_FIELDS(ctx)),
  },
  {
    topic: 'rct',
    // Shared with rctCuration.ts's own condition regex, so the topic router
    // and every curated RCT rule agree on what counts as a candidate.
    test: (ctx) => new RegExp(RCT_SCOPE_RE, 'i').test(TEXT_FIELDS(ctx)),
  },
  {
    topic: 'capital_allowances',
    // Matches capitalAllowancesCuration.ts's own machinery/plant condition —
    // a candidate for a capital allowance rather than a same-year deduction.
    test: (ctx) => ctx.isCapitalExpenditure === true
      || /\b(machinery|plant|equipment|vehicle|computer|furniture)\b/i.test(TEXT_FIELDS(ctx)),
  },
  { topic: 'business_expense', test: () => true }, // deductibility is a candidate question for every transaction
  {
    topic: 'director_transaction',
    test: (ctx) => /personal|director|shareholder/i.test(TEXT_FIELDS(ctx))
      || (ctx.businessUsePercent !== null && ctx.businessUsePercent !== undefined && ctx.businessUsePercent < 100),
  },
  { topic: 'usc', test: (ctx) => /\busc\b|payroll|salary|wage|paye/i.test(TEXT_FIELDS(ctx)) },
  { topic: 'income_tax', test: (ctx) => /payroll|salary|wage|paye|income tax/i.test(TEXT_FIELDS(ctx)) },
  { topic: 'pension', test: (ctx) => /pension|\bprsa\b|\bpepp\b/i.test(TEXT_FIELDS(ctx)) },
  { topic: 'corporation_tax_relief', test: (ctx) => /film|production|r&d|research and development/i.test(TEXT_FIELDS(ctx)) },
];

export function identifyTopics(ctx: TransactionContext): string[] {
  return TOPIC_RULES.filter((t) => t.test(ctx)).map((t) => t.topic);
}

export interface ApplicableRule {
  ruleId: string;
  ruleKey: string;
  ruleType: string;
  topic: string;
  name: string;
  statement: string | null;
  /** True when every stated condition passed (or the rule states none). */
  matched: boolean;
  conditionResults: ConditionResult[];
  exceptions: IrishRuleException[];
  effect: {
    accounting: string | null;
    tax: string | null;
    vat: string | null;
    reporting: string | null;
  };
  reviewStatus: string;
  humanReviewRequired: boolean;
  requiresGuidance: boolean;
  citation: {
    citation: string;
    sourceUrl: string;
    sectionNumber: string;
    heading: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  };
}

export interface TransactionLookupResult {
  transactionContext: TransactionContext;
  identifiedTopics: string[];
  candidateCount: number;
  applicableRules: ApplicableRule[];
  /** Fields an applicable-but-unresolved rule needed that the context did not supply. */
  unresolvedFields: string[];
  possibleTreatment: {
    accounting: string[];
    tax: string[];
    vat: string[];
    reporting: string[];
  };
  reviewRequired: boolean;
  reviewReasons: string[];
}

/**
 * Look up the rules applicable to a transaction, deterministically.
 *
 * For each identified topic, candidate rules in force on the transaction's
 * own date (not today's) are retrieved (`listTaxRulesByTopic`), so a
 * historical transaction resolves against the rule that applied when it
 * happened, per AGENTS.md invariant #6. Every candidate rule with
 * conditions evaluates them against the transaction context; a rule with no
 * conditions is a topic-level fact (e.g. a flat threshold) and applies
 * whenever its topic and effective window match — this is the opposite
 * default from the user-authored coding-rules engine (`engine.ts`), where an
 * empty condition list is treated as "matches nothing" to guard against a
 * half-finished rule. Here every rule is machine-derived from curated
 * extraction, so an empty condition list is a deliberate, reviewed choice,
 * not an omission.
 */
export function lookupTransactionRules(
  db: AppDatabase,
  params: { companyId: string; transaction: TransactionContext },
): TransactionLookupResult {
  const ctx = normaliseTransactionContext(params.transaction);
  const topics = identifyTopics(ctx);
  const asOf = ctx.transactionDate || today();

  const subject: Record<string, unknown> = { ...ctx };

  const applicableRules: ApplicableRule[] = [];
  const unresolvedFields = new Set<string>();
  const reviewReasons = new Set<string>();

  // Fail closed on a malformed date or amount rather than let a broken
  // effective-date/monetary comparison silently open (date, issue #136 bug 3)
  // or attach (amount, bug 5) every in-force rule. Neither is a case where
  // *some* rule set can safely apply — the transaction itself is unusable
  // until corrected, so no candidate is even retrieved.
  const dateValid = isIsoDate(asOf);
  if (!dateValid) {
    unresolvedFields.add('transactionDate');
    reviewReasons.add(
      `transactionDate ${JSON.stringify(asOf)} is not a valid ISO date (YYYY-MM-DD); no effective-dated rule `
      + 'can be safely applied without one, so none was looked up.',
    );
  }

  const amountValid = Number.isFinite(ctx.amountMinor) && ctx.amountMinor > 0;
  if (!amountValid) {
    unresolvedFields.add('amountMinor');
    reviewReasons.add(
      `amountMinor (${JSON.stringify(ctx.amountMinor)}) must be a positive number; no rule was looked up for it.`,
    );
  }

  const candidates: LookupResult[] = (dateValid && amountValid)
    ? topics.flatMap(
      (topic) => listTaxRulesByTopic(db, { companyId: params.companyId, topic, asOfDate: asOf }),
    )
    : [];

  for (const rule of candidates) {
    const conditions = getRuleConditions(db, rule.id);
    const exceptions = getRuleExceptions(db, rule.id);

    let matched = true;
    let conditionResults: ConditionResult[] = [];
    if (conditions.length > 0) {
      const evalResult = evaluateAllConditions(conditions, subject);
      matched = evalResult.allPassed;
      conditionResults = evalResult.results;
      for (const r of evalResult.results) {
        if (!r.passed && (subject[r.condition.field] === undefined || subject[r.condition.field] === null)) {
          unresolvedFields.add(r.condition.field);
        }
      }
    }
    if (!matched) continue;

    if (exceptions.length > 0) {
      reviewReasons.add(
        `Rule "${rule.name}" (s.${rule.sectionNumber}) states ${exceptions.length} exception(s) this system does not evaluate automatically.`,
      );
    }
    if (rule.humanReviewRequired) {
      reviewReasons.add(`Rule "${rule.name}" (s.${rule.sectionNumber}) is not yet human-approved (status: ${rule.reviewStatus}).`);
    }
    if (rule.requiresGuidance) {
      reviewReasons.add(`Rule "${rule.name}" (s.${rule.sectionNumber}) requires Revenue guidance this KB does not yet hold.`);
    }

    applicableRules.push({
      ruleId: rule.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: rule.topic,
      name: rule.name,
      statement: rule.statement,
      matched,
      conditionResults,
      exceptions,
      effect: {
        accounting: rule.accountingEffect,
        tax: rule.taxEffect,
        vat: rule.vatEffect,
        reporting: rule.reportingEffect,
      },
      reviewStatus: rule.reviewStatus,
      humanReviewRequired: rule.humanReviewRequired,
      requiresGuidance: rule.requiresGuidance,
      citation: {
        citation: rule.citation,
        sourceUrl: rule.sourceUrl,
        sectionNumber: rule.sectionNumber,
        heading: rule.heading,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
      },
    });
  }

  const possibleTreatment = {
    accounting: dedupe(applicableRules.map((r) => r.effect.accounting)),
    tax: dedupe(applicableRules.map((r) => r.effect.tax)),
    vat: dedupe(applicableRules.map((r) => r.effect.vat)),
    reporting: dedupe(applicableRules.map((r) => r.effect.reporting)),
  };

  if (applicableRules.length === 0 && dateValid && amountValid) {
    const sources = listIngestedCitations(db, params.companyId);
    const kbDescription = sources.length > 0 ? sources.join(', ') : 'no sources';
    reviewReasons.add(
      'No rule in the ingested knowledge base is applicable to this transaction. '
      + 'This is not a determination that no tax/VAT/accounting treatment applies — '
      + `it means the KB (currently ingesting: ${kbDescription}) has no ingested rule that speaks to it.`,
    );
  }

  return {
    transactionContext: ctx,
    identifiedTopics: topics,
    candidateCount: candidates.length,
    applicableRules,
    unresolvedFields: [...unresolvedFields],
    possibleTreatment,
    // Always true today: no rule in this KB has reached reviewStatus 'active'
    // yet (task: "never make AI-generated legal rules automatically
    // authoritative"). Kept as a real computed value, not a hard-coded true,
    // so it starts reflecting reality the moment rules are approved.
    reviewRequired: applicableRules.length === 0
      || applicableRules.some((r) => r.humanReviewRequired || r.requiresGuidance || r.exceptions.length > 0)
      || unresolvedFields.size > 0,
    reviewReasons: [...reviewReasons],
  };
}

function dedupe(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

function getRuleConditions(db: AppDatabase, ruleId: string) {
  const row = db.select({ conditions: irishTaxRules.conditions })
    .from(irishTaxRules).where(eq(irishTaxRules.id, ruleId)).get();
  return row?.conditions ?? [];
}

function getRuleExceptions(db: AppDatabase, ruleId: string): IrishRuleException[] {
  const row = db.select({ exceptions: irishTaxRules.exceptions })
    .from(irishTaxRules).where(eq(irishTaxRules.id, ruleId)).get();
  return row?.exceptions ?? [];
}

/** Re-exported for callers that already have a provision id and want its source citation. */
export function citationForProvision(db: AppDatabase, provisionId: string) {
  return db.select({
    sectionNumber: irishActProvisions.sectionNumber,
    heading: irishActProvisions.heading,
    citation: irishKnowledgeSources.citation,
    sourceUrl: irishKnowledgeSources.sourceUrl,
  })
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(eq(irishActProvisions.id, provisionId)))
    .get();
}

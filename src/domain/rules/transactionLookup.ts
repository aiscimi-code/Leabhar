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
import { irishTaxRules, irishActProvisions, irishKnowledgeSources, companies } from '@/db/schema';
import type { IrishRuleException } from '@/db/schema';
import { evaluateAllConditions, type ConditionResult } from './conditionEval';
import { today, isIsoDate } from '../dates';
import { listTaxRulesByTopic, listIngestedCitations, type LookupResult } from './irishRules';
import { RCT_SCOPE_RE } from './rctCuration';
import { VAT_STANDARD_RATE_FALLBACK_RULE_KEY } from './vatcaRevisedCuration';
import { VAT_GENERAL_DEDUCTION_RULE_KEY, VAT_DEDUCTION_EXCLUSION_RULE_KEYS } from './vatcaCuration';

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
  /** Integer minor units — the business's own actual annual turnover in the
   *  current calendar year, for the VATCA s.6(1)(c)/(d) registration-threshold
   *  test (issue #136 bug 2 / #137). This KB cannot compute it; the caller
   *  supplies it (or leaves both this and the previous-year figure unset,
   *  which leaves the threshold rules unresolved rather than falsely matched). */
  annualTurnoverCurrentYearMinor?: number | null;
  /** Same as above, for the previous calendar year — s.6(1)(c)/(d) tests
   *  "the current calendar year OR the previous calendar year". */
  annualTurnoverPreviousYearMinor?: number | null;
  /**
   * 0-100: what share of the business's annual turnover (in the same
   * current/previous-year window as `annualTurnoverMaxMinor` above) comes
   * from supplies of goods, as opposed to services. VATCA s.6(1)(c)(ii)
   * gates the €85,000 goods threshold on this being at least 90% for a
   * trader who supplies both goods and services — a mixed trader below
   * that share falls to the €42,500 services threshold instead (issue
   * #143 finding B). This KB cannot compute it; absent, the goods-threshold
   * rule is unresolved rather than assumed to pass.
   */
  goodsShareOfAnnualTurnoverPercent?: number | null;
  /**
   * A direct, human-made determination of whether the supplier is
   * "established outside the State" per VATCA s.12/s.34's actual legal test
   * (EU Reg 282/2011 arts.10-11: seat of economic activity / fixed
   * establishment — see docs/statutes/282-2011/articles-10-13b-establishment.md),
   * as opposed to the crude `supplierCountry != 'IE'` proxy those rules used
   * before this field existed (issue #136 bug 4 / #138). When supplied, this
   * takes precedence over the country-code proxy; the multi-factor test
   * itself is not something this KB can compute from a country code alone.
   */
  supplierEstablishedOutsideState?: boolean | null;
  [key: string]: unknown;
}

/**
 * ISO 3166-1 alpha-2 country codes currently assigned by ISO. Used only to
 * tell a real, if imperfect, `supplierCountry` proxy apart from garbage
 * (issue #136 bug 4) — this is not itself the VATCA "established" test (see
 * `supplierEstablishedOutsideState` above), just a data-quality gate on the
 * one field the crude proxy depends on.
 */
const ISO_3166_ALPHA2 = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

/** True only for a real, currently-assigned ISO 3166-1 alpha-2 code. */
export function isValidIsoCountryCode(code: string): boolean {
  return ISO_3166_ALPHA2.has(code.toUpperCase());
}

/**
 * Fill in what normalisation can safely infer; invent nothing else.
 *
 * `currency` is deliberately left as the caller supplied it, including
 * omitted — defaulting an omitted currency to EUR would be inventing a fact
 * no one stated (see issue #136 bug 5). A rule that actually depends on the
 * currency will surface it via the normal unresolved-condition path instead.
 *
 * Three fields are derived here, never invented beyond what the caller
 * supplied:
 *
 *  - `supplierCountry` is sanitised to `null` when it isn't a real,
 *    currently-assigned ISO 3166-1 alpha-2 code (e.g. `"XX"`) — an unknown
 *    code is unresolved, not "established outside the State" (issue #136
 *    bug 4).
 *  - `supplierEstablishedOutsideStateResolved` is the caller's own
 *    `supplierEstablishedOutsideState` determination when given (the actual
 *    VATCA s.12/s.34 legal test, EU Reg 282/2011 arts.10-11 — see
 *    docs/statutes/282-2011/articles-10-13b-establishment.md), falling back
 *    to the sanitised `supplierCountry != 'IE'` proxy only when no direct
 *    determination was supplied, and to `null` (unresolved) when neither is
 *    available.
 *  - `annualTurnoverMaxMinor` is the greater of `annualTurnoverCurrentYearMinor`
 *    and `annualTurnoverPreviousYearMinor` when at least one is a finite
 *    number — implementing VATCA s.6(1)(c)/(d)'s "current calendar year or
 *    the previous calendar year" turnover test (issue #136 bug 2 / #137) as
 *    a single field the registration-threshold rules can condition on.
 */
export function normaliseTransactionContext(input: TransactionContext): TransactionContext {
  const supplierCountry = input.supplierCountry && isValidIsoCountryCode(input.supplierCountry)
    ? input.supplierCountry.toUpperCase()
    : (input.supplierCountry ? null : input.supplierCountry);

  const supplierEstablishedOutsideStateResolved =
    input.supplierEstablishedOutsideState ?? (supplierCountry ? supplierCountry !== 'IE' : null);

  const turnoverFigures = [input.annualTurnoverCurrentYearMinor, input.annualTurnoverPreviousYearMinor]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  return {
    ...input,
    transactionDate: input.transactionDate,
    supplierCountry,
    supplierEstablishedOutsideStateResolved,
    ...(turnoverFigures.length > 0 ? { annualTurnoverMaxMinor: Math.max(...turnoverFigures) } : {}),
  };
}

interface TopicRule {
  topic: string;
  test: (ctx: TransactionContext) => boolean;
}

const TEXT_FIELDS = (ctx: TransactionContext): string =>
  [ctx.transactionType, ctx.supplierType, ctx.description].filter(Boolean).join(' ').toLowerCase();

/**
 * Bank narratives describing a movement of funds rather than a taxable
 * supply of goods or services — a director's own money moving in or out, a
 * tax remittance to Revenue, or cash withdrawn/received with no evidence
 * attached (issue #145 defect 3). None of these is a purchase or a sale, so
 * even a VAT-registered company's own `vatRegistered: true` context must not
 * open the `vat` topic for them — that would attach a rate rule
 * (`vat.rate_standard_current`) to a line that was never a supply to begin
 * with. Only gates the topic when `supplyType` is absent, so a genuine
 * invoice that explicitly states its supply type is never affected by this
 * exclusion, however its narrative happens to be worded.
 */
const NON_TRADING_BANK_NARRATIVE_RE =
  /\bdirector\b|\bdrawings?\b|\bfunds introduced\b|\brevenue payment\b|\bvat settlement\b|\bpaye\b|\batm\b|\bcash withdrawal\b|\bunknown\b|\bunidentified\b/i;

/**
 * A card-payment line whose narrative carries no other identifying text —
 * no merchant, no reference, nothing beyond the payment method itself
 * (issue #147 finding 2, UNKNOWN-002). This is deliberately an exact match
 * on the whole (trimmed) description rather than a substring test: "CARD
 * PAYMENT" alone is evidence of nothing, but "CARD PAYMENT - AWS DUBLIN"
 * names a real merchant and is exactly the kind of narrative the `vat` topic
 * exists to catch — widening this to a substring match would also exclude
 * every genuinely evidenced card purchase.
 */
const BARE_CARD_PAYMENT_RE = /^card payment\.?$/i;

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
    // (e.g. "is the VAT on this bank charge deductible?"). `supplyType`
    // alone also routes here, `vatRegistered` or not: whether someone
    // SHOULD be registered (the s.6(1)(c)/(d) registration-threshold test)
    // is a question about a currently-*unregistered* trader more often than
    // not — gating it on `vatRegistered === true` made it unreachable for
    // exactly the population it exists to catch (an unregistered trader
    // whose turnover has passed the threshold never got looked up at all).
    // An explicit `vatRegistered === false` (issue #143 finding A) and
    // either turnover-window field are the same signal by a different
    // route: a caller who bothered to state either is already asking the
    // registration question, with or without `supplyType` alongside it —
    // its own absence still surfaces as `unresolvedFields` once the topic
    // is at least opened, instead of the question never being asked.
    test: (ctx) => {
      if (ctx.supplyType == null && (
        NON_TRADING_BANK_NARRATIVE_RE.test(TEXT_FIELDS(ctx))
        || BARE_CARD_PAYMENT_RE.test((ctx.description ?? '').trim())
      )) return false;
      return ctx.vatRegistered === true
        || ctx.vatRegistered === false
        || ctx.supplyType != null
        || ctx.annualTurnoverCurrentYearMinor != null
        || ctx.annualTurnoverPreviousYearMinor != null
        || /\bvat\b|saas|software|digital service|reverse charge/i.test(TEXT_FIELDS(ctx))
        || (!!ctx.supplierCountry && ctx.supplierCountry.toUpperCase() !== 'IE');
    },
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

  // Company profile facts (issue #143 finding F): `companyType`,
  // `vatRegistrationStatus` and `vatAccountingBasis` are stored on the
  // company row, not the transaction, and were previously never read by
  // this lookup at all — sole trader vs LTD vs partnership vs foreign
  // company made no difference, and a cash-basis trader's own accounting
  // basis was silent unless the transaction description happened to say
  // "cash basis". Exposed here as `company*`-prefixed facts a condition can
  // reference, alongside the transaction's own fields — never overwriting
  // them: `vatRegistered` on a specific transaction is still what the
  // caller stated for that transaction, not overridden by the company's
  // default registration status.
  const company = db.select({
    companyType: companies.companyType,
    vatRegistrationStatus: companies.vatRegistrationStatus,
    vatAccountingBasis: companies.vatAccountingBasis,
  }).from(companies).where(eq(companies.id, params.companyId)).get();

  const subject: Record<string, unknown> = {
    ...ctx,
    companyType: company?.companyType ?? null,
    companyVatRegistrationStatus: company?.vatRegistrationStatus ?? null,
    companyVatAccountingBasis: company?.vatAccountingBasis ?? null,
    // A cash-basis trader's own accounting-basis setting is just as valid a
    // signal as the transaction description saying "cash basis" — Tony
    // Cash's cash_receipts company profile should not need every invoice
    // to spell that out in words.
    cashBasisIndicated: company?.vatAccountingBasis === 'cash_receipts'
      || /\b(cash basis|moneys received basis|money received basis)\b/i.test(TEXT_FIELDS(ctx)),
  };

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

  const rateResolved = resolveVatRateExclusivity(applicableRules, reviewReasons);
  const finalApplicableRules = resolveDeductionExclusivity(rateResolved, reviewReasons);

  const possibleTreatment = {
    accounting: dedupe(finalApplicableRules.map((r) => r.effect.accounting)),
    tax: dedupe(finalApplicableRules.map((r) => r.effect.tax)),
    vat: dedupe(finalApplicableRules.map((r) => r.effect.vat)),
    reporting: dedupe(finalApplicableRules.map((r) => r.effect.reporting)),
  };

  if (finalApplicableRules.length === 0 && dateValid && amountValid) {
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
    applicableRules: finalApplicableRules,
    unresolvedFields: [...unresolvedFields],
    possibleTreatment,
    // Always true today: no rule in this KB has reached reviewStatus 'active'
    // yet (task: "never make AI-generated legal rules automatically
    // authoritative"). Kept as a real computed value, not a hard-coded true,
    // so it starts reflecting reality the moment rules are approved.
    reviewRequired: finalApplicableRules.length === 0
      || finalApplicableRules.some((r) => r.humanReviewRequired || r.requiresGuidance || r.exceptions.length > 0)
      || unresolvedFields.size > 0,
    reviewReasons: [...reviewReasons],
  };
}

function dedupe(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

/**
 * VAT rate exclusivity (issue #136 bugs 1 and 8).
 *
 * `vat.rate_standard_current` (23%), `vat.rate_reduced_current` (13.5%) and
 * — before this fix — `vat.rate_livestock_current` (4.8%) carry no
 * `conditions` at all (see `vatcaRevisedCuration.ts`'s own header): each is
 * a topic-level fact ("the current standard rate is 23%"), which is exactly
 * why the main loop above treats an empty condition list as "matches
 * whenever the topic and effective window match" for statute-derived rules.
 * That default is correct for a rule that states an unconditional fact
 * (`vat.charge_general`, `vat.annual_turnover_definition`, ...), but a VAT
 * *rate* is never unconditional in reality — exactly one of standard/zero/
 * reduced/livestock applies to any given supply, by construction of the
 * statute itself (VATCA s.46(1)(a)-(d)). Before this function existed, every
 * empty-condition rate rule that matched a transaction's topic and
 * effective window was listed side by side with every rule that had a real,
 * satisfied condition (a Schedule 2/3 item, the now-conditioned livestock
 * rate, or the hospitality-gap rule below) — a solicitor invoice or a US
 * SaaS reverse charge would come back quoting 23%, 13.5% AND 4.8% as
 * simultaneous "possible" treatments.
 *
 * The fix does not change what conditions any rule state matches on;
 * exclusivity is resolved purely from which rules already matched:
 *
 *  - If any VAT `rate`-type rule matched with a REAL (non-empty) condition
 *    — a Schedule 2/3 item, the conditioned livestock rule, or a dated
 *    carve-out like the hospitality-gap rule — every empty-condition VAT
 *    rate rule is dropped. A real determination always wins over a bare
 *    "this rate exists" citation fact.
 *  - Otherwise (no rate rule with a real condition matched), only
 *    `VAT_STANDARD_RATE_FALLBACK_RULE_KEY` survives among the
 *    empty-condition rate rules — the statute's own residual case ("the
 *    default rate outside the zero/reduced/livestock cases"). Any other
 *    empty-condition rate rule (today, just `vat.rate_reduced_current`) is
 *    dropped: an unconditioned "the reduced rate is 13.5%" fact is not
 *    itself evidence that THIS transaction is within Schedule 3, so it is
 *    never presented as the answer on its own.
 *
 * A rule is "real-condition" here iff its own `conditions` array was
 * non-empty (`conditionResults.length > 0` on the `ApplicableRule` already
 * built above — conditionResults is only ever populated when conditions
 * existed to evaluate; see the main loop).
 */
function resolveVatRateExclusivity(
  applicableRules: ApplicableRule[],
  reviewReasons: Set<string>,
): ApplicableRule[] {
  const vatRateRules = applicableRules.filter((r) => r.topic === 'vat' && r.ruleType === 'rate');
  if (vatRateRules.length <= 1) return applicableRules;

  const hasRealConditionMatch = vatRateRules.some((r) => r.conditionResults.length > 0);
  const excludeRuleKeys = new Set(
    hasRealConditionMatch
      ? vatRateRules.filter((r) => r.conditionResults.length === 0).map((r) => r.ruleKey)
      : vatRateRules.filter((r) => r.ruleKey !== VAT_STANDARD_RATE_FALLBACK_RULE_KEY).map((r) => r.ruleKey),
  );
  if (excludeRuleKeys.size === 0) return applicableRules;

  const excludedNames = vatRateRules
    .filter((r) => excludeRuleKeys.has(r.ruleKey))
    .map((r) => `"${r.name}"`)
    .join(', ');
  const reason = hasRealConditionMatch
    ? `Excluded fallback VAT rate rule(s) (${excludedNames}) because a more specific VAT rate rule already matched this transaction.`
    : `Excluded VAT rate rule(s) (${excludedNames}) because, absent a more specific match, only the standard-rate fallback is kept — an unconditioned rate fact is not evidence this transaction is within that rate's category.`;
  reviewReasons.add(reason);

  return applicableRules.filter((r) => !excludeRuleKeys.has(r.ruleKey));
}

/**
 * Deductibility exclusivity (issue #143 finding D).
 *
 * `vat.input_deduction_general` (s.59) and `vat.deduction_exclusions_entertainment`
 * (s.60(2)(a)) both carry real conditions and can both genuinely match the
 * same transaction — a client restaurant meal satisfies s.59's own test
 * (VAT-registered, invoiced, business use) *and* falls within the s.60
 * exclusion list. `vat.input_deduction_general`'s own curated `exceptions`
 * array already states the exclusion overrides it ("no deduction
 * regardless of business purpose"); before this function existed,
 * `transactionLookup.ts` only ever surfaced that as review-reason prose —
 * both rules, and their contradictory `vatEffect` text ("deductible" /
 * "no deduction"), still ended up side by side in `applicableRules` and
 * `possibleTreatment.vat`.
 *
 * The fix mirrors `resolveVatRateExclusivity`: it changes no rule's own
 * conditions, only which already-matched rules are kept. If any rule in
 * `VAT_DEDUCTION_EXCLUSION_RULE_KEYS` matched, `VAT_GENERAL_DEDUCTION_RULE_KEY`
 * is dropped — the specific exclusion always wins over the general rule it
 * excepts, never the other way round.
 */
function resolveDeductionExclusivity(
  applicableRules: ApplicableRule[],
  reviewReasons: Set<string>,
): ApplicableRule[] {
  const generalRule = applicableRules.find((r) => r.ruleKey === VAT_GENERAL_DEDUCTION_RULE_KEY);
  if (!generalRule) return applicableRules;

  const matchedExclusions = applicableRules.filter((r) => VAT_DEDUCTION_EXCLUSION_RULE_KEYS.includes(r.ruleKey));
  if (matchedExclusions.length === 0) return applicableRules;

  const excludedNames = matchedExclusions.map((r) => `"${r.name}"`).join(', ');
  reviewReasons.add(
    `Excluded "${generalRule.name}" because ${excludedNames} already matched this transaction — the specific `
    + 'deduction exclusion overrides the general deduction rule it is an exception to, per its own curated exceptions.',
  );

  return applicableRules.filter((r) => r.ruleKey !== VAT_GENERAL_DEDUCTION_RULE_KEY);
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

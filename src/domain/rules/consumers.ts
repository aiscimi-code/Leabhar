/**
 * The computations that read statutory rules, and the keys each reads
 * (ADR-0020 §4, issue #686 step 5).
 *
 * Each area declares its keys in its own `ruleManifest.ts`, beside the code
 * that reads them. `resolveRuleFigure` accepts only a `ManifestRuleKey`, so a
 * figure read without being declared fails the typecheck. `consumers.test.ts`
 * checks every rule key a consumer's source names is declared, and every
 * declared key exists in a loaded book. `syncRuleLinks` loads each manifest
 * as `consumed_by` links, so `impact` lists the computations a change reaches.
 */
import { CORPORATION_TAX_RULE_KEYS, CT1_RULE_KEYS, CT_SUBJECTS_RULE_KEYS } from '../corporationTax/ruleManifest';
import { INCOME_TAX_RULE_KEYS } from '../incomeTax/ruleManifest';
import { PAYROLL_RULE_KEYS } from '../payroll/ruleManifest';
import { CASH_BASIS_RULE_KEYS } from '../vat/cashBasisRuleManifest';
import { FORECAST_RULE_KEYS } from '../forecast/ruleManifest';
import { RCT_RULE_KEYS } from '../construction/ruleManifest';
import { FARM_TAX_RULE_KEYS } from '../farmTax/ruleManifest';
import { COMPANY_SIZE_RULE_KEYS } from '../reports/companySizeRuleManifest';

export interface RuleConsumerManifest {
  name: string;
  /** The source files that read the keys, repo-relative. */
  modules: readonly string[];
  keys: readonly string[];
}

export const RULE_CONSUMERS = {
  corporation_tax: {
    name: 'Corporation tax computation', modules: ['src/domain/corporationTax/computation.ts'], keys: CORPORATION_TAX_RULE_KEYS,
  },
  ct1: { name: 'CT1 return', modules: ['src/domain/corporationTax/ct1.ts'], keys: CT1_RULE_KEYS },
  ct_subjects: {
    name: 'Corporation tax add-backs and deductions', modules: ['src/domain/corporationTax/subjects.ts'], keys: CT_SUBJECTS_RULE_KEYS,
  },
  income_tax: { name: 'Income tax computation', modules: ['src/domain/incomeTax/computation.ts'], keys: INCOME_TAX_RULE_KEYS },
  payroll: { name: 'Payroll', modules: ['src/domain/payroll/compute.ts', 'src/domain/payroll/err.ts'], keys: PAYROLL_RULE_KEYS },
  cash_basis: { name: 'VAT cash receipts basis', modules: ['src/domain/vat/cashBasis.ts'], keys: CASH_BASIS_RULE_KEYS },
  forecast: { name: 'Forecast tax outflows', modules: ['src/domain/forecast/taxOutflows.ts'], keys: FORECAST_RULE_KEYS },
  rct: { name: 'Relevant contracts tax', modules: ['src/domain/construction/rct.ts'], keys: RCT_RULE_KEYS },
  farm_tax: {
    name: 'Farm reliefs', modules: ['src/domain/farmTax/reliefs.ts', 'src/domain/farmTax/partnerships.ts'], keys: FARM_TAX_RULE_KEYS,
  },
  company_size: { name: 'Company size test', modules: ['src/domain/reports/companySize.ts'], keys: COMPANY_SIZE_RULE_KEYS },
} as const satisfies Record<string, RuleConsumerManifest>;

/**
 * Computations that read rules by topic and conditions rather than by a
 * declared key (#694): the transaction lookup reads every rule of a topic it
 * routes a transaction to, and the VAT suggestion acts on the keys its
 * binding and deduction-block tables name. Their keys come from the book and
 * from those tables (`bookDerivedLinks`, ruleLinks.ts), not a manifest, so a
 * new curated rule is covered without an edit. They are not `ManifestRuleKey`s:
 * neither reads a figure through `resolveRuleFigure`.
 */
export const TOPIC_RULE_CONSUMERS = {
  transaction_lookup: { name: 'Transaction rule lookup', modules: ['src/domain/rules/transactionLookup.ts'] },
  vat_suggestion: { name: 'VAT treatment suggestion', modules: ['src/domain/rules/vatSuggestion.ts'] },
} as const satisfies Record<string, Omit<RuleConsumerManifest, 'keys'>>;

export type TopicRuleConsumer = keyof typeof TOPIC_RULE_CONSUMERS;

export type RuleConsumer = keyof typeof RULE_CONSUMERS;
export type ManifestRuleKey = (typeof RULE_CONSUMERS)[RuleConsumer]['keys'][number];

/** How a consumer is named at the other end of a `consumed_by` link. */
export const consumerId = (consumer: RuleConsumer | TopicRuleConsumer) => `consumer:${consumer}`;

/** Every declared consumer's id, by manifest or by topic. */
export const ALL_CONSUMER_IDS: ReadonlySet<string> = new Set(
  [...Object.keys(RULE_CONSUMERS), ...Object.keys(TOPIC_RULE_CONSUMERS)].map((c) => `consumer:${c}`),
);

/** A consumer's name, from its id ("consumer:payroll" → "Payroll"). */
export function consumerName(id: string): string {
  const key = id.replace(/^consumer:/, '');
  return (RULE_CONSUMERS as Record<string, { name: string }>)[key]?.name
    ?? (TOPIC_RULE_CONSUMERS as Record<string, { name: string }>)[key]?.name ?? key;
}

const ALL_KEYS = new Set<string>(Object.values(RULE_CONSUMERS).flatMap((c) => [...c.keys]));

export function isManifestRuleKey(key: string): key is ManifestRuleKey {
  return ALL_KEYS.has(key);
}

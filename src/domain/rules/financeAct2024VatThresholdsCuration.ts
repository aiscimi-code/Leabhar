/**
 * Curated rules for Finance Act 2024 s.78 (amendment of VATCA 2010 s.2(1)'s
 * "goods threshold" and "services threshold" definitions) — the current VAT
 * registration turnover thresholds, effective 1 January 2025.
 *
 * Finance Act 2024 (2024 Act 43) is already ingested as a whole Act
 * (`ingestFinanceAct2024`); this does not ingest a new document, only derives
 * two named rules from a provision that was already parsed but not curated.
 *
 * s.78 states two independent euro figures in one section (the goods
 * threshold and the services threshold), which the generic
 * `SECTION_RULE_KEYS`/`extractFactsFromProvision` pipeline (factExtractor.ts)
 * is not built to split — that pipeline picks a single fact per curated
 * section. Rather than extend a shared, already-relied-on mechanism for one
 * two-value section, this is a small dedicated curation, in the same style
 * as `si639Curation.ts`/`si692025Curation.ts`: explicit statement excerpts
 * and explicit numeric values, verified verbatim against the provision text
 * by a dedicated test.
 *
 * s.78's mechanical category (`categoriseProvision`) is 'definitions' — its
 * text says "in the definition of ... threshold", which matches the
 * definitions keyword rule before anything VAT-specific — so it was ingested
 * as *not relevant* by the default categoriser. `deriveFinanceAct2024VatThresholds`
 * corrects that provision's `relevant` flag when it derives these rules, the
 * same curated-override judgement `SECTION_RULE_KEYS` makes for other
 * sections at ingest time, just applied after the fact since Finance Act
 * 2024 was ingested before this section was reviewed.
 */
import type { IrishRuleCondition, IrishRuleException } from '@/db/schema';

export interface CuratedFinanceAct2024VatThresholdRule {
  ruleKey: string;
  topic: string;
  name: string;
  statementExcerpt: string;
  /** Euro amount in integer minor units (cents) — AGENTS.md invariant #1. */
  numericValueMinor: number;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  vatEffect: string;
  interpretationNote: string;
}

export const FINANCE_ACT_2024_S78_SECTION_NUMBER = '78';
export const FINANCE_ACT_2024_S78_EFFECTIVE_FROM = '2025-01-01';

export const FINANCE_ACT_2024_VAT_THRESHOLD_RULES: CuratedFinanceAct2024VatThresholdRule[] = [
  {
    ruleKey: 'vat.registration_threshold_goods',
    topic: 'vat',
    name: 'VAT registration threshold: supply of goods',
    statementExcerpt: 'in the definition of “goods threshold”, by the substitution of “€85,000” for “€80,000”, and',
    numericValueMinor: 8_500_000, // €85,000
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'goods' },
    ],
    exceptions: [],
    vatEffect: 'A person whose annual turnover from taxable supplies of goods (of the kind to which the goods '
      + 'threshold applies under VATCA 2010 s.2(1)/s.6) has exceeded, or is likely to exceed, €85,000 in any '
      + 'continuous period of 12 months becomes an accountable person and must register for VAT.',
    interpretationNote: 'This is one of two independent VATCA s.2(1) thresholds substituted by the same '
      + 'section (see also vat.registration_threshold_services); which one applies turns on whether the supply '
      + 'is of goods or services, which this KB can only take from an explicit `supplyType` field, never infer '
      + 'from free text. It does not itself compute a business\'s actual rolling annual turnover.',
  },
  {
    ruleKey: 'vat.registration_threshold_services',
    topic: 'vat',
    name: 'VAT registration threshold: supply of services',
    statementExcerpt: 'in the definition of “services threshold”, by the substitution of “€42,500” for “€40,000”.',
    numericValueMinor: 4_250_000, // €42,500
    conditions: [
      { field: 'supplyType', operator: 'equals', value: 'services' },
    ],
    exceptions: [],
    vatEffect: 'A person whose annual turnover from taxable supplies of services (of the kind to which the '
      + 'services threshold applies under VATCA 2010 s.2(1)/s.6) has exceeded, or is likely to exceed, €42,500 '
      + 'in any continuous period of 12 months becomes an accountable person and must register for VAT.',
    interpretationNote: 'This is one of two independent VATCA s.2(1) thresholds substituted by the same '
      + 'section (see also vat.registration_threshold_goods); which one applies turns on whether the supply is '
      + 'of goods or services, which this KB can only take from an explicit `supplyType` field, never infer from '
      + 'free text. It does not itself compute a business\'s actual rolling annual turnover.',
  },
];

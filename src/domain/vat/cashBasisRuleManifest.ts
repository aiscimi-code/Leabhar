/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The cash receipts basis eligibility test (cashBasis.ts). */
export const CASH_BASIS_RULE_KEYS = [
  'vat.cash_accounting_turnover_threshold',
] as const;

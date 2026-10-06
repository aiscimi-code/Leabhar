/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** Relevant contracts tax (rct.ts). */
export const RCT_RULE_KEYS = [
  'rct.penalty_higher_rate_sub', 'rct.penalty_no_determination', 'rct.penalty_standard_rate_sub',
  'rct.penalty_zero_rate_sub',
] as const;

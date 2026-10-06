/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The farm reliefs (reliefs.ts, partnerships.ts). */
export const FARM_TAX_RULE_KEYS = [
  'farm.averaging_years', 'farm.partnership_relief_cap', 'farm.stock_relief_last_year', 'farm.stock_relief_no_loss',
  'farm.stock_relief_rate', 'farm.stock_relief_rate_partnership', 'farm.stock_relief_rate_young_trained',
  'farm.succession_credit', 'farm.young_trained_annual_cap', 'farm.young_trained_further_years',
] as const;

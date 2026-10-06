/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The income tax computation (computation.ts). */
export const INCOME_TAX_RULE_KEYS = [
  'farm.averaging_step_out_interval', 'income_tax.band_married', 'income_tax.band_single',
  'income_tax.band_single_parent', 'income_tax.basis_accounting_period', 'income_tax.basis_cessation',
  'income_tax.basis_first_year', 'income_tax.basis_second_year', 'income_tax.earned_income_credit',
  'income_tax.earned_income_credit_percentage', 'income_tax.personal_credit_married',
  'income_tax.personal_credit_single', 'income_tax.preliminary_tax_current_year',
  'income_tax.preliminary_tax_prior_year', 'income_tax.rate_higher', 'prsi.class_s_disregard',
  'prsi.class_s_minimum', 'prsi.class_s_rate', 'usc.band_05pct', 'usc.band_2pct', 'usc.band_3pct',
  'usc.exemption_threshold', 'usc.rate_top', 'usc.surcharge_non_paye', 'usc.surcharge_threshold',
] as const;

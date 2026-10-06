/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The payslip computation and ERR (compute.ts, err.ts). */
export const PAYROLL_RULE_KEYS = [
  'err.remote_working_daily_allowance', 'err.travel_subsistence_subcategories', 'income_tax.band_single',
  'income_tax.rate_higher', 'paye.cumulative_basis', 'paye.emergency_no_ppsn', 'paye.emergency_ppsn',
  'paye.pension_deduction', 'paye.week1_basis', 'paye.week53', 'prsi.class_a_credit_max',
  'prsi.class_a_credit_upper', 'prsi.class_a_employee_rate', 'prsi.class_a_employee_threshold',
  'prsi.class_a_employer_rate_higher', 'prsi.class_a_employer_rate_lower', 'prsi.class_a_employer_threshold',
  'prsi.class_s_emoluments_rate', 'prsi.ntf_levy_rate', 'small_benefit.cumulative_limit',
  'small_benefit.max_incentives', 'usc.band_05pct', 'usc.band_2pct', 'usc.band_3pct', 'usc.payroll_cumulative',
  'usc.payroll_emergency', 'usc.rate_top',
] as const;

/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The corporation tax computation (computation.ts). */
export const CORPORATION_TAX_RULE_KEYS = [
  // Read through constants and helpers (corporationTaxCuration.ts).
  'ct.rate_standard', 'ct.rate_higher_passive', 'ct.car_specified_amount_2001', 'ct.car_specified_amount_2006',
  'ct.car_specified_amount_2007_onwards', 'ct.car_specified_amount_2002_to_2005',
  'car.co2_group1_max', 'car.co2_group2_max', 'car.group2_fraction', 'car.specified_amount',
  'ct.accelerated_energy_efficient', 'ct.allowances_net_of_grants', 'ct.allowances_not_exceed_cost',
  'ct.amount_still_unallowed', 'ct.balancing_allowance', 'ct.balancing_charge', 'ct.balancing_charge_limit',
  'ct.balancing_charge_small_proceeds', 'ct.capital_expenditure_not_deductible',
  'ct.car_allowances_restricted_to_specified_amount', 'ct.car_disposal_proceeds_scaled_down',
  'ct.close_company_definition', 'ct.close_company_surcharge', 'ct.close_company_surcharge_de_minimis',
  'ct.deduction_only_if_authorised', 'ct.distributable_income', 'ct.distributions_for_period',
  'ct.income_tax_principles', 'ct.loss_carry_forward', 'ct.loss_claim_time_limit', 'ct.loss_value_basis',
  'ct.preliminary_tax_first_period_nil', 'ct.preliminary_tax_large', 'ct.preliminary_tax_large_initial',
  'ct.preliminary_tax_large_initial_prior', 'ct.preliminary_tax_large_total', 'ct.preliminary_tax_small',
  'ct.preliminary_tax_small_current', 'ct.preliminary_tax_small_prior', 'ct.relevant_trading_loss_set_off',
  'ct.return_filing_date', 'ct.service_company_definition', 'ct.service_company_surcharge',
  'ct.small_company_threshold', 'ct.surcharge_later_period', 'ct.surcharge_marginal_relief_cap',
  'ct.taxes_on_income_not_deductible', 'ct.trading_company_reduction', 'ct.wear_and_tear_in_use_at_period_end',
  'ct.wear_and_tear_rate', 'ct.wear_and_tear_short_period', 'farm.buildings_net_of_grants', 'farm.buildings_rate',
  'farm.buildings_years', 'farm.slurry_last_year', 'farm.slurry_rate', 'farm.slurry_relief_cap',
] as const;

/** The CT1 return figures (ct1.ts). */
export const CT1_RULE_KEYS = [
  'ct.income_tax_principles', 'ct.loss_value_basis',
] as const;

/** The add-back and deduction subjects (subjects.ts). */
export const CT_SUBJECTS_RULE_KEYS = [
  'ct.business_entertainment_not_deductible', 'ct.capital_expenditure_not_deductible',
  'ct.not_wholly_and_exclusively', 'ct.private_or_domestic', 'ct.staff_entertainment_deductible',
] as const;

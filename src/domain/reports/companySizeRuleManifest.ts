/**
 * The statutory rule keys the company size test reads (companySize.ts),
 * declared (ADR-0020 §4, issue #686 step 5). See corporationTax/ruleManifest.ts.
 */

const SIZES = ['micro', 'small', 'medium'] as const;

/** Companies Act 2014 s.280A, s.280D, s.280F: each size's three limbs, and the pre-2024 money limbs. */
export const COMPANY_SIZE_RULE_KEYS = [
  'company.medium_company_balance_sheet_threshold', 'company.medium_company_balance_sheet_threshold_pre_2024',
  'company.medium_company_employee_threshold', 'company.medium_company_turnover_threshold',
  'company.medium_company_turnover_threshold_pre_2024', 'company.micro_company_balance_sheet_threshold',
  'company.micro_company_balance_sheet_threshold_pre_2024', 'company.micro_company_employee_threshold',
  'company.micro_company_turnover_threshold', 'company.micro_company_turnover_threshold_pre_2024',
  'company.small_company_balance_sheet_threshold', 'company.small_company_balance_sheet_threshold_pre_2024',
  'company.small_company_employee_threshold', 'company.small_company_turnover_threshold',
  'company.small_company_turnover_threshold_pre_2024',
] as const;

export type CompanySizeRuleKey = (typeof COMPANY_SIZE_RULE_KEYS)[number];
export const COMPANY_SIZE_SIZES = SIZES;

/**
 * Default chart of accounts for a small Irish technology/software company
 * (README §10). Predefined but fully editable: the user can add, rename and
 * deactivate accounts, and any account referenced by a posted journal line can
 * never be deleted.
 *
 * `systemKey` marks the accounts the engine addresses by name. Those cannot be
 * deleted and their key cannot change, because posting logic depends on them
 * existing — but their code, name and description remain the user's to edit.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  systemKey?: SystemAccountKey;
  vatApplicable?: boolean;
  reportSection: string;
  description?: string;
}

/** Accounts the posting engine needs to exist. */
export type SystemAccountKey =
  | 'bank_control'
  | 'cash'
  | 'debtors'
  | 'creditors'
  | 'vat_on_sales'
  | 'vat_on_sales_deferred'
  | 'vat_on_purchases'
  | 'vat_control'
  | 'corporation_tax_liability'
  | 'directors_current_account'
  | 'share_capital'
  | 'retained_earnings'
  | 'suspense'
  | 'fx_gain_loss'
  | 'rounding_difference'
  | 'computer_equipment'
  | 'accumulated_depreciation'
  | 'depreciation_expense'
  | 'disposal_of_assets'
  /** Payroll (issue #357): each statutory deduction the payroll run posts to. */
  | 'paye_payable'
  | 'usc_payable'
  | 'prsi_payable'
  | 'net_wages_payable'
  | 'pension_payable'
  /** Relevant contracts tax (issue #549): tax deducted from subcontractors, held for the Collector-General. */
  | 'rct_payable'
  /** Inventory (issue #359): the stock valuation account opening/closing stock journals use. */
  | 'stock_on_hand'
  /** Accruals and prepayments (issues #367, #368): the timing workflow posts to these. */
  | 'accruals'
  | 'prepayments'
  /** Bad debts (issue #404): what a debt written off is charged to. */
  | 'bad_debts'
  /** Expense claims (issue #306): what a staff expense claim is owed against until reimbursed. */
  | 'staff_expenses_payable'
  /** Dividends paid (issue #489): what the close-company surcharge reads distributions from. */
  | 'dividends_paid'
  /** Payroll costs (issue #527): what the payroll journal debits. */
  | 'wages_expense'
  | 'directors_remuneration'
  | 'employer_pension_expense'
  | 'employer_prsi_expense';

export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  // ---------------- Income ----------------
  { code: '4000', name: 'Software sales', type: 'income', subtype: 'trading_income', reportSection: 'revenue' },
  { code: '4010', name: 'Subscription revenue', type: 'income', subtype: 'trading_income', reportSection: 'revenue' },
  { code: '4020', name: 'Consulting income', type: 'income', subtype: 'trading_income', reportSection: 'revenue' },
  { code: '4090', name: 'Other income', type: 'income', subtype: 'other_income', reportSection: 'revenue' },
  {
    code: '4095', name: 'Foreign exchange gains and losses', type: 'income',
    subtype: 'other_income', systemKey: 'fx_gain_loss', vatApplicable: false,
    reportSection: 'revenue',
    description: 'Differences arising when a foreign-currency balance is settled at a '
      + 'rate other than the one it was recorded at. Kept separate so FX movement '
      + 'is never mistaken for trading performance.',
  },
  {
    code: '4099', name: 'Rounding differences', type: 'income', subtype: 'other_income',
    systemKey: 'rounding_difference', vatApplicable: false, reportSection: 'revenue',
    description: 'Sub-cent differences from allocation and conversion. A material '
      + 'balance here means something is wrong, not something to ignore.',
  },

  // ---------------- Cost of sales ----------------
  { code: '5000', name: 'Direct service costs', type: 'expense', subtype: 'cost_of_sales', reportSection: 'cost_of_sales' },
  { code: '5010', name: 'Subcontractor costs', type: 'expense', subtype: 'cost_of_sales', reportSection: 'cost_of_sales' },
  {
    code: '5020', name: 'Goods for resale', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
    description: 'What was bought in to sell on again (issue #359). Under periodic stock '
      + 'accounting the purchases stay here all year and the balance moves to Stock on hand '
      + '(1300) at the period end; the inventory module (EPIC 23) will post to these two '
      + 'accounts directly.',
  },
  {
    code: '5030', name: 'Materials', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
    description: 'Raw materials and supplies bought in to make or fit out what the '
      + 'business sells — issue #159, for a company whose trade is not pure software/services.',
  },

  // ---------------- Operating expenses ----------------
  { code: '6000', name: 'Software and subscriptions', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6010', name: 'Hosting and infrastructure', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6020', name: 'Domains and DNS', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6030', name: 'Telecommunications', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6040', name: 'Advertising', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6050', name: 'Marketing', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6060', name: 'Professional fees', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6070', name: 'Accountancy fees', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6080', name: 'Legal fees', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6090', name: 'Insurance', type: 'expense', subtype: 'operating_expense', vatApplicable: false, reportSection: 'operating_expenses' },
  { code: '6100', name: 'Bank charges', type: 'expense', subtype: 'operating_expense', vatApplicable: false, reportSection: 'operating_expenses' },
  {
    code: '6230', name: 'Bad debts', type: 'expense', subtype: 'operating_expense',
    systemKey: 'bad_debts', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'Debts written off as irrecoverable (issue #404). A later recovery reverses the write-off.',
  },
  { code: '6110', name: 'Travel and subsistence', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6120', name: 'Office expenses', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6130', name: 'Equipment (below capitalisation threshold)', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6140', name: 'Training and education', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6150', name: 'Repairs and maintenance', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  {
    code: '6160', name: 'Directors remuneration', type: 'expense', subtype: 'operating_expense',
    systemKey: 'directors_remuneration', vatApplicable: false, reportSection: 'operating_expenses',
  },
  {
    code: '6170', name: 'Depreciation', type: 'expense', subtype: 'operating_expense',
    systemKey: 'depreciation_expense', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'The company’s own accounting depreciation charge. This is added '
      + 'back in the corporation tax computation and replaced by capital allowances, '
      + 'because Irish tax law does not accept accounting depreciation as a deduction.',
  },
  {
    code: '6180', name: 'Wages and salaries', type: 'expense', subtype: 'operating_expense',
    systemKey: 'wages_expense', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'Gross employee payroll before deductions, distinct from directors’ '
      + 'remuneration (6160) — issue #159: a rule pointed at 6160 mislabels employee pay '
      + 'as directors’ pay. The statutory deductions taken out of it are held in their own '
      + 'accounts (2410–2450), not netted off here.',
  },
  {
    code: '6185', name: 'Employer pension contributions', type: 'expense',
    subtype: 'operating_expense', systemKey: 'employer_pension_expense', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'The employer’s own pension contribution for staff (issue #357), kept '
      + 'separate from wages (6180) and from the employees’ own deductions, which are not a '
      + 'cost but money held for them in 2450.',
  },
  {
    code: '6190', name: 'Employer PRSI', type: 'expense', subtype: 'operating_expense',
    systemKey: 'employer_prsi_expense', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'The employer’s own PRSI contribution, kept separate from wages '
      + '(6180) so each is visible on its own line.',
  },
  {
    code: '6200', name: 'Rent and rates', type: 'expense', subtype: 'operating_expense',
    vatApplicable: false, reportSection: 'operating_expenses',
    description: 'Commercial rent is usually VAT-exempt unless the landlord has '
      + 'opted to charge VAT on it — confirm against the actual lease.',
  },
  { code: '6900', name: 'Other expenses', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  {
    code: '6950', name: 'Disposal of fixed assets', type: 'expense', subtype: 'operating_expense',
    systemKey: 'disposal_of_assets', vatApplicable: false, reportSection: 'operating_expenses',
  },
  {
    code: '6710', name: 'Loan interest', type: 'expense', subtype: 'finance_cost',
    vatApplicable: false, reportSection: 'finance_costs',
    description: 'Interest on borrowings (issue #358), reported below operating profit so '
      + 'the cost of financing is not mistaken for the cost of running the business. The '
      + 'capital portion of a repayment reduces the loan account (2210/2215), not this '
      + 'account — the two are posted together as a split journal.',
  },

  // ---------------- Assets ----------------
  {
    code: '1000', name: 'Bank current account', type: 'asset', subtype: 'current_asset',
    systemKey: 'bank_control', vatApplicable: false, reportSection: 'current_assets',
  },
  { code: '1010', name: 'Cash', type: 'asset', subtype: 'current_asset', systemKey: 'cash', vatApplicable: false, reportSection: 'current_assets' },
  {
    code: '1020', name: 'Bank deposit / saver account', type: 'asset', subtype: 'current_asset',
    vatApplicable: false, reportSection: 'current_assets',
    description: 'A second bank account’s own ledger — pass this account’s code as '
      + '--account when add-bank creates it, so its balance is tracked separately from '
      + 'the main current account (1000) rather than folding into it (issue #159).',
  },
  {
    code: '1100', name: 'Trade debtors', type: 'asset', subtype: 'current_asset',
    systemKey: 'debtors', vatApplicable: false, reportSection: 'current_assets',
    description: 'Amounts invoiced to customers but not yet received. A balance here '
      + 'is the difference between having issued an invoice and having been paid.',
  },
  {
    code: '1200', name: 'VAT recoverable', type: 'asset', subtype: 'current_asset',
    systemKey: 'vat_on_purchases', vatApplicable: false, reportSection: 'current_assets',
  },
  {
    code: '1300', name: 'Stock on hand', type: 'asset', subtype: 'current_asset',
    systemKey: 'stock_on_hand', vatApplicable: false, reportSection: 'current_assets',
    description: 'The cost of stock held but not yet sold (issue #359), valued at cost. '
      + 'The opening balance journal here and the closing balance against Goods for resale '
      + '(5020) are what turn purchases into a cost of sales: an account kept in step with a '
      + 'count of what is actually on the shelf, never with a figure typed in.',
  },
  {
    code: '1500', name: 'Computer equipment — cost', type: 'asset', subtype: 'fixed_asset',
    systemKey: 'computer_equipment', reportSection: 'fixed_assets',
  },
  {
    code: '1510', name: 'Computer equipment — accumulated depreciation', type: 'asset',
    subtype: 'fixed_asset', systemKey: 'accumulated_depreciation', vatApplicable: false,
    reportSection: 'fixed_assets',
  },
  { code: '1520', name: 'Office equipment — cost', type: 'asset', subtype: 'fixed_asset', reportSection: 'fixed_assets' },
  { code: '1590', name: 'Other fixed assets', type: 'asset', subtype: 'fixed_asset', reportSection: 'fixed_assets' },
  { code: '1600', name: 'Prepayments', type: 'asset', subtype: 'current_asset', systemKey: 'prepayments', vatApplicable: false, reportSection: 'current_assets' },

  // ---------------- Liabilities ----------------
  {
    code: '2000', name: 'Trade creditors', type: 'liability', subtype: 'current_liability',
    systemKey: 'creditors', vatApplicable: false, reportSection: 'current_liabilities',
  },
  {
    code: '2100', name: 'VAT payable', type: 'liability', subtype: 'current_liability',
    systemKey: 'vat_on_sales', vatApplicable: false, reportSection: 'current_liabilities',
  },
  {
    code: '2105', name: 'VAT on sales \u2014 not yet due (cash basis)', type: 'liability',
    subtype: 'current_liability', systemKey: 'vat_on_sales_deferred',
    vatApplicable: false, reportSection: 'current_liabilities',
    description: 'On the cash receipts basis, VAT charged on a sales invoice is not owed to '
      + 'Revenue until the customer pays. It sits here in the meantime and transfers to VAT '
      + 'payable as each payment is received. A balance here is VAT you have charged but not '
      + 'yet been paid.',
  },
  {
    code: '2110', name: 'VAT control', type: 'liability', subtype: 'current_liability',
    systemKey: 'vat_control', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Net VAT position for a period once the return is prepared. '
      + 'The balance here should agree to the VAT3 net figure.',
  },
  {
    code: '2200', name: 'Corporation tax payable', type: 'liability', subtype: 'current_liability',
    systemKey: 'corporation_tax_liability', vatApplicable: false, reportSection: 'current_liabilities',
  },
  {
    code: '2210', name: 'Bank loans', type: 'liability', subtype: 'non_current_liability',
    vatApplicable: false, reportSection: 'long_term_liabilities',
    description: 'A term loan’s outstanding balance (issue #358). Repaying it is a capital/interest '
      + 'split (issue #158’s journal --transaction), not a single expense line — the '
      + 'capital portion reduces this balance and the interest portion is a cost (6710). '
      + 'The part repayable within a year is shown in 2215.',
  },
  {
    code: '2215', name: 'Loans due within one year', type: 'liability', subtype: 'current_liability',
    vatApplicable: false, reportSection: 'current_liabilities',
    description: 'The part of the loans (2210) repayable within the next twelve months '
      + '(issue #358). Reclassified at each year end — Dr 2210 / Cr this account — so the '
      + 'balance sheet shows what is actually due soon, not the whole term of the loan.',
  },
  { code: '2300', name: 'Accruals', type: 'liability', subtype: 'current_liability', systemKey: 'accruals', vatApplicable: false, reportSection: 'current_liabilities' },
  {
    code: '2410', name: 'PAYE (income tax) withheld', type: 'liability', subtype: 'current_liability',
    systemKey: 'paye_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Income tax deducted from employees’ pay and held for Revenue until the '
      + 'payroll return is settled (issue #357). Credited by the payroll run and debited when '
      + 'the payment is made, so its balance is what is owed and nothing else.',
  },
  {
    code: '2420', name: 'USC withheld', type: 'liability', subtype: 'current_liability',
    systemKey: 'usc_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Universal Social Charge deducted from employees’ pay and held for Revenue '
      + 'until the payroll return is settled (issue #357).',
  },
  {
    code: '2430', name: 'PRSI payable (employee and employer)', type: 'liability',
    subtype: 'current_liability', systemKey: 'prsi_payable', vatApplicable: false,
    reportSection: 'current_liabilities',
    description: 'The whole PRSI remitted on a payroll return — the employees’ share '
      + 'deducted from their pay and the employer’s own contribution (6190), which Revenue '
      + 'collects as one amount (issue #357).',
  },
  {
    code: '2440', name: 'Net wages payable', type: 'liability', subtype: 'current_liability',
    systemKey: 'net_wages_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'What employees are owed between the pay run and the net pay leaving the '
      + 'bank (issue #357). Gross wages less their statutory deductions and pension. Zero '
      + 'once wages are paid; a balance that survives a pay date is an exception to resolve.',
  },
  {
    code: '2450', name: 'Pension deductions payable', type: 'liability', subtype: 'current_liability',
    systemKey: 'pension_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Employees’ own pension contributions deducted from their pay and held for '
      + 'the pension provider (issue #357). Not a cost of the business — the employer’s own '
      + 'contribution is 6185.',
  },
  {
    code: '2460', name: 'RCT deducted from subcontractors', type: 'liability', subtype: 'current_liability',
    systemKey: 'rct_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Relevant contracts tax a principal deducted from payments to subcontractors, as each '
      + 'deduction authorisation specified (TCA s.530F; issue #549), held until paid to the '
      + 'Collector-General for the return period (s.530L). Zero once each period is paid.',
  },
  {
    code: '2445', name: 'Staff expenses payable', type: 'liability', subtype: 'current_liability',
    systemKey: 'staff_expenses_payable', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Approved expense claims owed to staff until they are reimbursed '
      + '(issue #306). An officer’s claim is owed on their own current account instead '
      + '(2500), so this is the balance for everyone else. Zero once claims are paid; '
      + 'a balance that survives is an exception to resolve.',
  },
  {
    code: '2500', name: 'Director’s current account', type: 'liability',
    subtype: 'current_liability', systemKey: 'directors_current_account',
    vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Money owed between the company and a director. A credit balance '
      + 'means the company owes the director — usually expenses paid personally. '
      + 'A debit balance means the director owes the company, which for a close '
      + 'company has tax consequences worth discussing with your accountant.',
  },
  {
    code: '2900', name: 'Suspense', type: 'liability', subtype: 'current_liability',
    systemKey: 'suspense', vatApplicable: false, reportSection: 'current_liabilities',
    description: 'Temporary holding account for amounts that are not yet classified. '
      + 'A non-zero balance at period end is an exception to resolve, not a result.',
  },

  // ---------------- Equity ----------------
  {
    code: '3000', name: 'Share capital', type: 'equity', subtype: 'equity',
    systemKey: 'share_capital', vatApplicable: false, reportSection: 'equity',
  },
  {
    code: '3100', name: 'Retained earnings', type: 'equity', subtype: 'equity',
    systemKey: 'retained_earnings', vatApplicable: false, reportSection: 'equity',
  },
  {
    code: '3200', name: 'Dividends', type: 'equity', subtype: 'equity',
    systemKey: 'dividends_paid', vatApplicable: false, reportSection: 'equity',
  },
];

/**
 * Chart variants installable at company creation (issue #360). The farm chart
 * is the same base chart — every system account the posting engine addresses
 * is identical — with the trade-specific slots renamed and the farm's own
 * accounts added, because a farm is not a software company: "Subscription
 * revenue" on a dairy farm is noise, and livestock is nowhere to be seen.
 *
 * EPIC 24 (#319) and #326 (the farm profile) build on top of this; the farm
 * chart itself is EPIC 04's to provide.
 */
export type ChartKind = 'sm' | 'farm';

/**
 * A flat-rate farmer (VATCA s.86) is not registered for VAT and charges none:
 * the buyer self-accounts the flat-rate addition. So for a farm that is not
 * VAT-registered, farm sales and contract work default to not VAT-applicable.
 * A VAT-registered farm charges VAT on both, so those two keep the base
 * chart's VAT setting (see `farmOverrideFor`); the livestock treatment
 * (IE_LIVESTOCK) is there for its sales of animals. Scheme payments are
 * outside the scope of VAT either way.
 */
export const FARM_ACCOUNT_OVERRIDES: Record<string, Omit<AccountSeed, 'code' | 'type' | 'reportSection'>> = {
  '4000': {
    name: 'Farm sales',
    vatApplicable: false,
    description: 'Milk, livestock, crops and other produce sold. A flat-rate farmer charges '
      + 'no VAT — the buyer self-accounts the flat-rate addition (VATCA s.86) — so for a farm '
      + 'that is not VAT-registered this account is not VAT-applicable. A VAT-registered farm '
      + 'charges VAT here, using the livestock treatment for sales of cattle, sheep, goats, pigs '
      + 'and deer.',
  },
  '4010': {
    name: 'Scheme and support income',
    vatApplicable: false,
    description: 'BISS and other CAP scheme payments, ACRES, and similar support. Part of '
      + 'farming profits for tax, and outside the scope of VAT.',
  },
  '4020': {
    name: 'Contract work and services income',
    vatApplicable: false,
    description: 'Hiring out machinery, contract rearing, silage and other services done for '
      + 'other farmers. Within the flat-rate scheme for a farm that is not VAT-registered; '
      + 'VAT-applicable for one that is.',
  },
  '5000': {
    name: 'Casual and seasonal labour',
    description: 'Relief milking, harvest and other casual labour bought in — a direct cost of '
      + 'the year\'s output, not an overhead. PAYE applies to it like any other wage.',
  },
  '5010': {
    name: 'Contractor and machinery hire',
    description: 'Silage, slurry spreading, baling and other work done by agricultural '
      + 'contractors, and machinery hired in.',
  },
};

/** The farm income accounts the flat-rate scheme takes out of VAT, for an unregistered farm only. */
const FLAT_RATE_ONLY_CODES = new Set(['4000', '4020']);

/**
 * The farm override for an account code, given whether the farm is registered
 * for VAT. A registered farm charges VAT on its sales and contract work, so
 * those two keep the base chart's VAT setting rather than being switched off:
 * defaulting them to out-of-scope would understate output VAT.
 */
export function farmOverrideFor(
  code: string, vatRegistered: boolean,
): Omit<AccountSeed, 'code' | 'type' | 'reportSection'> | undefined {
  const override = FARM_ACCOUNT_OVERRIDES[code];
  if (!override || !vatRegistered || !FLAT_RATE_ONLY_CODES.has(code)) return override;
  const { vatApplicable: _flatRateOnly, ...rest } = override;
  return rest;
}

/** Accounts the farm chart adds on top of the (renamed) base chart. */
export const FARM_ACCOUNTS: AccountSeed[] = [
  // ---- Stock on the farm: assets ----
  {
    code: '1330', name: 'Livestock on hand', type: 'asset', subtype: 'current_asset',
    vatApplicable: false, reportSection: 'current_assets',
    description: 'The animals on the farm at the period end, at cost or open-market value. '
      + 'Livestock is trading stock: what is not sold is not yet a cost, and the opening and '
      + 'closing herd counts are what move this balance.',
  },
  {
    code: '1340', name: 'Crops and produce on hand', type: 'asset', subtype: 'current_asset',
    vatApplicable: false, reportSection: 'current_assets',
    description: 'Silage, grain and other produce in store at the period end, at cost.',
  },

  // ---- Farm machinery ----
  {
    code: '1540', name: 'Farm machinery — cost', type: 'asset', subtype: 'fixed_asset',
    reportSection: 'fixed_assets',
    description: 'Tractors, balers, quad bikes and other farm machinery at cost.',
  },
  {
    code: '1545', name: 'Farm machinery — accumulated depreciation', type: 'asset',
    subtype: 'fixed_asset', vatApplicable: false, reportSection: 'fixed_assets',
    description: 'Depreciation charged against farm machinery (1540) over the years.',
  },

  // ---- Farm cost of sales ----
  {
    code: '5040', name: 'Livestock purchases', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
    description: 'Animals bought for resale or for the herd. A flat-rate farmer does not '
      + 'reclaim input VAT — the flat-rate addition exists to compensate for exactly that — '
      + 'so confirm the treatment before posting one.',
  },
  {
    code: '5050', name: 'Feed and forage', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
    description: 'Meal, nuts, silage additive and bought-in forage.',
  },
  {
    code: '5060', name: 'Fertiliser and lime', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
  },
  {
    code: '5070', name: 'Seed, plants and sprays', type: 'expense', subtype: 'cost_of_sales',
    reportSection: 'cost_of_sales',
  },

  // ---- Farm operating expenses ----
  {
    code: '6210', name: 'Veterinary and medicines', type: 'expense', subtype: 'operating_expense',
    reportSection: 'operating_expenses',
    description: 'Vet calls, doses and animal remedies.',
  },
  {
    code: '6220', name: 'Fuel, electricity and water', type: 'expense', subtype: 'operating_expense',
    reportSection: 'operating_expenses',
    description: 'Farm diesel, electricity and water. Marked agricultural gas oil is '
      + 'VAT-liable at the reduced rate for a VAT-registered farm; a flat-rate farmer does not '
      + 'reclaim it.',
  },
];

/** A debit increases assets and expenses; a credit increases the rest. */
export function normalBalance(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/**
 * Signed balance in the account's natural direction: positive means the account
 * is behaving normally (an asset with a debit balance), negative means it is
 * not (an asset in credit), which is usually worth surfacing to the user.
 */
export function signedBalance(
  type: AccountType,
  debitMinor: number,
  creditMinor: number,
): number {
  return normalBalance(type) === 'debit' ? debitMinor - creditMinor : creditMinor - debitMinor;
}

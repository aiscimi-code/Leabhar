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
  | 'disposal_of_assets';

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
  { code: '6110', name: 'Travel and subsistence', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6120', name: 'Office expenses', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6130', name: 'Equipment (below capitalisation threshold)', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6140', name: 'Training and education', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6150', name: 'Repairs and maintenance', type: 'expense', subtype: 'operating_expense', reportSection: 'operating_expenses' },
  { code: '6160', name: 'Directors remuneration', type: 'expense', subtype: 'operating_expense', vatApplicable: false, reportSection: 'operating_expenses' },
  {
    code: '6170', name: 'Depreciation', type: 'expense', subtype: 'operating_expense',
    systemKey: 'depreciation_expense', vatApplicable: false, reportSection: 'operating_expenses',
    description: 'The company’s own accounting depreciation charge. This is added '
      + 'back in the corporation tax computation and replaced by capital allowances, '
      + 'because Irish tax law does not accept accounting depreciation as a deduction.',
  },
  {
    code: '6180', name: 'Wages and salaries', type: 'expense', subtype: 'operating_expense',
    vatApplicable: false, reportSection: 'operating_expenses',
    description: 'Employee payroll, distinct from directors’ remuneration (6160) '
      + '— issue #159: a rule pointed at 6160 mislabels employee pay as directors’ pay.',
  },
  {
    code: '6190', name: 'Employer PRSI', type: 'expense', subtype: 'operating_expense',
    vatApplicable: false, reportSection: 'operating_expenses',
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
  { code: '1600', name: 'Prepayments', type: 'asset', subtype: 'current_asset', vatApplicable: false, reportSection: 'current_assets' },

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
    vatApplicable: false, reportSection: 'current_liabilities',
    description: 'A term loan’s outstanding balance. Repaying it is a capital/interest '
      + 'split (issue #158’s journal --transaction), not a single expense line — the '
      + 'capital portion reduces this balance and the interest portion is a cost.',
  },
  { code: '2300', name: 'Accruals', type: 'liability', subtype: 'current_liability', vatApplicable: false, reportSection: 'current_liabilities' },
  { code: '2400', name: 'PAYE/PRSI/USC payable', type: 'liability', subtype: 'current_liability', vatApplicable: false, reportSection: 'current_liabilities' },
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
  { code: '3200', name: 'Dividends', type: 'equity', subtype: 'equity', vatApplicable: false, reportSection: 'equity' },
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

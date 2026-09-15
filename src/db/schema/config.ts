import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, effectiveDates, ruleSource } from './_shared';
import { companies } from './company';

/**
 * Tax rates (README §6).
 *
 * Rates are integer basis points: 23% is 2300. Never a float, never hard-coded
 * in application logic. A rate referenced by history is deactivated, never
 * deleted, and editing a rate closes the old row's window rather than mutating
 * it — so changing a rate today cannot alter a historical transaction.
 */
export const taxRates = sqliteTable('tax_rates', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  rateBasisPoints: integer('rate_basis_points').notNull(),
  taxType: text('tax_type', {
    enum: ['vat', 'corporation_tax', 'income_tax', 'prsi', 'usc', 'other'],
  }).notNull().default('vat'),
  jurisdiction: text('jurisdiction').notNull().default('IE'),
  /** How this rate is described on the relevant return. */
  reportingClassification: text('reporting_classification'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  ...effectiveDates,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  index('tax_rates_company_idx').on(t.companyId),
  index('tax_rates_lookup_idx').on(t.companyId, t.taxType, t.effectiveFrom),
]);

/**
 * VAT treatments (README §7).
 *
 * The central idea: a transaction carries a *treatment*, not merely a
 * percentage. Zero-rated, exempt and outside-scope are three different things
 * with three different reporting consequences, and this table is what keeps
 * them distinct. Every row is editable by the user.
 */
export const vatTreatments = sqliteTable('vat_treatments', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),

  jurisdiction: text('jurisdiction', {
    enum: ['IE', 'EU', 'NON_EU'],
  }).notNull().default('IE'),
  direction: text('direction', {
    enum: ['sales', 'purchases', 'both'],
  }).notNull().default('both'),
  /** Goods and services report into different statistical boxes. */
  supplyKind: text('supply_kind', {
    enum: ['goods', 'services', 'both'],
  }).notNull().default('both'),

  /** Does a percentage rate attach at all? Exempt and outside-scope: no. */
  appliesRate: integer('applies_rate', { mode: 'boolean' }).notNull().default(true),
  defaultTaxRateId: text('default_tax_rate_id').references(() => taxRates.id),

  /** Self-accounted VAT: produces an output entry and an input entry. */
  isReverseCharge: integer('is_reverse_charge', { mode: 'boolean' })
    .notNull().default(false),
  /** Can input VAT under this treatment be reclaimed at all? */
  isRecoverable: integer('is_recoverable', { mode: 'boolean' })
    .notNull().default(true),
  /** Partial exemption / restricted deductibility, in basis points. 10000 = 100%. */
  recoverableBasisPoints: integer('recoverable_basis_points').notNull().default(10000),

  /**
   * VAT3 box mapping. Without this the filing pack is decorative — the user
   * would still have to translate the report into ROS by hand.
   * T1 VAT on sales, T2 VAT on purchases, E1/E2 goods, ES1/ES2 services,
   * PA1 postponed accounting.
   */
  salesVatBox: text('sales_vat_box'),       // typically T1
  purchasesVatBox: text('purchases_vat_box'), // typically T2
  netSalesBox: text('net_sales_box'),       // E1 / ES1
  netPurchasesBox: text('net_purchases_box'), // E2 / ES2 / PA1

  /** Require a counterparty VAT number, e.g. for intra-Community supply. */
  requiresCounterpartyVatNumber: integer('requires_counterparty_vat_number', {
    mode: 'boolean',
  }).notNull().default(false),

  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  ...effectiveDates,
  ...ruleSource,
  ...timestamps,
}, (t) => [
  index('vat_treatments_company_idx').on(t.companyId),
  unique('vat_treatments_code_unique').on(t.companyId, t.code, t.effectiveFrom),
]);

/**
 * Chart of accounts (README §10). Predefined but fully editable. An account
 * referenced by a posted journal line can be deactivated but never deleted.
 */
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['asset', 'liability', 'equity', 'income', 'expense'],
  }).notNull(),
  subtype: text('subtype'), // current_asset, fixed_asset, cost_of_sales, ...
  parentId: text('parent_id'),

  vatApplicable: integer('vat_applicable', { mode: 'boolean' }).notNull().default(true),
  defaultVatTreatmentId: text('default_vat_treatment_id').references(() => vatTreatments.id),

  /**
   * System accounts are addressed by `systemKey` from engine code (VAT control,
   * debtors, creditors...). They cannot be deleted, and their key cannot change.
   */
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  systemKey: text('system_key'),

  /** Where this account appears in P&L / balance sheet output. */
  reportSection: text('report_section'),
  reportOrder: integer('report_order').notNull().default(0),

  description: text('description'),
  ...effectiveDates,
  ...timestamps,
}, (t) => [
  index('accounts_company_idx').on(t.companyId),
  unique('accounts_code_unique').on(t.companyId, t.code),
  index('accounts_system_key_idx').on(t.companyId, t.systemKey),
]);

/**
 * Accounting periods (README §9), independent from VAT periods.
 * Real date ranges, never derived by a hard-coded quarterly assumption.
 */
export const accountingPeriods = sqliteTable('accounting_periods', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  kind: text('kind', {
    enum: ['financial_year', 'month', 'quarter', 'custom'],
  }).notNull(),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  parentId: text('parent_id'),
  status: text('status', {
    enum: ['open', 'review', 'closed', 'locked'],
  }).notNull().default('open'),
  lockedAt: text('locked_at'),
  lockedBy: text('locked_by'),
  lockReason: text('lock_reason'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('accounting_periods_company_idx').on(t.companyId),
  index('accounting_periods_range_idx').on(t.companyId, t.startDate, t.endDate),
]);

/**
 * VAT periods (README §8). Actual date ranges the user defines or generates.
 * Historical periods are unaffected by later configuration changes.
 */
export const vatPeriods = sqliteTable('vat_periods', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  filingDeadline: text('filing_deadline'),
  paymentDeadline: text('payment_deadline'),
  frequency: text('frequency', {
    enum: ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual', 'custom'],
  }).notNull().default('bi_monthly'),
  status: text('status', {
    enum: ['open', 'review', 'ready', 'locked', 'submitted'],
  }).notNull().default('open'),

  submittedAt: text('submitted_at'),
  submissionReference: text('submission_reference'),
  /** Figures as filed, snapshotted at submission so later edits are visible. */
  filedT1Minor: integer('filed_t1_minor'),
  filedT2Minor: integer('filed_t2_minor'),
  filedT3Minor: integer('filed_t3_minor'),
  filedT4Minor: integer('filed_t4_minor'),

  lockedAt: text('locked_at'),
  lockReason: text('lock_reason'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('vat_periods_company_idx').on(t.companyId),
  index('vat_periods_range_idx').on(t.companyId, t.startDate, t.endDate),
]);

/** Tax/compliance calendar (README §35). Every deadline configurable. */
export const taxDeadlines = sqliteTable('tax_deadlines', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  kind: text('kind', {
    enum: [
      'vat_return', 'vat_rtd', 'corporation_tax_return', 'corporation_tax_preliminary',
      'cro_annual_return', 'financial_statements', 'payroll', 'other',
    ],
  }).notNull(),
  dueDate: text('due_date').notNull(),
  periodStart: text('period_start'),
  periodEnd: text('period_end'),
  vatPeriodId: text('vat_period_id').references(() => vatPeriods.id),
  accountingPeriodId: text('accounting_period_id').references(() => accountingPeriods.id),
  status: text('status', {
    enum: ['upcoming', 'due', 'overdue', 'submitted', 'not_applicable'],
  }).notNull().default('upcoming'),
  completedAt: text('completed_at'),
  reminderDaysBefore: integer('reminder_days_before').notNull().default(14),
  notes: text('notes'),
  ...ruleSource,
  ...timestamps,
}, (t) => [index('tax_deadlines_company_idx').on(t.companyId, t.dueDate)]);

/** FX rates (README §22). A missing rate is an exception, never an assumed 1.0. */
export const fxRates = sqliteTable('fx_rates', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  fromCurrency: text('from_currency').notNull(),
  toCurrency: text('to_currency').notNull(),
  rateDate: text('rate_date').notNull(),
  /** Stored as an exact rational so the conversion is reproducible. */
  rateNumerator: integer('rate_numerator').notNull(),
  rateDenominator: integer('rate_denominator').notNull(),
  source: text('source', {
    enum: ['imported', 'manual', 'ai', 'system', 'ecb', 'revenue'],
  }).notNull().default('manual'),
  sourceReference: text('source_reference'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  unique('fx_rates_unique').on(t.companyId, t.fromCurrency, t.toCurrency, t.rateDate),
  index('fx_rates_lookup_idx').on(t.companyId, t.fromCurrency, t.toCurrency, t.rateDate),
]);

/** Application settings that are not company facts. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  description: text('description'),
  ...timestamps,
});

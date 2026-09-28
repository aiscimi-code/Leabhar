import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { accounts } from './config';

/**
 * Forecast schema (epic #333, issues #565–#570).
 *
 * A forecast is a view beside the ledger — it never writes journals and never
 * changes an invoice or bank line. Snapshots are immutable once saved.
 *
 * Provenance on every line: source in ('ledger','rule','assumption','ai_suggestion').
 * Money in minor units throughout.
 */

// ---------------------------------------------------------------------------
// Forecast settings: the company's defaults (#565, decisions on #333)
// ---------------------------------------------------------------------------
/**
 * The company's forecast defaults. Every one can be overridden for a single
 * forecast. A change is a new row with the next version, never an overwrite
 * (AGENTS.md #6); the latest version stands.
 */
export const forecastSettings = sqliteTable('forecast_settings', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  version: integer('version').notNull(),
  /** 'due_date': the invoice due date; 'customer_history': each customer's average days late. */
  receiptBasis: text('receipt_basis', { enum: ['due_date', 'customer_history'] }).notNull().default('due_date'),
  horizonDays: integer('horizon_days').notNull().default(90),
  granularity: text('granularity', { enum: ['daily', 'weekly', 'monthly'] }).notNull().default('weekly'),
  /** The low-point warning threshold, in base minor units. */
  minimumCashMinor: integer('minimum_cash_minor').notNull().default(0),
  /** JSON array of ledger account ids counted as cash; null for the default (bank and cash accounts). */
  cashAccountIds: text('cash_account_ids', { mode: 'json' }).$type<string[] | null>(),
  includePurchaseOrders: integer('include_purchase_orders', { mode: 'boolean' }).notNull().default(false),
  /** Draft invoices shown separately, with their own running balance; never mixed in. */
  includeUnconfirmed: integer('include_unconfirmed', { mode: 'boolean' }).notNull().default(false),
  /** Sole traders: include the owner's income tax, which may be paid from personal funds. */
  includeOwnerTax: integer('include_owner_tax', { mode: 'boolean' }).notNull().default(true),
  /**
   * 'statutory', or 'ros' where the company files and pays on ROS: the later
   * ROS date applies only to a tax whose ROS date has a source (#566).
   */
  dueDateBasis: text('due_date_basis', { enum: ['statutory', 'ros'] }).notNull().default('statutory'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('forecast_settings_version').on(t.companyId, t.version),
]);

// ---------------------------------------------------------------------------
// Forecast snapshots (immutable once saved; #565)
// ---------------------------------------------------------------------------
export const forecastSnapshots = sqliteTable('forecast_snapshots', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  asOf: text('as_of').notNull(),
  horizonEnd: text('horizon_end').notNull(),
  /** The scenario the forecast was built with, if any. */
  scenarioId: text('scenario_id'),
  /** JSON: the options the forecast was built with. */
  optionsJson: text('options_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** JSON: the whole forecast result as computed. */
  resultJson: text('result_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  savedBy: text('saved_by').notNull(),
  ...timestamps,
}, (t) => [
  index('forecast_snapshots_co').on(t.companyId, t.asOf),
]);

// ---------------------------------------------------------------------------
// Recurring forecast items (confirmed patterns from bank history; #567)
// ---------------------------------------------------------------------------
export const recurringForecastItems = sqliteTable('recurring_forecast_items', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** Human-readable label */
  description: text('description').notNull(),
  /** 'inflow' or 'outflow' */
  direction: text('direction', { enum: ['inflow', 'outflow'] }).notNull(),
  /** Amount in base minor units (positive) */
  amountMinor: integer('amount_minor').notNull(),
  /** Optional: band — the lower bound (amountMinor) and upper (amountMaxMinor) if variable */
  amountMaxMinor: integer('amount_max_minor'),
  frequency: text('frequency', { enum: ['weekly', 'monthly', 'quarterly', 'yearly'] }).notNull(),
  /** ISO date of first occurrence */
  startDate: text('start_date').notNull(),
  /** ISO date of last occurrence; null = ongoing */
  endDate: text('end_date'),
  /** ISO date of next expected occurrence */
  nextDate: text('next_date'),
  /** 'confirmed' | 'dismissed' */
  status: text('status', { enum: ['confirmed', 'dismissed'] }).notNull().default('confirmed'),
  /** The payee / counterparty from the detected bank pattern */
  payeePattern: text('payee_pattern'),
  /** Source of the item */
  source: text('source', { enum: ['detected', 'manual'] }).notNull().default('manual'),
  confirmedBy: text('confirmed_by'),
  confirmedAt: text('confirmed_at'),
  notes: text('notes'),
  /** A change is a new row; the old one points at it and stays readable (#567). */
  supersededById: text('superseded_by_id'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('recurring_forecast_items_co').on(t.companyId, t.status),
]);

// ---------------------------------------------------------------------------
// Recurring bank pattern suggestions (ai_suggestion, unconfirmed; #567)
// ---------------------------------------------------------------------------
export const recurringBankPatterns = sqliteTable('recurring_bank_patterns', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The payee as it appears on the bank lines. */
  payeePattern: text('payee_pattern').notNull(),
  /** The normalised payee and direction the pattern is matched on, so a dismissed pattern is not suggested again. */
  patternKey: text('pattern_key').notNull(),
  direction: text('direction', { enum: ['inflow', 'outflow'] }).notNull(),
  /** Median amount in base minor units */
  medianAmountMinor: integer('median_amount_minor').notNull(),
  amountMinMinor: integer('amount_min_minor').notNull(),
  amountMaxMinor: integer('amount_max_minor').notNull(),
  detectedFrequency: text('detected_frequency', { enum: ['weekly', 'monthly', 'quarterly', 'yearly'] }).notNull(),
  /** Number of occurrences found */
  occurrenceCount: integer('occurrence_count').notNull(),
  firstSeenDate: text('first_seen_date').notNull(),
  lastSeenDate: text('last_seen_date').notNull(),
  /** 'suggested' | 'confirmed' | 'dismissed' */
  status: text('status', { enum: ['suggested', 'confirmed', 'dismissed'] }).notNull().default('suggested'),
  confirmedItemId: text('confirmed_item_id'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: text('reviewed_at'),
  ...timestamps,
}, (t) => [
  index('recurring_bank_patterns_co').on(t.companyId, t.status),
  uniqueIndex('recurring_bank_patterns_key').on(t.companyId, t.patternKey),
]);

// ---------------------------------------------------------------------------
// Company budget (versioned, #569)
// ---------------------------------------------------------------------------
export const companyBudgets = sqliteTable('company_budgets', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** ISO fiscal year end, e.g. '2026-12-31' */
  financialYearEnd: text('financial_year_end').notNull(),
  /** Sequential version number per company-year */
  version: integer('version').notNull(),
  name: text('name').notNull(),
  /** 'current' | 'superseded' */
  status: text('status', { enum: ['current', 'superseded'] }).notNull().default('current'),
  /** 'entered' | 'import' | 'copied_actuals' | 'copied_budget' */
  source: text('source', { enum: ['entered', 'import', 'copied_actuals', 'copied_budget'] }).notNull().default('entered'),
  reason: text('reason'),
  /** JSON: optional per-account adjustment percentages used when copying */
  adjustmentsJson: text('adjustments_json'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('company_budgets_co').on(t.companyId, t.financialYearEnd, t.version),
]);

export const companyBudgetLines = sqliteTable('company_budget_lines', {
  id: text('id').primaryKey(),
  budgetId: text('budget_id').notNull().references(() => companyBudgets.id),
  companyId: text('company_id').notNull().references(() => companies.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  /** ISO month start, e.g. '2026-01-01' */
  monthStart: text('month_start').notNull(),
  /** The budgeted amount in base minor units, in the account's natural direction (income and expense positive). */
  amountMinor: integer('amount_minor').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('company_budget_lines_uq').on(t.budgetId, t.accountId, t.monthStart),
  index('company_budget_lines_co').on(t.companyId, t.budgetId),
]);

// ---------------------------------------------------------------------------
// Forecast scenarios (#570)
// ---------------------------------------------------------------------------
export const forecastScenarios = sqliteTable('forecast_scenarios', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('forecast_scenarios_co').on(t.companyId),
]);

export const scenarioAdjustments = sqliteTable('scenario_adjustments', {
  id: text('id').primaryKey(),
  scenarioId: text('scenario_id').notNull().references(() => forecastScenarios.id),
  companyId: text('company_id').notNull().references(() => companies.id),
  /**
   * kind:
   *   'customer_payment_delay' — customers pay N days late (all or one customer)
   *   'revenue_change' — revenue up/down by a percentage
   *   'cost_change' — costs up/down by a percentage (per account or overall)
   *   'one_off' — a single inflow or outflow
   *   'new_hire' — a new hire from a date at a salary
   *   'recurring_item' — a new recurring flow
   */
  kind: text('kind', {
    enum: ['customer_payment_delay', 'revenue_change', 'cost_change', 'one_off', 'new_hire', 'recurring_item'],
  }).notNull(),
  /** Optional: the customer (payment delay, revenue change) or supplier (cost change) the adjustment is limited to. */
  targetId: text('target_id'),
  /** For delays: number of days */
  delayDays: integer('delay_days'),
  /** For percentage changes: basis points (positive = increase, negative = decrease) */
  changeBasisPoints: integer('change_basis_points'),
  /**
   * In base minor units: a one-off is signed (negative is money out); a new
   * hire is the monthly employment cost as entered (positive); a recurring
   * item is signed.
   */
  amountMinor: integer('amount_minor'),
  /** For recurring_item: frequency */
  frequency: text('frequency', { enum: ['weekly', 'monthly', 'quarterly', 'yearly'] }),
  /** ISO start date the adjustment applies from */
  fromDate: text('from_date').notNull(),
  /** ISO end date; null = through horizon */
  toDate: text('to_date'),
  description: text('description').notNull(),
  ...timestamps,
}, (t) => [
  index('scenario_adjustments_scen').on(t.scenarioId),
]);

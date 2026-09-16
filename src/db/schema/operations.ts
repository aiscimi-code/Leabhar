import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies } from './company';
import { accounts, vatTreatments } from './config';
import { suppliers } from './parties';
import { documents } from './documents';
import { invoices } from './invoices';

/**
 * Deterministic rules engine (README §18).
 *
 * Rules are data, not code, so the user can inspect and edit every one of them.
 * A confirmed rule takes precedence over an AI suggestion — see the precedence
 * order in docs/DOMAIN_MODEL.md §10.
 */
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),

  /** Lower numbers evaluate first; the first matching rule wins. */
  priority: integer('priority').notNull().default(100),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

  appliesTo: text('applies_to', {
    enum: ['bank_transaction', 'document', 'invoice', 'any'],
  }).notNull().default('bank_transaction'),

  /** All conditions must hold (AND). Kept simple and inspectable on purpose. */
  conditions: text('conditions', { mode: 'json' }).$type<Array<{
    field: string;
    operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with'
      | 'ends_with' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_null';
    value: string | number | Array<string | number> | null;
    caseSensitive?: boolean;
  }>>().notNull().default([]),

  actions: text('actions', { mode: 'json' }).$type<Array<{
    field: 'accountId' | 'vatTreatmentId' | 'supplierId' | 'customerId'
      | 'status' | 'notes' | 'documentType' | 'isCapital';
    value: string | null;
  }>>().notNull().default([]),

  /** Whether a match applies the action or merely suggests it. */
  autoApply: integer('auto_apply', { mode: 'boolean' }).notNull().default(false),
  stopOnMatch: integer('stop_on_match', { mode: 'boolean' }).notNull().default(true),

  timesApplied: integer('times_applied').notNull().default(0),
  lastAppliedAt: text('last_applied_at'),

  /** Rules learned from confirmed history are flagged as such. */
  derivedFromHistory: integer('derived_from_history', { mode: 'boolean' })
    .notNull().default(false),
  supplierId: text('supplier_id').references(() => suppliers.id),

  notes: text('notes'),
  ...timestamps,
}, (t) => [index('rules_company_idx').on(t.companyId, t.enabled, t.priority)]);

/**
 * Fixed asset register (README §29).
 *
 * Accounting depreciation and tax capital allowances are tracked separately,
 * because Irish tax does not accept accounting depreciation — it gives
 * wear-and-tear allowances instead. Keeping both is what makes the
 * accounting-profit to tax-adjusted-profit bridge (§33) computable rather than
 * hand-waved.
 */
export const fixedAssets = sqliteTable('fixed_assets', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  assetCategory: text('asset_category', {
    enum: [
      'computer_equipment', 'office_equipment', 'furniture_fittings',
      'motor_vehicles', 'plant_machinery', 'intangible', 'other',
    ],
  }).notNull().default('computer_equipment'),

  purchaseDate: text('purchase_date').notNull(),
  supplierId: text('supplier_id').references(() => suppliers.id),
  invoiceId: text('invoice_id').references(() => invoices.id),
  documentId: text('document_id').references(() => documents.id),

  costMinor: integer('cost_minor').notNull(),
  vatMinor: integer('vat_minor').notNull().default(0),
  currency: text('currency').notNull(),
  baseCostMinor: integer('base_cost_minor').notNull(),
  baseCurrency: text('base_currency').notNull(),

  accountId: text('account_id').references(() => accounts.id),
  accumulatedDepreciationAccountId: text('accumulated_depreciation_account_id')
    .references(() => accounts.id),
  depreciationExpenseAccountId: text('depreciation_expense_account_id')
    .references(() => accounts.id),

  // Accounting depreciation — the company's own policy.
  depreciationMethod: text('depreciation_method', {
    enum: ['straight_line', 'reducing_balance', 'none'],
  }).notNull().default('straight_line'),
  usefulLifeMonths: integer('useful_life_months').notNull().default(48),
  residualValueMinor: integer('residual_value_minor').notNull().default(0),
  depreciationStartDate: text('depreciation_start_date'),
  accumulatedDepreciationMinor: integer('accumulated_depreciation_minor')
    .notNull().default(0),

  /**
   * Tax capital allowances, configured not hard-coded. Seeded at 12.5% over
   * 8 years, which is the standard Irish wear-and-tear position, with the
   * source recorded so the user can verify it rather than trust it.
   */
  capitalAllowanceRateBasisPoints: integer('capital_allowance_rate_basis_points')
    .notNull().default(1250),
  capitalAllowanceYears: integer('capital_allowance_years').notNull().default(8),
  accumulatedCapitalAllowancesMinor: integer('accumulated_capital_allowances_minor')
    .notNull().default(0),
  capitalAllowanceNotes: text('capital_allowance_notes'),

  disposalDate: text('disposal_date'),
  disposalProceedsMinor: integer('disposal_proceeds_minor'),
  disposalNotes: text('disposal_notes'),

  status: text('status', {
    enum: ['pending_review', 'active', 'fully_depreciated', 'disposed', 'written_off'],
  }).notNull().default('pending_review'),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [index('fixed_assets_company_idx').on(t.companyId, t.status)]);

/** Depreciation and capital allowance charges, per period, per asset. */
export const depreciationCharges = sqliteTable('depreciation_charges', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  fixedAssetId: text('fixed_asset_id').notNull().references(() => fixedAssets.id),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  chargeType: text('charge_type', {
    enum: ['accounting_depreciation', 'capital_allowance'],
  }).notNull(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  journalEntryId: text('journal_entry_id'),
  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [index('depreciation_asset_idx').on(t.fixedAssetId, t.periodStart)]);

/**
 * The review / needs-attention queue (README §20).
 *
 * The objective from §20 is that the user spends time only on exceptions, so
 * every validation, integrity check and uncertain suggestion lands here as a
 * row with enough context to resolve it in place.
 */
export const reviewItems = sqliteTable('review_items', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),

  kind: text('kind', {
    enum: [
      'unmatched_transaction', 'unclassified_transaction', 'missing_document',
      'uncertain_vat_treatment', 'uncertain_match', 'suspected_duplicate',
      'currency_discrepancy', 'invoice_total_mismatch', 'missing_fx_rate',
      'unbalanced_journal', 'capital_purchase_review', 'missing_vat_number',
      'negative_vat', 'transaction_outside_period', 'unresolved_ai_suggestion',
      'extraction_failed', 'reconciliation_difference', 'period_validation',
      'other',
    ],
  }).notNull(),

  severity: text('severity', { enum: ['info', 'warning', 'error', 'blocking'] })
    .notNull().default('warning'),
  title: text('title').notNull(),
  detail: text('detail').notNull(),

  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  /** Enough context to resolve the item without navigating away. */
  context: text('context', { mode: 'json' })
    .$type<Record<string, unknown>>().notNull().default({}),

  /** Actions the UI can offer inline. */
  suggestedActions: text('suggested_actions', { mode: 'json' })
    .$type<Array<{ label: string; action: string; payload?: Record<string, unknown> }>>()
    .notNull().default([]),

  status: text('status', {
    enum: ['open', 'resolved', 'dismissed', 'snoozed', 'superseded'],
  }).notNull().default('open'),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
  resolution: text('resolution'),
  snoozedUntil: text('snoozed_until'),

  /** Stable key so a repeated check updates its item rather than duplicating it. */
  dedupeKey: text('dedupe_key').notNull(),

  vatPeriodId: text('vat_period_id'),
  accountingPeriodId: text('accounting_period_id'),
  ...timestamps,
}, (t) => [
  index('review_items_company_idx').on(t.companyId, t.status, t.severity),
  index('review_items_dedupe_idx').on(t.companyId, t.dedupeKey),
  index('review_items_entity_idx').on(t.entityType, t.entityId),
]);

/**
 * Audit trail (README §31).
 *
 * Append-only, and written inside the same database transaction as the change
 * it describes, so an audited change cannot half-happen.
 */
export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  occurredAt: text('occurred_at').notNull(),

  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),

  action: text('action', {
    enum: [
      'created', 'updated', 'deleted', 'voided', 'classified', 'vat_changed',
      'document_matched', 'document_unmatched', 'period_locked', 'period_unlocked',
      'adjustment_posted', 'user_confirmed', 'user_rejected', 'ai_suggested',
      'rule_applied', 'import_completed', 'import_reversed', 'reversal_posted',
      'reconciled', 'backup_created', 'backup_restored', 'settings_changed',
    ],
  }).notNull(),

  field: text('field'),
  previousValue: text('previous_value'),
  newValue: text('new_value'),

  source: text('source', { enum: ['ai', 'rule', 'user', 'import', 'system', 'derived'] })
    .notNull().default('user'),
  actor: text('actor').notNull().default('user'),
  reason: text('reason'),
  /** Groups every audit row written by one logical operation. */
  requestId: text('request_id'),
  ...timestamps,
}, (t) => [
  index('audit_entity_idx').on(t.entityType, t.entityId),
  index('audit_company_time_idx').on(t.companyId, t.occurredAt),
  index('audit_request_idx').on(t.requestId),
]);

/** Local single-user authentication (README §3). */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  /** scrypt, with the salt and parameters stored alongside the hash. */
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  role: text('role', { enum: ['owner', 'user', 'readonly'] }).notNull().default('owner'),
  lastLoginAt: text('last_login_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdIp: text('created_ip'),
  ...timestamps,
}, (t) => [index('sessions_token_idx').on(t.tokenHash)]);

/** Versioned backups (README §45). Never overwrites the previous backup. */
export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  version: integer('version').notNull(),
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  sha256: text('sha256'),
  includesDatabase: integer('includes_database', { mode: 'boolean' }).notNull().default(true),
  includesDocuments: integer('includes_documents', { mode: 'boolean' }).notNull().default(true),
  includesConfiguration: integer('includes_configuration', { mode: 'boolean' })
    .notNull().default(true),
  documentCount: integer('document_count').notNull().default(0),
  status: text('status', { enum: ['running', 'completed', 'failed'] })
    .notNull().default('running'),
  errorMessage: text('error_message'),
  notes: text('notes'),
  ...timestamps,
});

/** Glossary (README §41). Seeded, user-extendable. */
export const glossaryTerms = sqliteTable('glossary_terms', {
  id: text('id').primaryKey(),
  term: text('term').notNull(),
  slug: text('slug').notNull().unique(),
  shortDefinition: text('short_definition').notNull(),
  longDefinition: text('long_definition'),
  category: text('category'),
  relatedTerms: text('related_terms', { mode: 'json' }).$type<string[]>()
    .notNull().default([]),
  irishContext: text('irish_context'),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
});

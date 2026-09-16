import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies, bankAccounts } from './company';
import { accounts, accountingPeriods, vatTreatments } from './config';
import { suppliers, customers } from './parties';

/**
 * Bank statement imports (README §13, §14).
 *
 * Every imported transaction traces back to the import run that created it, so
 * an import can be inspected or, if it went wrong, reversed as a unit.
 */
export const statementImports = sqliteTable('statement_imports', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  bankAccountId: text('bank_account_id').notNull().references(() => bankAccounts.id),
  filename: text('filename').notNull(),
  fileHash: text('file_hash').notNull(),
  fileFormat: text('file_format', { enum: ['csv', 'xlsx', 'pdf', 'ofx', 'manual'] }).notNull(),
  importProfileId: text('import_profile_id'),

  statementStartDate: text('statement_start_date'),
  statementEndDate: text('statement_end_date'),
  openingBalanceMinor: integer('opening_balance_minor'),
  closingBalanceMinor: integer('closing_balance_minor'),

  rowsRead: integer('rows_read').notNull().default(0),
  rowsImported: integer('rows_imported').notNull().default(0),
  rowsDuplicate: integer('rows_duplicate').notNull().default(0),
  rowsFailed: integer('rows_failed').notNull().default(0),

  status: text('status', {
    enum: ['pending', 'completed', 'completed_with_errors', 'failed', 'reversed'],
  }).notNull().default('pending'),
  errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),

  importedBy: text('imported_by').notNull().default('user'),
  ...timestamps,
}, (t) => [index('statement_imports_company_idx').on(t.companyId)]);

/**
 * A remembered column mapping for a bank's statement format (README §13).
 * The user maps columns once per bank; subsequent imports reuse the profile.
 */
export const importProfiles = sqliteTable('import_profiles', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  bankAccountId: text('bank_account_id').references(() => bankAccounts.id),
  fileFormat: text('file_format', { enum: ['csv', 'xlsx', 'pdf', 'ofx'] }).notNull().default('csv'),

  /** Header fingerprint, so a familiar format is recognised automatically. */
  headerSignature: text('header_signature'),
  delimiter: text('delimiter').notNull().default(','),
  encoding: text('encoding').notNull().default('utf-8'),
  skipRows: integer('skip_rows').notNull().default(0),
  hasHeaderRow: integer('has_header_row', { mode: 'boolean' }).notNull().default(true),

  /** Source column name (or index) -> domain field. */
  columnMap: text('column_map', { mode: 'json' })
    .$type<Record<string, string>>().notNull().default({}),

  dateFormat: text('date_format', { enum: ['day_first', 'month_first', 'iso'] })
    .notNull().default('day_first'),
  decimalSeparator: text('decimal_separator', { enum: ['.', ','] }).notNull().default('.'),
  /** Some banks use separate debit/credit columns instead of a signed amount. */
  amountStyle: text('amount_style', {
    enum: ['signed', 'debit_credit_columns', 'amount_with_indicator'],
  }).notNull().default('signed'),
  /** Some banks report money out as a positive number. */
  invertAmountSign: integer('invert_amount_sign', { mode: 'boolean' })
    .notNull().default(false),
  defaultCurrency: text('default_currency').notNull().default('EUR'),

  timesUsed: integer('times_used').notNull().default(0),
  lastUsedAt: text('last_used_at'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('import_profiles_company_idx').on(t.companyId)]);

/**
 * Bank transactions (README §15).
 *
 * Invariant #4: this row is evidence and is write-once. Classification,
 * matching and reconciliation live in adjacent columns and tables; the imported
 * facts (date, amount, description, reference) are never edited. A correction
 * to bad source data means re-importing, not overwriting.
 */
export const bankTransactions = sqliteTable('bank_transactions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  bankAccountId: text('bank_account_id').notNull().references(() => bankAccounts.id),
  statementImportId: text('statement_import_id').references(() => statementImports.id),

  // ---- Imported evidence. Never mutated after insert. ----
  transactionDate: text('transaction_date').notNull(),
  valueDate: text('value_date'),
  description: text('description').notNull(),
  amountMinor: integer('amount_minor').notNull(), // signed: negative is money out
  currency: text('currency').notNull(),
  balanceAfterMinor: integer('balance_after_minor'),
  bankReference: text('bank_reference'),
  /** The bank's own transaction id where the statement provides one (§13). */
  bankTransactionId: text('bank_transaction_id'),
  counterpartyName: text('counterparty_name'),
  counterpartyIban: text('counterparty_iban'),
  transactionType: text('transaction_type'), // card, transfer, direct debit, fee...
  rawData: text('raw_data', { mode: 'json' })
    .$type<Record<string, string>>().notNull().default({}),

  /**
   * Deterministic fingerprint over (account, date, amount, currency, reference,
   * description) plus an occurrence index, so importing the same statement
   * twice adds nothing while two genuinely identical same-day charges both
   * survive (README §13).
   */
  fingerprint: text('fingerprint').notNull(),
  occurrenceIndex: integer('occurrence_index').notNull().default(0),

  // ---- Derived / user-owned. Freely updatable. ----
  accountingPeriodId: text('accounting_period_id').references(() => accountingPeriods.id),
  accountId: text('account_id').references(() => accounts.id),
  vatTreatmentId: text('vat_treatment_id').references(() => vatTreatments.id),
  supplierId: text('supplier_id').references(() => suppliers.id),
  customerId: text('customer_id').references(() => customers.id),

  /** Base-currency conversion, where the account is not in base currency. */
  baseAmountMinor: integer('base_amount_minor'),
  baseCurrency: text('base_currency'),
  fxRateNumerator: integer('fx_rate_numerator'),
  fxRateDenominator: integer('fx_rate_denominator'),
  fxRateSource: text('fx_rate_source'),

  status: text('status', {
    enum: [
      'unclassified', 'suggested', 'classified', 'matched',
      'posted', 'reconciled', 'ignored', 'duplicate',
    ],
  }).notNull().default('unclassified'),

  journalEntryId: text('journal_entry_id'),
  reconciliationId: text('reconciliation_id'),
  reconciledAt: text('reconciled_at'),

  /** Which rule, if any, produced the current classification. */
  appliedRuleId: text('applied_rule_id'),

  isDuplicateOf: text('is_duplicate_of'),
  duplicateConfirmed: integer('duplicate_confirmed', { mode: 'boolean' })
    .notNull().default(false),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('bank_tx_company_idx').on(t.companyId),
  index('bank_tx_account_date_idx').on(t.bankAccountId, t.transactionDate),
  index('bank_tx_status_idx').on(t.companyId, t.status),
  index('bank_tx_amount_idx').on(t.companyId, t.amountMinor),
  unique('bank_tx_fingerprint_unique').on(t.bankAccountId, t.fingerprint, t.occurrenceIndex),
]);

/** Bank reconciliation (README §21). */
export const reconciliations = sqliteTable('reconciliations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  bankAccountId: text('bank_account_id').notNull().references(() => bankAccounts.id),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),

  /** Per the statement, i.e. the evidence. */
  statementClosingBalanceMinor: integer('statement_closing_balance_minor').notNull(),
  /** Per the accounting ledger. */
  ledgerBalanceMinor: integer('ledger_balance_minor').notNull(),
  differenceMinor: integer('difference_minor').notNull(),
  currency: text('currency').notNull(),

  unmatchedCount: integer('unmatched_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  missingDocumentCount: integer('missing_document_count').notNull().default(0),

  status: text('status', {
    enum: ['draft', 'in_progress', 'balanced', 'unbalanced', 'completed'],
  }).notNull().default('draft'),
  completedAt: text('completed_at'),
  completedBy: text('completed_by'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('reconciliations_company_idx').on(t.companyId)]);

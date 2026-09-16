import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies } from './company';
import { accounts, accountingPeriods, vatPeriods, taxRates, vatTreatments } from './config';
import { suppliers, customers } from './parties';

/**
 * Journal entries — the accounting source of truth (README §4).
 *
 * Invariant #2: a posted entry is immutable. There is no update path for a row
 * with `postedAt` set. Corrections are reversing entries that reference the
 * original via `reversalOfId`. This is what makes "append-only" (§31) real
 * rather than aspirational.
 */
export const journalEntries = sqliteTable('journal_entries', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),

  /** Sequential, gapless, assigned at post time. Auditors expect this. */
  entryNumber: integer('entry_number').notNull(),

  entryDate: text('entry_date').notNull(),
  accountingPeriodId: text('accounting_period_id').references(() => accountingPeriods.id),
  narrative: text('narrative').notNull(),

  /** What caused this entry to exist. */
  sourceType: text('source_type', {
    enum: [
      'bank_transaction', 'sales_invoice', 'purchase_invoice', 'payment',
      'manual_adjustment', 'opening_balance', 'fixed_asset', 'depreciation',
      'fx_revaluation', 'vat_period_close', 'year_end_close', 'reversal',
    ],
  }).notNull(),
  sourceId: text('source_id'),

  entryType: text('entry_type', {
    enum: ['standard', 'adjustment', 'reversal', 'opening', 'closing'],
  }).notNull().default('standard'),

  postedAt: text('posted_at'),
  /** Draft entries can be edited; posted ones cannot. */
  isPosted: integer('is_posted', { mode: 'boolean' }).notNull().default(false),

  reversalOfId: text('reversal_of_id'),
  reversedByEntryId: text('reversed_by_entry_id'),
  reversalReason: text('reversal_reason'),

  createdBy: text('created_by').notNull().default('system'),
  createdVia: text('created_via', {
    enum: ['user', 'rule', 'import', 'system', 'ai'],
  }).notNull().default('system'),

  /** Completes the provenance shape alongside createdBy/createdVia. */
  confidence: integer('confidence'),
  provenanceStatus: text('provenance_status', {
    enum: [
      'ai_suggestion', 'user_confirmed', 'user_rejected',
      'system_rule', 'imported', 'manually_entered',
    ],
  }).notNull().default('manually_entered'),

  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('journal_entries_company_idx').on(t.companyId),
  index('journal_entries_date_idx').on(t.companyId, t.entryDate),
  index('journal_entries_source_idx').on(t.sourceType, t.sourceId),
  unique('journal_entries_number_unique').on(t.companyId, t.entryNumber),
]);

/**
 * Journal lines. Exactly one of debit/credit is non-zero per line, and the
 * base-currency debits and credits of an entry must sum equal. Both rules are
 * enforced at post time inside the same transaction as the insert.
 */
export const journalLines = sqliteTable('journal_lines', {
  id: text('id').primaryKey(),
  journalEntryId: text('journal_entry_id').notNull().references(() => journalEntries.id),
  companyId: text('company_id').notNull().references(() => companies.id),
  lineNumber: integer('line_number').notNull(),
  accountId: text('account_id').notNull().references(() => accounts.id),

  /** Amounts as transacted. */
  debitMinor: integer('debit_minor').notNull().default(0),
  creditMinor: integer('credit_minor').notNull().default(0),
  currency: text('currency').notNull(),

  /** Amounts in the company's base currency. The balancing check uses these. */
  baseDebitMinor: integer('base_debit_minor').notNull().default(0),
  baseCreditMinor: integer('base_credit_minor').notNull().default(0),
  baseCurrency: text('base_currency').notNull(),

  /** The exact rational rate used, so the conversion is reproducible (§22). */
  fxRateNumerator: integer('fx_rate_numerator'),
  fxRateDenominator: integer('fx_rate_denominator'),
  fxRateSource: text('fx_rate_source'),
  fxRateDate: text('fx_rate_date'),

  supplierId: text('supplier_id').references(() => suppliers.id),
  customerId: text('customer_id').references(() => customers.id),
  /** Set on the director's current account lines so §28 can be per-person. */
  officerId: text('officer_id'),

  memo: text('memo'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('journal_lines_entry_idx').on(t.journalEntryId),
  index('journal_lines_account_idx').on(t.companyId, t.accountId),
  unique('journal_lines_number_unique').on(t.journalEntryId, t.lineNumber),
]);

/**
 * VAT entries (README §7, §23).
 *
 * Separate rows rather than columns on a transaction, for two reasons that both
 * come straight from Irish VAT practice:
 *
 *  1. A reverse-charge transaction produces TWO entries from one document — an
 *     output entry (T1) and an input entry (T2). Columns cannot express that.
 *  2. On the cash receipts basis a part-paid sales invoice produces one output
 *     entry per payment, each with its own tax point and therefore potentially
 *     a different VAT period.
 *
 * The VAT3 box columns are snapshotted from the treatment at creation, so later
 * edits to the treatment configuration cannot rewrite history (§46).
 */
export const vatEntries = sqliteTable('vat_entries', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  journalEntryId: text('journal_entry_id').references(() => journalEntries.id),

  sourceType: text('source_type', {
    enum: [
      'sales_invoice', 'purchase_invoice', 'bank_transaction', 'payment',
      'manual_adjustment', 'reverse_charge', 'import',
    ],
  }).notNull(),
  sourceId: text('source_id'),

  direction: text('direction', { enum: ['sales', 'purchases'] }).notNull(),

  vatTreatmentId: text('vat_treatment_id').notNull().references(() => vatTreatments.id),
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  /** Snapshotted rate, so a later edit to the rate row cannot alter history. */
  rateBasisPoints: integer('rate_basis_points').notNull().default(0),

  netMinor: integer('net_minor').notNull(),
  vatMinor: integer('vat_minor').notNull(),
  grossMinor: integer('gross_minor').notNull(),
  currency: text('currency').notNull(),

  baseNetMinor: integer('base_net_minor').notNull(),
  baseVatMinor: integer('base_vat_minor').notNull(),
  baseGrossMinor: integer('base_gross_minor').notNull(),
  baseCurrency: text('base_currency').notNull(),

  /** What can actually be reclaimed, after any restriction on the treatment. */
  recoverableVatMinor: integer('recoverable_vat_minor').notNull().default(0),
  baseRecoverableVatMinor: integer('base_recoverable_vat_minor').notNull().default(0),

  /**
   * The date that decides which VAT period this falls into. Invoice date on the
   * invoice basis; payment date for sales on the cash receipts basis.
   */
  taxPointDate: text('tax_point_date').notNull(),
  vatPeriodId: text('vat_period_id').references(() => vatPeriods.id),

  /** Snapshotted VAT3 box mapping. */
  vatBox: text('vat_box'),   // T1 or T2
  netBox: text('net_box'),   // E1 / E2 / ES1 / ES2 / PA1

  /** Set on the input leg of a reverse charge, pointing at the output leg. */
  pairedEntryId: text('paired_entry_id'),
  isReverseChargeLeg: integer('is_reverse_charge_leg', { mode: 'boolean' })
    .notNull().default(false),

  counterpartyVatNumber: text('counterparty_vat_number'),
  counterpartyCountry: text('counterparty_country'),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('vat_entries_company_idx').on(t.companyId),
  index('vat_entries_period_idx').on(t.companyId, t.vatPeriodId),
  index('vat_entries_taxpoint_idx').on(t.companyId, t.taxPointDate),
  index('vat_entries_source_idx').on(t.sourceType, t.sourceId),
]);

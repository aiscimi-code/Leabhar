import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance, effectiveDates } from './_shared';
import { companies } from './company';
import { accounts } from './config';
import { documents } from './documents';
import { companyOfficers } from './company';
import { users } from './operations';

/**
 * Effective-dated expense rates (issue #306): the civil service mileage and
 * subsistence allowances Revenue accepts as the tax-free ceiling for
 * reimbursing an employee or director.
 *
 * A rate is data, never code, and it is superseded rather than edited
 * (invariant #6): when the Department of Public Expenditure revises the
 * allowances, a new row is added with a later `effectiveFrom` and the old row
 * is closed with `effectiveTo`, so a historical claim always resolves the
 * rate that applied on its own date.
 *
 * A rate is `amountMinor` per `perUnits` units. Mileage rates are fractional
 * cents per kilometre (41.80c/km), which has no exact minor-unit
 * representation, so they are stored as the amount per 100 km
 * (4180 minor per 100 km) and multiplied out with the same rational
 * arithmetic the VAT engine uses.
 */
export const expenseRates = sqliteTable('expense_rates', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),

  /** Which kind of allowance this row is. */
  category: text('category', {
    enum: ['mileage', 'subsistence_day', 'subsistence_overnight'],
  }).notNull(),
  /** Stable code, e.g. `car_upto_1200cc_band1` or `overnight_normal`. */
  code: text('code').notNull(),
  name: text('name').notNull(),

  unit: text('unit', { enum: ['km', 'absence', 'night'] }).notNull(),
  amountMinor: integer('amount_minor').notNull(),
  perUnits: integer('per_units').notNull().default(1),

  ...effectiveDates,
  sourceNote: text('source_note'),
  sourceUrl: text('source_url'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  uniqueIndex('expense_rates_unique').on(t.companyId, t.code, t.effectiveFrom),
  index('expense_rates_company_idx').on(t.companyId, t.category, t.active),
]);

/**
 * An expense claim (issue #306): money a person spent personally on the
 * business's behalf and wants back — mileage, travel, subsistence or a
 * receipted purchase — as opposed to a supplier invoice, which is posted from
 * a confirmed document (`postDocumentAsInvoice`) and settled separately.
 *
 * The lifecycle is: `submitted` → `approved` (the journal is posted here) →
 * `reimbursed` (the money leaves the bank). A claim is never edited after it
 * is submitted: it is rejected with a reason, or reversed.
 *
 * A claim claims no input VAT. The supplier's invoice is the only proof of
 * input VAT (issue #234), so a purchase with an invoice goes through the
 * document path instead; a claim is for the allowances and small receipts
 * that have no invoice behind them.
 */
export const expenseClaims = sqliteTable('expense_claims', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),

  /** Who is owed the money: an officer (director etc.) or a member of staff. */
  claimantType: text('claimant_type', { enum: ['officer', 'employee'] }).notNull(),
  officerId: text('officer_id').references(() => companyOfficers.id),
  userId: text('user_id').references(() => users.id),

  title: text('title').notNull(),
  status: text('status', {
    enum: ['submitted', 'approved', 'rejected', 'reimbursed', 'reversed'],
  }).notNull().default('submitted'),

  currency: text('currency').notNull(),
  /** Total claimed, in minor units. Includes any private-use share of a line. */
  totalMinor: integer('total_minor').notNull(),
  /** The share of the total that is a business expense. */
  businessMinor: integer('business_minor').notNull(),
  /** The share charged back to the claimant (private use). */
  privateMinor: integer('private_minor').notNull().default(0),

  /** What the company owes the claimant until reimbursed. */
  payableAccountId: text('payable_account_id').notNull().references(() => accounts.id),

  journalEntryId: text('journal_entry_id'),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),

  rejectedBy: text('rejected_by'),
  rejectedOn: text('rejected_on'),
  rejectionReason: text('rejection_reason'),

  reimbursementJournalEntryId: text('reimbursement_journal_entry_id'),
  reimbursementDate: text('reimbursement_date'),
  reimbursedBy: text('reimbursed_by'),
  bankTransactionId: text('bank_transaction_id'),

  /** The reversal of an approved claim's journal (posted journals are immutable). */
  reversalJournalEntryId: text('reversal_journal_entry_id'),
  reversalReason: text('reversal_reason'),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('expense_claims_company_idx').on(t.companyId, t.status),
  index('expense_claims_claimant_idx').on(t.companyId, t.claimantType, t.officerId, t.userId),
]);

/**
 * The lines of a claim. Each line carries the rate it resolved, snapshotted
 * (invariant #6): the configuration may be superseded later, but the line
 * keeps the figures it was calculated from, so it can always be re-checked.
 */
export const expenseClaimLines = sqliteTable('expense_claim_lines', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  claimId: text('claim_id').notNull().references(() => expenseClaims.id),
  lineNumber: integer('line_number').notNull(),

  lineType: text('line_type', {
    enum: ['mileage', 'travel', 'subsistence', 'receipt'],
  }).notNull(),
  date: text('date').notNull(),
  description: text('description').notNull(),

  /** The expense account the business share is debited to. */
  accountId: text('account_id').notNull().references(() => accounts.id),
  amountMinor: integer('amount_minor').notNull(),

  /** Kilometres, absences or nights, for a rate-calculated line. */
  units: integer('units'),

  /** The rate resolved on the line's date, snapshotted. */
  rateId: text('rate_id').references(() => expenseRates.id),
  rateCode: text('rate_code'),
  rateName: text('rate_name'),
  rateAmountMinor: integer('rate_amount_minor'),
  ratePerUnits: integer('rate_per_units'),

  /** Business share of the line, in basis points. 10000 = wholly business. */
  businessUseBasisPoints: integer('business_use_basis_points').notNull().default(10_000),
  /**
   * Where the private share is charged back to. Defaults to the claim's
   * payable account: the company paid a private cost on the claimant's behalf,
   * so the claimant owes it back.
   */
  privateUseAccountId: text('private_use_account_id').references(() => accounts.id),

  /** The receipt behind the line, when there is one. */
  documentId: text('document_id').references(() => documents.id),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('expense_claim_lines_claim_idx').on(t.claimId),
]);

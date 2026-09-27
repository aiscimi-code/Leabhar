import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { customers, suppliers } from './parties';
import { invoices, payments } from './invoices';
import { bankTransactions } from './banking';

/**
 * Construction and relevant contracts tax (EPIC 26, issues #548, #549).
 *
 * Projects and sites are where the work is; a relevant contract is the
 * principal's contract with a subcontractor, notified to Revenue; each
 * payment under it is notified, answered by a deduction authorisation, and
 * settles the subcontractor's invoice net of the tax, which the principal
 * returns and pays for the period. Revenue's figures (the rate, the tax on
 * each payment, the deduction summary) are recorded from Revenue, never
 * computed here.
 */

/** A project (issue #548): the unit EPIC 27 costs and measures. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  customerId: text('customer_id').references(() => customers.id),
  startsOn: text('starts_on').notNull(),
  endsOn: text('ends_on'),
  status: text('status', { enum: ['active', 'completed', 'cancelled'] }).notNull().default('active'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('projects_company_code_unique').on(t.companyId, t.code)]);

/** A site the work is carried out at (issue #548). */
export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  address: text('address').notNull(),
  eircode: text('eircode'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('sites_company_idx').on(t.companyId)]);

/**
 * A supplier's RCT particulars as a subcontractor (issue #548): the identity
 * evidence the principal saw and kept (s.530B(1A)) and the declaration that
 * the subcontractor is not an employee (s.530B(1)(b)). The rate is not here:
 * it is Revenue's determination, carried by each deduction authorisation.
 */
export const rctSubcontractors = sqliteTable('rct_subcontractors', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  supplierId: text('supplier_id').notNull().references(() => suppliers.id),
  /** Their tax reference (PPSN or tax registration number), as the identity evidence shows it. */
  taxReference: text('tax_reference').notNull(),
  identityEvidence: text('identity_evidence').notNull(),
  identityCheckedBy: text('identity_checked_by').notNull(),
  identityCheckedOn: text('identity_checked_on').notNull(),
  notEmployeeDeclared: integer('not_employee_declared', { mode: 'boolean' }).notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('rct_subcontractors_supplier_unique').on(t.supplierId)]);

/** A relevant contract with a subcontractor, as notified to Revenue (issue #548; s.530B). */
export const rctContracts = sqliteTable('rct_contracts', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  subcontractorId: text('subcontractor_id').notNull().references(() => rctSubcontractors.id),
  projectId: text('project_id').references(() => projects.id),
  siteId: text('site_id').references(() => sites.id),
  description: text('description').notNull(),
  estimatedValueMinor: integer('estimated_value_minor').notNull(),
  startsOn: text('starts_on').notNull(),
  endsOn: text('ends_on'),
  labourOnly: integer('labour_only', { mode: 'boolean' }).notNull(),
  /** When the contract notification was made on ROS, and the contract ID Revenue gave it. */
  notifiedOn: text('notified_on'),
  revenueContractId: text('revenue_contract_id'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('rct_contracts_company_idx').on(t.companyId)]);

/**
 * One payment to a subcontractor under a relevant contract (issue #549): the
 * payment notification (s.530C), Revenue's deduction authorisation (s.530D:
 * its number, rate and the tax it specifies), and the payment that settled
 * the invoice net of that tax. `returnPeriod` is the month of the payment
 * (s.530F(5)).
 */
export const rctPayments = sqliteTable('rct_payments', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  contractId: text('contract_id').notNull().references(() => rctContracts.id),
  invoiceId: text('invoice_id').references(() => invoices.id),
  grossMinor: integer('gross_minor').notNull(),
  notifiedOn: text('notified_on').notNull(),
  deductionAuthorisationNumber: text('deduction_authorisation_number'),
  rateBasisPoints: integer('rate_basis_points'),
  /** The tax the deduction authorisation specifies: Revenue's figure. */
  rctMinor: integer('rct_minor'),
  paymentId: text('payment_id').references(() => payments.id),
  paidOn: text('paid_on'),
  returnPeriod: text('return_period'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('rct_payments_company_idx').on(t.companyId, t.returnPeriod),
  uniqueIndex('rct_payments_payment_unique').on(t.paymentId),
]);

/**
 * A return period's RCT (issue #549): the deduction summary Revenue issued
 * (s.530D(3)), deemed the return unless amended (s.530K(2)), what the books
 * say, and the payment to the Collector-General (s.530L).
 */
export const rctReturns = sqliteTable('rct_returns', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** YYYY-MM. */
  period: text('period').notNull(),
  booksLiabilityMinor: integer('books_liability_minor').notNull(),
  summaryLiabilityMinor: integer('summary_liability_minor').notNull(),
  amended: integer('amended', { mode: 'boolean' }).notNull().default(false),
  filedOn: text('filed_on').notNull(),
  filedBy: text('filed_by').notNull(),
  bankTransactionId: text('bank_transaction_id').references(() => bankTransactions.id),
  paymentJournalEntryId: text('payment_journal_entry_id'),
  paidOn: text('paid_on'),
  ...timestamps,
}, (t) => [uniqueIndex('rct_returns_period_unique').on(t.companyId, t.period)]);

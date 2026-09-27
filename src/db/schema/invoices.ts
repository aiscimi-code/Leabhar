import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies } from './company';
import { accounts, vatTreatments, taxRates } from './config';
import { suppliers, customers } from './parties';
import { bankTransactions } from './banking';
import { documents } from './documents';

/**
 * Invoices, sales and purchase (README §26, §27).
 *
 * One table with a `direction` rather than two, because every downstream
 * concern — VAT entries, payments, ageing, matching — treats them identically
 * apart from sign and which control account they post to. Splitting them would
 * duplicate that logic twice over.
 *
 * README §26 is explicit that payment-on-issue must not be assumed. The model
 * is therefore Invoice -> Payment -> BankTransaction, with each leg optional.
 */
export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  direction: text('direction', { enum: ['sales', 'purchase'] }).notNull(),

  invoiceNumber: text('invoice_number'),
  /** Our own sequential number for sales invoices. */
  internalNumber: integer('internal_number'),
  reference: text('reference'),

  supplierId: text('supplier_id').references(() => suppliers.id),
  customerId: text('customer_id').references(() => customers.id),

  invoiceDate: text('invoice_date').notNull(),
  dueDate: text('due_date'),
  /**
   * Where the due date came from (issue #392): `stated` when given, or
   * `customer_terms` when derived from the customer's payment terms.
   */
  dueDateSource: text('due_date_source', { enum: ['stated', 'customer_terms'] }),
  /**
   * The VAT tax point, which is not always the invoice date. Held explicitly
   * so an unusual case can be recorded rather than inferred.
   */
  supplyDate: text('supply_date'),

  currency: text('currency').notNull(),
  netMinor: integer('net_minor').notNull().default(0),
  vatMinor: integer('vat_minor').notNull().default(0),
  grossMinor: integer('gross_minor').notNull().default(0),

  baseCurrency: text('base_currency').notNull(),
  baseNetMinor: integer('base_net_minor').notNull().default(0),
  baseVatMinor: integer('base_vat_minor').notNull().default(0),
  baseGrossMinor: integer('base_gross_minor').notNull().default(0),
  fxRateNumerator: integer('fx_rate_numerator'),
  fxRateDenominator: integer('fx_rate_denominator'),
  fxRateSource: text('fx_rate_source'),
  fxRateDate: text('fx_rate_date'),

  /** Maintained by the payment engine; drives ageing and outstanding balances. */
  paidMinor: integer('paid_minor').notNull().default(0),
  outstandingMinor: integer('outstanding_minor').notNull().default(0),

  documentId: text('document_id').references(() => documents.id),
  journalEntryId: text('journal_entry_id'),

  isCreditNote: integer('is_credit_note', { mode: 'boolean' }).notNull().default(false),
  creditNoteOfId: text('credit_note_of_id'),
  /**
   * A debit note (issue #403): an additional charge after an invoice, e.g. an
   * undercharge corrected. It is an ordinary invoice in every other respect —
   * its own number, VAT and due date — linked to the invoice it adjusts.
   */
  isDebitNote: integer('is_debit_note', { mode: 'boolean' }).notNull().default(false),
  debitNoteOfId: text('debit_note_of_id'),
  /**
   * The recurring template and occurrence date this invoice was raised from
   * (issue #394). Unique together, so an occurrence is raised once however
   * often the due-post runs.
   */
  recurringInvoiceId: text('recurring_invoice_id'),
  recurringDate: text('recurring_date'),

  status: text('status', {
    enum: ['draft', 'issued', 'part_paid', 'paid', 'overdue', 'void', 'written_off'],
  }).notNull().default('draft'),
  /**
   * A bad debt written off (issue #404): the amount taken out of debtors, the
   * journal that did it, when and why. `outstanding_minor` is 0 while it
   * stands, so gross = paid + written off. Reversing the write-off (the debt
   * recovered) clears these and reopens the invoice.
   */
  writtenOffMinor: integer('written_off_minor').notNull().default(0),
  writtenOffJournalEntryId: text('written_off_journal_entry_id'),
  writtenOffAt: text('written_off_at'),
  writeOffReason: text('write_off_reason'),
  voidedAt: text('voided_at'),
  voidReason: text('void_reason'),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('invoices_company_idx').on(t.companyId),
  index('invoices_direction_date_idx').on(t.companyId, t.direction, t.invoiceDate),
  index('invoices_supplier_idx').on(t.companyId, t.supplierId),
  index('invoices_customer_idx').on(t.companyId, t.customerId),
  index('invoices_status_idx').on(t.companyId, t.status),
  index('invoices_number_idx').on(t.companyId, t.invoiceNumber),
  uniqueIndex('invoices_recurring_occurrence_unique').on(t.recurringInvoiceId, t.recurringDate),
]);

/**
 * A recurring sales invoice (issue #394): a template, not an invoice. Each
 * occurrence is raised by `createInvoice` as an ordinary invoice with its own
 * number, VAT and due date. The template's lines are intent and may change;
 * invoices already raised do not.
 */
export const recurringInvoices = sqliteTable('recurring_invoices', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  customerId: text('customer_id').notNull().references(() => customers.id),
  /** Shown on the list and used as the invoice reference, e.g. "Monthly retainer". */
  name: text('name').notNull(),
  frequency: text('frequency', { enum: ['monthly', 'quarterly', 'yearly'] }).notNull(),
  startDate: text('start_date').notNull(),
  /** Inclusive last occurrence date; null means until deactivated. */
  endDate: text('end_date'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdBy: text('created_by').notNull(),
  ...timestamps,
}, (t) => [index('recurring_invoices_company_idx').on(t.companyId, t.active)]);

export const recurringInvoiceLines = sqliteTable('recurring_invoice_lines', {
  id: text('id').primaryKey(),
  recurringInvoiceId: text('recurring_invoice_id').notNull().references(() => recurringInvoices.id),
  companyId: text('company_id').notNull().references(() => companies.id),
  lineNumber: integer('line_number').notNull(),
  description: text('description').notNull(),
  netMinor: integer('net_minor').notNull(),
  discountBasisPoints: integer('discount_basis_points'),
  accountId: text('account_id').notNull().references(() => accounts.id),
  vatTreatmentId: text('vat_treatment_id').notNull().references(() => vatTreatments.id),
  ...timestamps,
}, (t) => [index('recurring_invoice_lines_template_idx').on(t.recurringInvoiceId)]);

/**
 * Invoice lines. A single invoice can carry several VAT treatments and rates —
 * common on an EU supplier invoice mixing goods and services — which is why VAT
 * lives on the line, not the header.
 */
export const invoiceLines = sqliteTable('invoice_lines', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  lineNumber: integer('line_number').notNull(),

  description: text('description').notNull(),
  quantityMilli: integer('quantity_milli').notNull().default(1000), // 1.000 as 1000
  unitPriceMinor: integer('unit_price_minor').notNull().default(0),
  /**
   * A trade discount on the line (issue #393): the net before it, the
   * percentage (basis points) when given as one, and the amount taken off.
   * `netMinor` is after the discount, and VAT is charged on it. Null / 0 when
   * the line has no discount.
   */
  undiscountedNetMinor: integer('undiscounted_net_minor'),
  discountBasisPoints: integer('discount_basis_points'),
  discountMinor: integer('discount_minor').notNull().default(0),

  accountId: text('account_id').references(() => accounts.id),
  vatTreatmentId: text('vat_treatment_id').references(() => vatTreatments.id),
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  rateBasisPoints: integer('rate_basis_points').notNull().default(0),

  netMinor: integer('net_minor').notNull().default(0),
  vatMinor: integer('vat_minor').notNull().default(0),
  grossMinor: integer('gross_minor').notNull().default(0),
  currency: text('currency').notNull(),

  /** Set when the line is a capital purchase, linking to the asset register. */
  fixedAssetId: text('fixed_asset_id'),

  /**
   * The confirmed document line this invoice line was posted from (issue #203),
   * so every VAT figure traces back to the printed line that evidences it.
   */
  documentLineId: text('document_line_id'),
  /** The statutory rules behind the VAT treatment chosen for this line. */
  vatRuleKeys: text('vat_rule_keys', { mode: 'json' }).$type<string[]>().notNull().default([]),

  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)]);

/**
 * Payments (README §26).
 *
 * The middle leg. On the cash receipts basis this row is what creates the
 * output VAT entry, dated at `paymentDate` — which is the entire reason the
 * model has three legs rather than two.
 */
export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  direction: text('direction', { enum: ['received', 'made'] }).notNull(),

  paymentDate: text('payment_date').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  baseAmountMinor: integer('base_amount_minor').notNull(),
  baseCurrency: text('base_currency').notNull(),
  fxRateNumerator: integer('fx_rate_numerator'),
  fxRateDenominator: integer('fx_rate_denominator'),

  method: text('method', {
    enum: [
      'bank_transfer', 'card', 'direct_debit', 'cash', 'cheque',
      'director_personal', 'offset', 'other',
    ],
  }).notNull().default('bank_transfer'),

  bankTransactionId: text('bank_transaction_id').references(() => bankTransactions.id),
  /**
   * Whose money this is (issue #386): the customer or supplier every invoice it
   * settles belongs to. Null when it settled several parties or predates the
   * column; money held on account can only be applied to this party's invoices.
   */
  supplierId: text('supplier_id').references(() => suppliers.id),
  customerId: text('customer_id').references(() => customers.id),
  /**
   * A refund of money another payment holds on account (issue #402): the
   * money goes back the other way and that payment's on-account balance falls.
   */
  refundOfPaymentId: text('refund_of_payment_id'),
  /** Set when a director paid personally on the company's behalf (§28). */
  officerId: text('officer_id'),

  journalEntryId: text('journal_entry_id'),
  reference: text('reference'),
  notes: text('notes'),
  /**
   * Set when the payment was reversed (issue #220). A reversed payment stays on
   * file with its allocations; its journal is reversed by a separate entry and
   * the invoices it settled are open again. Nothing is deleted.
   */
  reversedAt: text('reversed_at'),
  reversedBy: text('reversed_by'),
  reversalReason: text('reversal_reason'),
  reversalJournalEntryId: text('reversal_journal_entry_id'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('payments_company_idx').on(t.companyId),
  index('payments_date_idx').on(t.companyId, t.paymentDate),
  index('payments_bank_tx_idx').on(t.bankTransactionId),
]);

/**
 * Which payment settled which invoice, and by how much. A separate table
 * because one payment can settle several invoices and one invoice can be
 * settled by several payments — and because the allocated amount is what drives
 * partial VAT recognition on the cash receipts basis.
 */
export const paymentAllocations = sqliteTable('payment_allocations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  paymentId: text('payment_id').notNull().references(() => payments.id),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  allocatedMinor: integer('allocated_minor').notNull(),
  baseAllocatedMinor: integer('base_allocated_minor').notNull(),
  currency: text('currency').notNull(),
  /** FX gain or loss arising because settlement moved against the invoice rate. */
  fxDifferenceMinor: integer('fx_difference_minor').notNull().default(0),
  /**
   * What the allocation is (issue #386). `settlement`: cash applied when the
   * payment was recorded. `on_account`: money the payment held on account,
   * applied later — no journal, both sides sit on the same control account.
   * `write_off`: a shortfall the payment did not cover, posted to
   * `writeOffAccountId` in the payment's journal. Not cash.
   */
  allocationType: text('allocation_type', { enum: ['settlement', 'on_account', 'write_off'] })
    .notNull().default('settlement'),
  writeOffAccountId: text('write_off_account_id').references(() => accounts.id),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('payment_allocations_payment_idx').on(t.paymentId),
  index('payment_allocations_invoice_idx').on(t.invoiceId),
]);

/**
 * A payment reminder letter produced for a customer (issue #405): which level
 * (1 reminder, 2 second reminder, 3 final notice), as at which date, and by
 * whom. The invoices it covered, with what each had outstanding then, are in
 * `invoice_reminders`, so the letter can be produced again exactly as it was.
 * Producing it is recorded; sending it is the person's (email waits on #401).
 */
export const reminderLetters = sqliteTable('reminder_letters', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  customerId: text('customer_id').notNull().references(() => customers.id),
  level: integer('level').notNull(),
  asOf: text('as_of').notNull(),
  producedBy: text('produced_by').notNull(),
  ...timestamps,
}, (t) => [index('reminder_letters_customer_idx').on(t.companyId, t.customerId)]);

export const invoiceReminders = sqliteTable('invoice_reminders', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  letterId: text('letter_id').notNull().references(() => reminderLetters.id),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id),
  outstandingMinor: integer('outstanding_minor').notNull(),
  daysOverdue: integer('days_overdue').notNull(),
  ...timestamps,
}, (t) => [index('invoice_reminders_invoice_idx').on(t.invoiceId)]);

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
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

  status: text('status', {
    enum: ['draft', 'issued', 'part_paid', 'paid', 'overdue', 'void', 'written_off'],
  }).notNull().default('draft'),
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
]);

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
  /** Set when a director paid personally on the company's behalf (§28). */
  officerId: text('officer_id'),

  journalEntryId: text('journal_entry_id'),
  reference: text('reference'),
  notes: text('notes'),
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
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('payment_allocations_payment_idx').on(t.paymentId),
  index('payment_allocations_invoice_idx').on(t.invoiceId),
]);

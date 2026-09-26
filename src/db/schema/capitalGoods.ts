import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';

/**
 * The capital goods scheme record (VATCA ss.63-64, issue #208): one row per
 * capital good (a property acquired or developed, or a refurbishment), with
 * the figures the adjustments are calculated from. A person registers it and
 * records the proportion of deductible use for each interval; the arithmetic
 * is the domain's (src/domain/vat/capitalGoods.ts), never typed in.
 */
export const capitalGoods = sqliteTable('capital_goods', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  description: text('description').notNull(),
  /** A refurbishment has 10 intervals; anything else 20 (s.64(1)(a)). */
  kind: text('kind', { enum: ['acquisition_or_development', 'refurbishment'] }).notNull(),
  intervalCount: integer('interval_count').notNull(),
  /** Completion, or the date it was supplied to the company: the initial interval starts here (s.63(1)). */
  initialIntervalStart: text('initial_interval_start').notNull(),
  /** Total tax incurred on the acquisition or development (s.63(1)), in base currency minor units. */
  totalTaxIncurredMinor: integer('total_tax_incurred_minor').notNull(),
  /** The part of it deducted when incurred (s.64(2) "A"). */
  deductedMinor: integer('deducted_minor').notNull(),
  /** The invoices the total rests on (JSON array of invoice ids). */
  sourceInvoiceIds: text('source_invoice_ids', { mode: 'json' }).$type<string[]>().notNull(),
  registeredBy: text('registered_by').notNull(),
  registeredAt: text('registered_at').notNull(),
  /** The adjustment period ends on a supply or transfer of the good (s.64(1)(b)). */
  disposedOn: text('disposed_on'),
  disposalTaxable: integer('disposal_taxable', { mode: 'boolean' }),
  disposalAdjustmentMinor: integer('disposal_adjustment_minor'),
  disposalRecordedBy: text('disposal_recorded_by'),
  disposalJournalEntryId: text('disposal_journal_entry_id'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('capital_goods_company_idx').on(t.companyId)]);

/**
 * One row per interval whose use a person has recorded. Written once: a
 * correction is a new capital good record or an adjustment, never an edit.
 */
export const capitalGoodIntervals = sqliteTable('capital_good_intervals', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  capitalGoodId: text('capital_good_id').notNull().references(() => capitalGoods.id),
  intervalNumber: integer('interval_number').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  /** Proportion of deductible use in the interval, in basis points (0-10000). */
  proportionBp: integer('proportion_bp').notNull(),
  /** Not used in the interval: the previous interval's proportion applies (s.64(3)(c)). */
  notUsed: integer('not_used', { mode: 'boolean' }).notNull().default(false),
  /** The initial-interval proportion the adjustment was measured against (reset by s.64(4)(d)). */
  baselineBp: integer('baseline_bp').notNull(),
  /** Positive: payable (T1); negative: deductible (T2). */
  adjustmentMinor: integer('adjustment_minor').notNull(),
  provision: text('provision', { enum: ['s.64(2)', 's.64(3)', 's.64(4)'] }).notNull(),
  /** How the figure was calculated, in words and numbers. */
  working: text('working').notNull(),
  recordedBy: text('recorded_by').notNull(),
  recordedAt: text('recorded_at').notNull(),
  /** The adjustment journal, once posted. */
  journalEntryId: text('journal_entry_id'),
  ...timestamps,
}, (t) => [
  index('capital_good_intervals_good_idx').on(t.capitalGoodId),
  uniqueIndex('capital_good_intervals_unique').on(t.capitalGoodId, t.intervalNumber),
]);

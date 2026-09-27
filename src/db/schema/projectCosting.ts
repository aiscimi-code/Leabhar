import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { journalLines } from './accounting';
import { projects } from './construction';

/**
 * Project and job costing (EPIC 27, issues #550, #551). Analysis beside the
 * ledger, as the farm's is (ADR 0016): posted lines are allocated to a
 * project, and optionally a job, by category; budgets and overhead rates are
 * effective-dated, never overwritten. Nothing here posts.
 */

export const PROJECT_COST_CATEGORIES = ['income', 'labour', 'materials', 'contractors', 'other_direct', 'overheads'] as const;

/** A job within a project (issue #550). */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['open', 'completed'] }).notNull().default('open'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('jobs_project_code_unique').on(t.projectId, t.code)]);

/** A share of a posted line belonging to a project (and job), by category (issue #550). */
export const projectAllocations = sqliteTable('project_allocations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  journalLineId: text('journal_line_id').notNull().references(() => journalLines.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  jobId: text('job_id').references(() => jobs.id),
  category: text('category', { enum: PROJECT_COST_CATEGORIES }).notNull(),
  basisPoints: integer('basis_points').notNull(),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('project_allocations_line_idx').on(t.journalLineId),
  index('project_allocations_project_idx').on(t.projectId),
]);

/**
 * A project's budget for a category, from a date (issue #550). A revision is a
 * new row; the budget in force on a date is the latest one on or before it.
 */
export const projectBudgets = sqliteTable('project_budgets', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  category: text('category', { enum: PROJECT_COST_CATEGORIES }).notNull(),
  amountMinor: integer('amount_minor').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  note: text('note'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('project_budgets_project_idx').on(t.projectId, t.category, t.effectiveFrom)]);

/**
 * The overhead absorption rate the person sets for a project, as basis
 * points of its direct costs, from a date (issue #551). Effective-dated.
 */
export const projectOverheadRates = sqliteTable('project_overhead_rates', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  rateBasisPoints: integer('rate_basis_points').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  basis: text('basis').notNull(),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('project_overhead_rates_project_idx').on(t.projectId, t.effectiveFrom)]);

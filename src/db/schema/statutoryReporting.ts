import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { accounts } from './config';

/**
 * Company size and the Schedule 3A formats (EPIC 28, issue #554).
 *
 * What the books cannot know about a company's size is a person's decision,
 * recorded here per financial year: whether an exclusion applies (a holding
 * company, an ineligible company and so on), the average number of employees
 * where payroll does not hold it, and the size the company qualified as for
 * a year before these books. Written once; a changed mind is a new row that
 * supersedes the old one, which keeps its record.
 */
export const COMPANY_SIZE_DECISION_KINDS = ['exclusion', 'average_employees', 'prior_year_size', 'prior_year_conditions'] as const;
export const COMPANY_SIZE_EXCLUSIONS = [
  'none', 'holding_company', 'ineligible_company', 'investment_undertaking', 'financial_holding_undertaking', 'subsidiary_in_consolidation',
] as const;
export const COMPANY_SIZES = ['micro', 'small', 'medium', 'large', 'first_financial_year'] as const;

export const companySizeDecisions = sqliteTable('company_size_decisions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The financial year's end date the decision is for. */
  financialYearEnd: text('financial_year_end').notNull(),
  kind: text('kind', { enum: COMPANY_SIZE_DECISION_KINDS }).notNull(),
  /**
   * An exclusion; the size the company qualified as in the year before
   * (`first_financial_year` when there was none); or, for
   * `prior_year_conditions`, the smallest size whose qualifying conditions it
   * met in the year before (the limbs nest, so it met every larger size's too).
   */
  choice: text('choice'),
  /** The average number of employees, for `average_employees`. */
  count: integer('count'),
  decidedBy: text('decided_by').notNull(),
  note: text('note'),
  supersededById: text('superseded_by_id'),
  ...timestamps,
}, (t) => [index('company_size_decisions_idx').on(t.companyId, t.kind, t.financialYearEnd)]);

/**
 * Which Schedule 3A Format 1 item an account is presented under, from a date
 * (issue #554). Without a row an account takes its default item, worked out
 * from its type and system key; a row overrides that from `effectiveFrom`,
 * and a later row supersedes an earlier one without changing it.
 */
export const statementFormatMappings = sqliteTable('statement_format_mappings', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  /** e.g. `B.II.1` on the balance sheet, `5` on the profit and loss account. */
  itemCode: text('item_code').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  note: text('note'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('statement_format_mappings_idx').on(t.companyId, t.accountId, t.effectiveFrom)]);

import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';

/**
 * A person's choice on a corporation tax treatment the computation could not
 * settle on its own (issue #211): whether an expense line is added back and
 * under which provision, or which Case an income account's income falls
 * under for an accounting period. Written once; a changed mind is a new row
 * that supersedes the old one, which keeps its record.
 */
export const ctDecisions = sqliteTable('ct_decisions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /**
   * A journal line (an expense); or, for one accounting period, an income
   * account, the company's loss claim, or its close company status.
   */
  subjectType: text('subject_type', { enum: ['journal_line', 'income_account', 'loss_claim', 'company_status'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  /** The accounting period end the decision is for (income accounts); the line's own period otherwise. */
  periodEnd: text('period_end').notNull(),
  choice: text('choice').notNull(),
  decidedBy: text('decided_by').notNull(),
  decidedAt: text('decided_at').notNull(),
  note: text('note'),
  supersededById: text('superseded_by_id'),
  ...timestamps,
}, (t) => [index('ct_decisions_subject_idx').on(t.companyId, t.subjectType, t.subjectId)]);

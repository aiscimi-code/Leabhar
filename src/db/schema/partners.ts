import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { accounts } from './config';

/**
 * The partners of a partnership (issue #212). The precedent partner makes
 * the partnership's return (Form 1 (Firms); TCA s.1007).
 */
export const partners = sqliteTable('partners', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  /** PPSN, for the partner's own return; optional. */
  taxReference: text('tax_reference'),
  isPrecedentPartner: integer('is_precedent_partner', { mode: 'boolean' }).notNull().default(false),
  joinedOn: text('joined_on').notNull(),
  leftOn: text('left_on'),
  capitalAccountId: text('capital_account_id').references(() => accounts.id),
  currentAccountId: text('current_account_id').references(() => accounts.id),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('partners_company_idx').on(t.companyId)]);

/**
 * A partner's share of profits, effective-dated: a change is a new row from
 * its date, closing the previous one; nothing is overwritten.
 */
export const partnerShares = sqliteTable('partner_shares', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  partnerId: text('partner_id').notNull().references(() => partners.id),
  /** Share of profits and losses, in basis points (10000 = 100%). */
  shareBasisPoints: integer('share_basis_points').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'),
  recordedBy: text('recorded_by').notNull(),
  basis: text('basis'),
  ...timestamps,
}, (t) => [index('partner_shares_partner_idx').on(t.partnerId)]);

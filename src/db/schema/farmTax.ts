import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { journalLines } from './accounting';
import { fixedAssets } from './operations';

/**
 * Farm tax and grants (EPIC 25, issues #543–#546). Records of what the books
 * cannot know on their own: what each grant is for, which posted lines
 * received it, the farm partnership's registration, and share farming
 * arrangements. The money is always the ledger's.
 */

export const GRANT_KINDS = ['revenue', 'capital'] as const;

/** A grant or scheme payment awarded (issue #543): BISS, ACRES, TAMS and the like. */
export const grants = sqliteTable('grants', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The scheme, as the paying body names it. */
  scheme: text('scheme').notNull(),
  /** The paying body: DAFM, or another. */
  payer: text('payer').notNull(),
  /** The reference on the award or the payment statement. */
  reference: text('reference'),
  /** Revenue: income of the year. Capital: towards an asset, which it reduces for allowances (s.317). */
  kind: text('kind', { enum: GRANT_KINDS }).notNull(),
  awardedMinor: integer('awarded_minor').notNull(),
  awardedOn: text('awarded_on').notNull(),
  /** A capital grant: the asset it funds. */
  fixedAssetId: text('fixed_asset_id').references(() => fixedAssets.id),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('grants_company_idx').on(t.companyId, t.awardedOn)]);

/** A posted line that received a grant (issue #543). Its amount is the line's; one line, one grant. */
export const grantReceipts = sqliteTable('grant_receipts', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  grantId: text('grant_id').notNull().references(() => grants.id),
  journalLineId: text('journal_line_id').notNull().references(() => journalLines.id),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('grant_receipts_line_unique').on(t.journalLineId),
  index('grant_receipts_grant_idx').on(t.grantId),
]);

export const FARM_PARTNERSHIP_REGISTERS = ['registered_farm_partnership', 'succession_farm_partnership'] as const;

/**
 * This book's partnership on a DAFM register (issue #546): a registered farm
 * partnership (s.667C) or a succession farm partnership (s.667D), from a date.
 */
export const farmPartnershipRegistrations = sqliteTable('farm_partnership_registrations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  register: text('register', { enum: FARM_PARTNERSHIP_REGISTERS }).notNull(),
  /** The unique identifier the register assigned. */
  identifier: text('identifier').notNull(),
  registeredOn: text('registered_on').notNull(),
  endedOn: text('ended_on'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('farm_partnership_registrations_company_idx').on(t.companyId)]);

/**
 * A share farming arrangement (issue #546): each party farms on its own
 * account and shares output and costs as agreed. A record of what the books
 * must reflect; it posts nothing.
 */
export const shareFarmingArrangements = sqliteTable('share_farming_arrangements', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  counterparty: text('counterparty').notNull(),
  /** Whose land: this farm's, or the other party's. */
  landProvidedBy: text('land_provided_by', { enum: ['this_farm', 'counterparty'] }).notNull(),
  /** The land parcels it covers. */
  parcelIds: text('parcel_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** This farm's share of the output, and of the costs it shares, in basis points. */
  outputShareBasisPoints: integer('output_share_basis_points').notNull(),
  costShareBasisPoints: integer('cost_share_basis_points').notNull(),
  startsOn: text('starts_on').notNull(),
  endsOn: text('ends_on'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('share_farming_company_idx').on(t.companyId)]);

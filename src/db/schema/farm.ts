import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies, companyTradingActivities } from './company';
import { accounts } from './config';
import { journalEntries, journalLines } from './accounting';
import { fixedAssets } from './operations';
import { invoiceLines } from './invoices';

/**
 * Farm accounting (EPIC 24, issues #539–#541). Management records on top of
 * the ledger: what the farm is (land, enterprises), what is on it (livestock,
 * crops), and which posted lines belong to which enterprise or crop. The
 * ledger stays the only source of money; the one path from here into it is a
 * livestock valuation, posted like closing stock (ADR 0015).
 */

/** One per book (issue #539): the farming activity it trades as, and how area is shown. */
export const farmProfiles = sqliteTable('farm_profiles', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The farming trading activity, which carries the herd number (#326). */
  tradingActivityId: text('trading_activity_id').references(() => companyTradingActivities.id),
  farmName: text('farm_name').notNull(),
  flockNumber: text('flock_number'),
  areaUnit: text('area_unit', { enum: ['hectares', 'acres'] }).notNull().default('hectares'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('farm_profiles_company_unique').on(t.companyId)]);

export const LAND_TENURES = ['owned', 'leased'] as const;

/**
 * A land parcel held for a period (issue #539). Area is whole square metres,
 * so hectares and acres are exact conversions of one figure. A parcel that is
 * leased and later bought is two rows with the same reference, one after the
 * other; periods of one reference never overlap.
 */
export const landParcels = sqliteTable('land_parcels', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The LPIS parcel number, or the farm's own reference. */
  reference: text('reference').notNull(),
  name: text('name').notNull(),
  areaSqm: integer('area_sqm').notNull(),
  tenure: text('tenure', { enum: LAND_TENURES }).notNull(),
  heldFrom: text('held_from').notNull(),
  /** Inclusive; null while held. */
  heldTo: text('held_to'),
  /** Leased land: who it is leased from. */
  counterparty: text('counterparty'),
  /** Leased land: the annual rent, in minor units. */
  annualRentMinor: integer('annual_rent_minor'),
  /** Owned land: its fixed asset, where the purchase is on the register. */
  fixedAssetId: text('fixed_asset_id').references(() => fixedAssets.id),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('land_parcels_company_idx').on(t.companyId, t.reference)]);

export const ENTERPRISE_KINDS = ['dairy', 'beef', 'sheep', 'tillage', 'horticulture', 'forestry', 'other'] as const;

/** A farm enterprise (issue #539): the unit gross margins are measured by. */
export const farmEnterprises = sqliteTable('farm_enterprises', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  kind: text('kind', { enum: ENTERPRISE_KINDS }).notNull(),
  startedOn: text('started_on').notNull(),
  endedOn: text('ended_on'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('farm_enterprises_company_name_unique').on(t.companyId, t.name)]);

/** A crop on a field for a harvest year (issue #541). The field is a land parcel. */
export const cropPlantings = sqliteTable('crop_plantings', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  enterpriseId: text('enterprise_id').notNull().references(() => farmEnterprises.id),
  parcelId: text('parcel_id').notNull().references(() => landParcels.id),
  crop: text('crop').notNull(),
  variety: text('variety'),
  harvestYear: integer('harvest_year').notNull(),
  areaSqm: integer('area_sqm').notNull(),
  sownOn: text('sown_on'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('crop_plantings_company_idx').on(t.companyId, t.harvestYear)]);

export const CROP_INPUT_KINDS = ['seed', 'fertiliser', 'chemicals', 'contractor', 'sales', 'other'] as const;

/**
 * A share of a posted journal line belonging to an enterprise, and optionally
 * to a crop planting as one of its inputs or its sales (issues #539, #541).
 * Analysis only: the line itself is never touched, and its allocations never
 * exceed 100%. A reversal of the line follows the same allocation.
 */
export const farmAllocations = sqliteTable('farm_allocations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  journalLineId: text('journal_line_id').notNull().references(() => journalLines.id),
  enterpriseId: text('enterprise_id').notNull().references(() => farmEnterprises.id),
  plantingId: text('planting_id').references(() => cropPlantings.id),
  inputKind: text('input_kind', { enum: CROP_INPUT_KINDS }),
  basisPoints: integer('basis_points').notNull(),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('farm_allocations_line_idx').on(t.journalLineId),
  index('farm_allocations_enterprise_idx').on(t.enterpriseId),
]);

/** A harvest from a planting (issue #541). Yield is the quantity per hectare sown. */
export const cropHarvests = sqliteTable('crop_harvests', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  plantingId: text('planting_id').notNull().references(() => cropPlantings.id),
  harvestedOn: text('harvested_on').notNull(),
  quantityMilli: integer('quantity_milli').notNull(),
  unit: text('unit').notNull(),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('crop_harvests_planting_idx').on(t.plantingId)]);

export const LIVESTOCK_SPECIES = ['cattle', 'sheep', 'pigs', 'poultry', 'goats', 'horses', 'other'] as const;

/** A group of animals counted and valued together (issue #540). */
export const animalGroups = sqliteTable('animal_groups', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  enterpriseId: text('enterprise_id').notNull().references(() => farmEnterprises.id),
  name: text('name').notNull(),
  species: text('species', { enum: LIVESTOCK_SPECIES }).notNull(),
  /** Default 1330 Livestock on hand. */
  stockAccountId: text('stock_account_id').notNull().references(() => accounts.id),
  /** Where the change in value goes. Default 5040 Livestock purchases. */
  changeAccountId: text('change_account_id').notNull().references(() => accounts.id),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('animal_groups_company_name_unique').on(t.companyId, t.name)]);

/** A tagged animal (issue #540). Its group and whether it is on the farm come from its events. */
export const animals = sqliteTable('animals', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  tagNumber: text('tag_number').notNull(),
  species: text('species', { enum: LIVESTOCK_SPECIES }).notNull(),
  sex: text('sex', { enum: ['female', 'male', 'castrated_male'] }),
  breed: text('breed'),
  dateOfBirth: text('date_of_birth'),
  damTag: text('dam_tag'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('animals_company_tag_unique').on(t.companyId, t.tagNumber)]);

export const LIVESTOCK_EVENT_KINDS = [
  'opening', 'purchase', 'sale', 'birth', 'death', 'transfer_in', 'transfer_out', 'reversal',
] as const;

/**
 * One event in the livestock register (issue #540). Immutable: a mistake is
 * reversed. `headCount` is signed: positive onto the group, negative off it.
 * `amountMinor` is the price paid or received, for the record; the ledger's
 * figure is the invoice's.
 */
export const livestockEvents = sqliteTable('livestock_events', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  groupId: text('group_id').notNull().references(() => animalGroups.id),
  animalId: text('animal_id').references(() => animals.id),
  eventDate: text('event_date').notNull(),
  sequence: integer('sequence').notNull(),
  kind: text('kind', { enum: LIVESTOCK_EVENT_KINDS }).notNull(),
  headCount: integer('head_count').notNull(),
  amountMinor: integer('amount_minor'),
  invoiceLineId: text('invoice_line_id').references(() => invoiceLines.id),
  relatedEventId: text('related_event_id'),
  transferPairId: text('transfer_pair_id'),
  reason: text('reason'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [
  index('livestock_events_group_idx').on(t.groupId, t.eventDate),
  index('livestock_events_animal_idx').on(t.animalId),
]);

export interface LivestockValuationLine {
  groupId: string; enterpriseId: string; headCount: number; valuePerHeadMinor: number; valueMinor: number;
  basis: string; stockAccountId: string; changeAccountId: string; changeMinor: number;
}

/**
 * A livestock valuation posted to the ledger (issue #540): head count by group
 * times the person's value per head, and the journal that moved the change.
 */
export const livestockValuations = sqliteTable('livestock_valuations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  valuationDate: text('valuation_date').notNull(),
  valueMinor: integer('value_minor').notNull(),
  journalEntryId: text('journal_entry_id').references(() => journalEntries.id),
  lines: text('lines', { mode: 'json' }).$type<LivestockValuationLine[]>().notNull(),
  postedBy: text('posted_by').notNull(),
  ...timestamps,
}, (t) => [index('livestock_valuations_company_idx').on(t.companyId, t.valuationDate)]);

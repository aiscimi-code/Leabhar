import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';
import { companies } from './company';
import { accounts, vatTreatments } from './config';

/**
 * Suppliers and customers (README §17). Persistent profiles that accumulate
 * defaults from confirmed history, which is how the system "learns" without
 * anything probabilistic being involved: a confirmed classification updates the
 * default, and the default is then suggested next time.
 */
export const suppliers = sqliteTable('suppliers', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  /** Normalised name for matching: lowercased, punctuation stripped. */
  matchKey: text('match_key').notNull(),
  /** Extra strings seen on bank descriptions for this supplier. */
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),

  countryCode: text('country_code'),
  vatNumber: text('vat_number'),
  vatNumberValidated: integer('vat_number_validated', { mode: 'boolean' })
    .notNull().default(false),

  /**
   * Where the party is established for VAT (EU Reg 282/2011 arts.10-11: its
   * seat of economic activity, or a fixed establishment): 'in_state' (Ireland)
   * or 'outside_state'. Recorded and confirmed by a person (issue #207);
   * never inferred from a country code. Null means nobody has said, and a
   * rule that needs it is flagged rather than guessed.
   */
  establishment: text('establishment', { enum: ['in_state', 'outside_state'] }),
  /** What the person relied on, e.g. "seat in Germany; no branch or staff in Ireland". */
  establishmentBasis: text('establishment_basis'),
  establishmentConfirmedBy: text('establishment_confirmed_by'),
  establishmentConfirmedAt: text('establishment_confirmed_at'),
  /**
   * The last VIES check of `vatNumber` (issue #207): 'valid', 'invalid', or
   * 'unavailable' (the service could not answer). Stored as the evidence it
   * is; `vatNumberValidated` is true only after a 'valid' answer.
   */
  viesStatus: text('vies_status', { enum: ['valid', 'invalid', 'unavailable'] }),
  viesCheckedAt: text('vies_checked_at'),
  /** The VAT number exactly as checked, so a later edit is not mistaken for a checked one. */
  viesCheckedVatNumber: text('vies_checked_vat_number'),
  viesName: text('vies_name'),
  viesAddress: text('vies_address'),
  /** VIES's consultation number, when one was given: the proof of the check. */
  viesRequestIdentifier: text('vies_request_identifier'),
  taxReference: text('tax_reference'),
  addressLines: text('address_lines'),
  email: text('email'),
  website: text('website'),

  defaultCurrency: text('default_currency').notNull().default('EUR'),
  defaultAccountId: text('default_account_id').references(() => accounts.id),
  defaultVatTreatmentId: text('default_vat_treatment_id').references(() => vatTreatments.id),

  /** Observed settlement behaviour, used as a matching signal. */
  typicalPaymentDays: integer('typical_payment_days'),
  paymentBehaviourNotes: text('payment_behaviour_notes'),

  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('suppliers_company_idx').on(t.companyId),
  index('suppliers_match_idx').on(t.companyId, t.matchKey),
]);

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  matchKey: text('match_key').notNull(),
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),

  countryCode: text('country_code'),
  vatNumber: text('vat_number'),
  vatNumberValidated: integer('vat_number_validated', { mode: 'boolean' })
    .notNull().default(false),

  /**
   * Where the party is established for VAT (EU Reg 282/2011 arts.10-11: its
   * seat of economic activity, or a fixed establishment): 'in_state' (Ireland)
   * or 'outside_state'. Recorded and confirmed by a person (issue #207);
   * never inferred from a country code. Null means nobody has said, and a
   * rule that needs it is flagged rather than guessed.
   */
  establishment: text('establishment', { enum: ['in_state', 'outside_state'] }),
  /** What the person relied on, e.g. "seat in Germany; no branch or staff in Ireland". */
  establishmentBasis: text('establishment_basis'),
  establishmentConfirmedBy: text('establishment_confirmed_by'),
  establishmentConfirmedAt: text('establishment_confirmed_at'),
  /**
   * The last VIES check of `vatNumber` (issue #207): 'valid', 'invalid', or
   * 'unavailable' (the service could not answer). Stored as the evidence it
   * is; `vatNumberValidated` is true only after a 'valid' answer.
   */
  viesStatus: text('vies_status', { enum: ['valid', 'invalid', 'unavailable'] }),
  viesCheckedAt: text('vies_checked_at'),
  /** The VAT number exactly as checked, so a later edit is not mistaken for a checked one. */
  viesCheckedVatNumber: text('vies_checked_vat_number'),
  viesName: text('vies_name'),
  viesAddress: text('vies_address'),
  /** VIES's consultation number, when one was given: the proof of the check. */
  viesRequestIdentifier: text('vies_request_identifier'),
  /**
   * Whether this customer receives services as a taxable person (a business)
   * or not (a consumer) — the fact VATCA s.34(a)/(b) turns on for where a
   * service is supplied (issue #200). Null means nobody has said: for an EU
   * customer a VAT number is evidence of taxable status, but for a customer
   * outside the EU there is none unless it is recorded here.
   */
  taxableStatus: text('taxable_status', { enum: ['taxable_person', 'non_taxable_person'] }),
  /** Who recorded `taxableStatus`, and when (issue #207); null for a status inferred from a VAT number. */
  taxableStatusConfirmedBy: text('taxable_status_confirmed_by'),
  taxableStatusConfirmedAt: text('taxable_status_confirmed_at'),
  addressLines: text('address_lines'),
  email: text('email'),
  website: text('website'),

  defaultCurrency: text('default_currency').notNull().default('EUR'),
  defaultAccountId: text('default_account_id').references(() => accounts.id),
  defaultVatTreatmentId: text('default_vat_treatment_id').references(() => vatTreatments.id),
  defaultPaymentTermsDays: integer('default_payment_terms_days').notNull().default(0),

  typicalPaymentDays: integer('typical_payment_days'),
  paymentBehaviourNotes: text('payment_behaviour_notes'),

  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('customers_company_idx').on(t.companyId),
  index('customers_match_idx').on(t.companyId, t.matchKey),
]);

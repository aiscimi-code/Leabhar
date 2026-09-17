import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { timestamps } from './_shared';

/**
 * Company identity and configuration (README §5).
 *
 * `companyId` exists on every scoped table from day one so multi-company
 * support (§47) becomes a query change rather than a migration, without any
 * multi-company code being written now.
 */
export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),

  // Identity
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name'),
  croNumber: text('cro_number'),
  companyType: text('company_type'), // LTD, DAC, CLG, ULC, sole trader...
  dateIncorporated: text('date_incorporated'),

  // Addresses
  registeredOffice: text('registered_office'),
  principalBusinessAddress: text('principal_business_address'),
  recordsAddress: text('records_address'),

  // Tax identity
  taxReferenceNumber: text('tax_reference_number'),
  vatNumber: text('vat_number'),
  vatRegistrationDate: text('vat_registration_date'),
  vatRegistrationStatus: text('vat_registration_status', {
    enum: ['not_registered', 'registered', 'deregistered', 'pending'],
  }).notNull().default('not_registered'),
  vatDeregistrationDate: text('vat_deregistration_date'),
  eoriNumber: text('eori_number'),
  revenueRegistrationInfo: text('revenue_registration_info'),

  corporationTaxRegistered: integer('corporation_tax_registered', { mode: 'boolean' })
    .notNull().default(false),
  corporationTaxRegistrationDate: text('corporation_tax_registration_date'),

  /**
   * The accounting basis for VAT. This is not a cosmetic preference: it decides
   * the tax point of output VAT and therefore which period a sale falls into.
   * See docs/DOMAIN_MODEL.md §6.
   */
  vatAccountingBasis: text('vat_accounting_basis', {
    enum: ['invoice', 'cash_receipts'],
  }).notNull().default('cash_receipts'),

  vatPeriodFrequency: text('vat_period_frequency', {
    enum: ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual', 'custom'],
  }).notNull().default('bi_monthly'),

  // Accounting year end, stored as day/month so it survives year rollover.
  financialYearEndDay: integer('financial_year_end_day').notNull().default(31),
  financialYearEndMonth: integer('financial_year_end_month').notNull().default(12),

  baseCurrency: text('base_currency').notNull().default('EUR'),

  // Demo data must be unmistakable (README §51).
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),

  /**
   * A folder the user points Leabhar at for on-demand document ingest. The
   * "Refresh from folder" action scans this path for new invoices/receipts,
   * stores them, reads them with the local provider, and moves the originals
   * into a `processed/` subfolder. One path maps to one company, so an
   * auto-pulled file always knows which books it belongs to.
   */
  documentWatchPath: text('document_watch_path'),

  notes: text('notes'),
  ...timestamps,
});

/** Company officers: directors, secretary, shareholders (README §5). */
export const companyOfficers = sqliteTable('company_officers', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  role: text('role', {
    enum: ['director', 'secretary', 'shareholder', 'company_secretary_firm', 'other'],
  }).notNull(),
  address: text('address'),
  dateOfBirth: text('date_of_birth'),
  nationality: text('nationality'),
  ppsn: text('ppsn'),
  appointedOn: text('appointed_on'),
  resignedOn: text('resigned_on'),
  // Shareholding, where the officer is a shareholder.
  sharesHeld: integer('shares_held'),
  shareClass: text('share_class'),
  /**
   * Links this officer to their director's current account, so personally-paid
   * expenses (§28) post to the right person rather than a single pooled account.
   */
  currentAccountId: text('current_account_id'),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('officers_company_idx').on(t.companyId)]);

/** Issued share capital (README §5). */
export const shareCapital = sqliteTable('share_capital', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  shareClass: text('share_class').notNull().default('Ordinary'),
  authorisedShares: integer('authorised_shares'),
  issuedShares: integer('issued_shares').notNull().default(0),
  nominalValueMinor: integer('nominal_value_minor').notNull().default(100),
  currency: text('currency').notNull().default('EUR'),
  notes: text('notes'),
  ...timestamps,
});

/** Bank accounts (README §5). */
export const bankAccounts = sqliteTable('bank_accounts', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  bankName: text('bank_name').notNull(),
  accountName: text('account_name').notNull(),
  iban: text('iban'),
  bic: text('bic'),
  accountNumber: text('account_number'),
  sortCode: text('sort_code'),
  currency: text('currency').notNull().default('EUR'),
  accountType: text('account_type', {
    enum: ['current', 'deposit', 'savings', 'credit_card', 'loan', 'merchant', 'other'],
  }).notNull().default('current'),

  openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
  openingDate: text('opening_date').notNull(),
  closingDate: text('closing_date'),

  /** The ledger account this bank account posts to. */
  accountId: text('account_id'),

  /** Where the manual refresh (§14) looks for statements for this account. */
  importWatchPath: text('import_watch_path'),
  /** Remembered column mapping for this account's statement format (§13). */
  defaultImportProfileId: text('default_import_profile_id'),

  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('bank_accounts_company_idx').on(t.companyId)]);

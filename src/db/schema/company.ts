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
  /**
   * Who the books are for (issue #212): a company (corporation tax), a sole
   * trader or a partnership (income tax on the owners). Chart, tax
   * computation and deadlines follow it.
   */
  entityType: text('entity_type', { enum: ['company', 'sole_trader', 'partnership'] }).notNull().default('company'),
  /** When the trade began and, if it has, ended: the income tax basis rules turn on them (TCA ss.66, 67). */
  tradeCommencedOn: text('trade_commenced_on'),
  tradeCeasedOn: text('trade_ceased_on'),
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

  /**
   * How documents are read (issue #202): 'local' — the scripts in this app
   * (PDF text layer, Tesseract OCR), nothing leaves the machine; 'anthropic' —
   * an AI model, only if the user chooses it and a key is configured. Either
   * way every document is confirmed by a person before it is used.
   */
  extractionEngine: text('extraction_engine', { enum: ['local', 'anthropic'] })
    .notNull().default('local'),

  vatPeriodFrequency: text('vat_period_frequency', {
    enum: ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual', 'custom'],
  }).notNull().default('bi_monthly'),

  // Accounting year end, stored as day/month so it survives year rollover.
  financialYearEndDay: integer('financial_year_end_day').notNull().default(31),
  financialYearEndMonth: integer('financial_year_end_month').notNull().default(12),

  baseCurrency: text('base_currency').notNull().default('EUR'),

  /**
   * Whether the company is a principal for Relevant Contracts Tax (TCA 1997
   * s.530A), which decides the VAT reverse charge on construction services it
   * receives (VATCA s.16(3), issue #208). Recorded by a person, from a date,
   * with what it rests on; never inferred.
   */
  rctPrincipal: text('rct_principal', { enum: ['principal', 'not_principal'] }),
  rctPrincipalFrom: text('rct_principal_from'),
  rctPrincipalBasis: text('rct_principal_basis'),
  rctPrincipalConfirmedBy: text('rct_principal_confirmed_by'),
  rctPrincipalConfirmedAt: text('rct_principal_confirmed_at'),

  /**
   * Revenue's authorisation to account on the moneys-received basis (VATCA
   * s.80, S.I. 639/2010 reg.25), and which s.80(1) test the company met.
   * `vatAccountingBasis` says how the books are kept; these say whether that
   * basis is authorised, and from when (issue #208).
   */
  cashBasisEligibility: text('cash_basis_eligibility', { enum: ['turnover_threshold', 'supplies_to_unregistered'] }),
  cashBasisAuthorisedFrom: text('cash_basis_authorised_from'),
  cashBasisAuthorisationReference: text('cash_basis_authorisation_reference'),
  cashBasisConfirmedBy: text('cash_basis_confirmed_by'),
  cashBasisConfirmedAt: text('cash_basis_confirmed_at'),

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

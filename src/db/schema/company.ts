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
  /**
   * The EORI number for customs (issue #297). A person records it and says
   * what they checked it against; `recordEoriNumber` writes the confirmation
   * fields beside it.
   */
  eoriNumber: text('eori_number'),
  eoriBasis: text('eori_basis'),
  eoriConfirmedBy: text('eori_confirmed_by'),
  eoriConfirmedAt: text('eori_confirmed_at'),
  /**
   * The VAT identification number used for intra-Community transactions
   * (issue #297). In Ireland it is the registration number with the extra
   * character Revenue issues for VIES, so it can differ from `vatNumber`; the
   * VIES statement carries it, not the registration number.
   */
  euVatNumber: text('eu_vat_number'),
  euVatRegisteredFrom: text('eu_vat_registered_from'),
  euVatBasis: text('eu_vat_basis'),
  euVatConfirmedBy: text('eu_vat_confirmed_by'),
  euVatConfirmedAt: text('eu_vat_confirmed_at'),
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

  /**
   * When the books were archived (issue #297): taken out of the working set
   * without anything being deleted. An archived business is not the active
   * one, but it can be brought back, and everything recorded about it is
   * still there.
   */
  archivedAt: text('archived_at'),
  archivedBy: text('archived_by'),
  archiveBasis: text('archive_basis'),

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
  /**
   * What kind of account this is (issue #377). It decides the ledger account a
   * new bank account posts to: a bank or cash account is an asset, a credit
   * card or a loan is money owed, a liability.
   */
  accountType: text('account_type', {
    enum: ['current', 'deposit', 'savings', 'credit_card', 'loan', 'merchant', 'cash', 'other'],
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

/**
 * Loans (issue #358): the mirror of `bank_accounts` — each borrowing linked to
 * the liability account that carries its outstanding balance, so a term loan
 * is posted to its own account rather than every loan folding into one.
 *
 * The register records the loan's identity and terms. The balance is never
 * stored here: the ledger account it points at is the only source of truth for
 * figures, and a repayment's capital/interest split (issue #158) posts against
 * that account.
 *
 * `accountId` is a plain text column rather than a foreign key, for the same
 * reason `bank_accounts` left its link untyped: `accounts` references
 * `companies`, so typing it back would be a circular import.
 */
export const loans = sqliteTable('loans', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  lenderName: text('lender_name').notNull(),
  loanName: text('loan_name').notNull(),
  kind: text('kind', {
    enum: ['term_loan', 'hire_purchase', 'mortgage', 'credit_line', 'other'],
  }).notNull().default('term_loan'),
  currency: text('currency').notNull().default('EUR'),
  /** The ledger liability account this loan's outstanding balance lives in. */
  accountId: text('account_id').notNull(),
  /** The principal as agreed, not the running balance — that is the ledger. */
  principalMinor: integer('principal_minor').notNull().default(0),
  drawdownDate: text('drawdown_date'),
  maturityDate: text('maturity_date'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('loans_company_idx').on(t.companyId)]);

/**
 * Trading names (issue #297): a business may trade under more than one name,
 * and the names it traded under change over time. Rows are effective-dated and
 * never deleted — a name stops with `effectiveTo`; the `companies.tradingName`
 * field stays as the current name, updated in the same transaction as the row
 * that set it, so screens keep working off one value.
 */
export const companyTradingNames = sqliteTable('company_trading_names', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  /** null == still trading under this name. */
  effectiveTo: text('effective_to'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('company_trading_names_company_idx').on(t.companyId)]);

/**
 * The activities the business trades in (issue #297). A business can run more
 * than one, and they start and stop on their own dates; the accounts of a sole
 * trader or partnership are per-activity in places (income averaging, stock
 * relief), so the activity list is evidence, not decoration. A farm is one
 * sector among these, with its Department of Agriculture herd number.
 */
export const companyTradingActivities = sqliteTable('company_trading_activities', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  sector: text('sector', {
    enum: [
      'farming', 'retail', 'construction', 'professional_services', 'hospitality',
      'transport', 'manufacturing', 'other',
    ],
  }).notNull(),
  commencedOn: text('commenced_on').notNull(),
  /** null == still trading. */
  ceasedOn: text('ceased_on'),
  /** Department of Agriculture herd number. Recorded for farming only. */
  herdNumber: text('herd_number'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('company_trading_activities_company_idx').on(t.companyId)]);

/**
 * Tax and Revenue registrations the books need to know about (issue #297):
 * income tax (a sole trader's or partnership's own registration), PAYE (the
 * employer registration payroll runs against, EPIC 20, #315), RCT, and
 * anything else the business is registered for. VAT and corporation tax have their
 * own dated columns on `companies` because VAT turns on them everywhere.
 * Effective-dated like every other registration fact.
 */
export const companyRegistrations = sqliteTable('company_registrations', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  registrationType: text('registration_type', {
    enum: ['income_tax', 'paye', 'rct', 'other'],
  }).notNull(),
  /** What the registration is, where the type is 'other' (e.g. "DAC7"). */
  label: text('label'),
  registrationNumber: text('registration_number'),
  registeredFrom: text('registered_from').notNull(),
  /** null == still registered. */
  deregisteredOn: text('deregistered_on'),
  notes: text('notes'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('company_registrations_company_idx').on(t.companyId)]);

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies, companyOfficers } from './company';

/**
 * Payroll (EPIC 20, issues #524–#527).
 *
 * The employer's records the Income Tax (Employments) Regulations 2018
 * (S.I. 345/2018) require: who is employed (reg.17(2)), the particulars
 * reported on each payment (reg.10(1)), the Revenue payroll notification each
 * payment is calculated from (reg.6(3)), and the payslip figures themselves.
 */

export const PAY_FREQUENCIES = ['weekly', 'fortnightly', 'monthly'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

/**
 * An employee (issue #524). The identity and the job's fixed particulars;
 * what they are paid, and on what pension terms, is effective-dated in
 * `employmentTerms` (invariant 6).
 */
export const employees = sqliteTable('employees', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /**
   * Personal public service number (reg.17(1)), normalised to upper case.
   * Null when the employee has not given one: tax is then deducted at the
   * higher rate on the emergency basis (reg.19(2)).
   */
  ppsn: text('ppsn'),
  dateOfBirth: text('date_of_birth'),
  address: text('address'),
  email: text('email'),
  /** The employer's unique staff identifier (reg.10(1)(j)). */
  employerReference: text('employer_reference').notNull(),
  /** The unique identifier of this employment (reg.10(1)(k)). */
  employmentId: text('employment_id').notNull(),
  /** Commencement of the employment (reg.17(2)(c)). */
  startDate: text('start_date').notNull(),
  /** Cessation (reg.17(3)); null while employed. */
  leftOn: text('left_on'),
  /** The normal pay frequency (reg.10(1)(b); reg.11(3)). */
  payFrequency: text('pay_frequency', { enum: PAY_FREQUENCIES }).notNull(),
  /** A director, and whether a proprietary director (reg.10(1)(i)). */
  isDirector: integer('is_director', { mode: 'boolean' }).notNull().default(false),
  isProprietaryDirector: integer('is_proprietary_director', { mode: 'boolean' }).notNull().default(false),
  /** The officer record of a director, so their pay posts to directors' remuneration against them. */
  officerId: text('officer_id').references(() => companyOfficers.id),
  /** PRSI class. Only Class A is computed; any other class is refused, never approximated. */
  prsiClass: text('prsi_class', { enum: ['A', 'S', 'J', 'M'] }).notNull().default('A'),
  recordedBy: text('recorded_by').notNull(),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('employees_company_idx').on(t.companyId),
  uniqueIndex('employees_employer_reference_unique').on(t.companyId, t.employerReference),
]);

/**
 * The terms of an employment, effective-dated (issues #524, #525): the pay
 * basis and the pension terms. A change is a new row from its date, closing
 * the previous one; a row is never edited.
 */
export const employmentTerms = sqliteTable('employment_terms', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  employeeId: text('employee_id').notNull().references(() => employees.id),
  payBasis: text('pay_basis', { enum: ['salary', 'hourly'] }).notNull(),
  /** Annual salary, for a salaried employment. */
  annualSalaryMinor: integer('annual_salary_minor'),
  /** Rate per hour, for an hourly employment (and the base for overtime). */
  hourlyRateMinor: integer('hourly_rate_minor'),
  /** Normal hours per pay period, in hundredths; informational for a salaried employment. */
  normalHoursHundredths: integer('normal_hours_hundredths'),
  /** The pension arrangement the employee's own contributions are deducted under (S.I. 345/2018 reg.31(1)). */
  pensionScheme: text('pension_scheme', { enum: ['none', 'occupational', 'prsa', 'rac'] }).notNull().default('none'),
  /** Employee contribution: a percentage of gross cash pay (basis points), or a fixed amount per period. */
  pensionEmployeeBasisPoints: integer('pension_employee_basis_points'),
  pensionEmployeeFixedMinor: integer('pension_employee_fixed_minor'),
  /** Employer contribution, on the same bases. */
  pensionEmployerBasisPoints: integer('pension_employer_basis_points'),
  pensionEmployerFixedMinor: integer('pension_employer_fixed_minor'),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'),
  recordedBy: text('recorded_by').notNull(),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('employment_terms_employee_idx').on(t.employeeId, t.effectiveFrom)]);

/**
 * One USC band on an RPN, in order: the rate and the part of the year's pay
 * charged at it (the band's width, as the s.531AN Table states "the first
 * €12,012", "the next €16,688"), null for the last band, which has no limit.
 */
export interface RpnUscBand { rateBasisPoints: number; yearlyBandMinor: number | null }

/**
 * A Revenue payroll notification (issue #526; S.I. 345/2018 reg.6, S.I.
 * 510/2018 reg.10). Each is immutable: a later RPN supersedes the earlier one
 * from its own date (reg.8), and the payslips keep the RPN they used.
 *
 * Until RPN retrieval exists (#528) an RPN is copied by hand from ROS, so it
 * is recorded as the person's entry (`source = 'user'`).
 */
export const revenuePayrollNotifications = sqliteTable('revenue_payroll_notifications', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  employeeId: text('employee_id').notNull().references(() => employees.id),
  rpnNumber: text('rpn_number').notNull(),
  taxYear: integer('tax_year').notNull(),
  /** The first pay date this RPN is used for. */
  effectiveFrom: text('effective_from').notNull(),
  taxBasis: text('tax_basis', { enum: ['cumulative', 'week1', 'emergency'] }).notNull(),
  yearlyTaxCreditsMinor: integer('yearly_tax_credits_minor').notNull(),
  yearlySrcopMinor: integer('yearly_srcop_minor').notNull(),
  /** Exempt: Revenue determined no cut-off points (S.I. 510/2018 reg.8(2)), so no USC is deducted (reg.12(2)). */
  uscStatus: text('usc_status', { enum: ['ordinary', 'exempt'] }).notNull(),
  uscBasis: text('usc_basis', { enum: ['cumulative', 'week1', 'emergency'] }).notNull(),
  uscBands: text('usc_bands', { mode: 'json' }).$type<RpnUscBand[]>().notNull(),
  prsiExempt: integer('prsi_exempt', { mode: 'boolean' }).notNull().default(false),
  /** Pay and tax from the employee's previous employments this year (reg.6(1)(b)). */
  previousPayMinor: integer('previous_pay_minor').notNull().default(0),
  previousTaxMinor: integer('previous_tax_minor').notNull().default(0),
  previousUscPayMinor: integer('previous_usc_pay_minor').notNull().default(0),
  previousUscMinor: integer('previous_usc_minor').notNull().default(0),
  supersedesRpnId: text('supersedes_rpn_id'),
  recordedBy: text('recorded_by').notNull(),
  ...provenance,
  ...timestamps,
}, (t) => [index('rpns_employee_idx').on(t.employeeId, t.taxYear, t.effectiveFrom)]);

/**
 * A pay run (issue #527): one pay date for the employees on one pay
 * frequency. Draft runs are computed and recomputed; a posted run is
 * immutable and is corrected only by reversing it.
 */
export const payRuns = sqliteTable('pay_runs', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  payFrequency: text('pay_frequency', { enum: PAY_FREQUENCIES }).notNull(),
  taxYear: integer('tax_year').notNull(),
  /** The pay period number in the tax year (week, fortnight or month; reg.11(2)(b)). */
  periodNumber: integer('period_number').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  payDate: text('pay_date').notNull(),
  /** PRSI insurable weeks in the pay period (issue #529). */
  insurableWeeks: integer('insurable_weeks').notNull(),
  status: text('status', { enum: ['draft', 'posted', 'reversed'] }).notNull().default('draft'),
  journalEntryId: text('journal_entry_id'),
  postedBy: text('posted_by'),
  postedAt: text('posted_at'),
  reversalJournalEntryId: text('reversal_journal_entry_id'),
  reversalReason: text('reversal_reason'),
  reversedBy: text('reversed_by'),
  /** The net pay leaving the bank (Dr net wages payable / Cr bank). */
  netPayJournalEntryId: text('net_pay_journal_entry_id'),
  netPaidOn: text('net_paid_on'),
  netPayBankTransactionId: text('net_pay_bank_transaction_id'),
  createdBy: text('created_by').notNull(),
  notes: text('notes'),
  ...timestamps,
}, (t) => [index('pay_runs_company_idx').on(t.companyId, t.taxYear, t.payDate)]);

export const TAX_BASES = [
  'cumulative', 'week1', 'emergency_no_ppsn', 'emergency_initial', 'emergency_higher',
] as const;
export type PayslipTaxBasis = (typeof TAX_BASES)[number];

/** A figure a payslip resolved from a rule, snapshotted (invariant 6). */
export interface PayslipRuleFigure { ruleKey: string; value: number | null; rateBasisPoints: number | null; status: string }

/**
 * A payslip (issues #526, #527): one employee's figures on one run. The
 * figures are computed by the domain and stored with the rules and RPN they
 * rest on, so a posted payslip can always be re-checked.
 */
export const payslips = sqliteTable('payslips', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  payRunId: text('pay_run_id').notNull().references(() => payRuns.id),
  employeeId: text('employee_id').notNull().references(() => employees.id),
  rpnId: text('rpn_id').references(() => revenuePayrollNotifications.id),
  employmentTermsId: text('employment_terms_id').references(() => employmentTerms.id),
  taxBasis: text('tax_basis', { enum: TAX_BASES }).notNull(),
  uscBasis: text('usc_basis', { enum: ['cumulative', 'week1', 'emergency', 'exempt'] }).notNull(),
  periodNumber: integer('period_number').notNull(),

  /** Cash pay: salary, hours, overtime, bonuses. */
  grossPayMinor: integer('gross_pay_minor').notNull(),
  /** Benefits in kind: notional pay, taxed but never paid in cash (TCA s.985A). */
  notionalPayMinor: integer('notional_pay_minor').notNull(),
  pensionEmployeeMinor: integer('pension_employee_minor').notNull(),
  pensionEmployerMinor: integer('pension_employer_minor').notNull(),

  /** Pay for income tax this period: gross + notional − allowable pension contributions (reg.31). */
  payForTaxMinor: integer('pay_for_tax_minor').notNull(),
  /** Income tax this period; negative is a refund (reg.11(4)). */
  taxMinor: integer('tax_minor').notNull(),
  cumulativePayForTaxMinor: integer('cumulative_pay_for_tax_minor').notNull(),
  cumulativeTaxMinor: integer('cumulative_tax_minor').notNull(),
  cumulativeSrcopMinor: integer('cumulative_srcop_minor').notNull(),
  cumulativeCreditsMinor: integer('cumulative_credits_minor').notNull(),

  payForUscMinor: integer('pay_for_usc_minor').notNull(),
  uscMinor: integer('usc_minor').notNull(),
  cumulativePayForUscMinor: integer('cumulative_pay_for_usc_minor').notNull(),
  cumulativeUscMinor: integer('cumulative_usc_minor').notNull(),

  prsiClass: text('prsi_class').notNull(),
  insurableWeeks: integer('insurable_weeks').notNull(),
  reckonableEarningsMinor: integer('reckonable_earnings_minor').notNull(),
  prsiEmployeeMinor: integer('prsi_employee_minor').notNull(),
  prsiEmployerMinor: integer('prsi_employer_minor').notNull(),
  /** National Training Fund levy (NTF Act 2000 s.4), collected with employer PRSI. */
  ntfLevyMinor: integer('ntf_levy_minor').notNull(),

  netPayMinor: integer('net_pay_minor').notNull(),

  /** What the person recorded for the period (hours, overtime, bonuses, benefits): the draft is recomputed from it. */
  inputs: text('inputs', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** Every rule figure the payslip used, snapshotted. */
  ruleFigures: text('rule_figures', { mode: 'json' }).$type<PayslipRuleFigure[]>().notNull(),
  /** The working, line by line, and what the books cannot know. */
  working: text('working', { mode: 'json' }).$type<string[]>().notNull(),
  findings: text('findings', { mode: 'json' }).$type<string[]>().notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('payslips_run_employee_unique').on(t.payRunId, t.employeeId),
  index('payslips_employee_idx').on(t.employeeId),
]);

export const PAY_LINE_KINDS = ['salary', 'hourly', 'overtime', 'bonus', 'commission', 'benefit_in_kind'] as const;
export type PayLineKind = (typeof PAY_LINE_KINDS)[number];

/**
 * A pay element on a payslip (issue #525). Its amount is computed from the
 * figures on the line (hours × rate × multiplier, salary ÷ periods), except a
 * bonus, commission or benefit, which is an amount the person records.
 */
export const payslipLines = sqliteTable('payslip_lines', {
  id: text('id').primaryKey(),
  payslipId: text('payslip_id').notNull().references(() => payslips.id),
  kind: text('kind', { enum: PAY_LINE_KINDS }).notNull(),
  description: text('description').notNull(),
  /** Hours, in hundredths, for hourly and overtime lines. */
  quantityHundredths: integer('quantity_hundredths'),
  rateMinor: integer('rate_minor'),
  /** Overtime multiplier in basis points (15000 = time and a half). */
  multiplierBasisPoints: integer('multiplier_basis_points'),
  /** For a benefit in kind: the kind of benefit (reg.14 apportions car, van, loan and asset benefits). */
  benefitCategory: text('benefit_category', { enum: ['car', 'van', 'preferential_loan', 'employer_asset', 'other'] }),
  amountMinor: integer('amount_minor').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [index('payslip_lines_payslip_idx').on(t.payslipId)]);

/**
 * A payment to Revenue of a month's payroll liabilities (issue #527): the
 * PAYE, USC and PRSI the posted runs of that month credited, paid down.
 */
export const payrollRemittances = sqliteTable('payroll_remittances', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  /** The month the pay dates fall in, YYYY-MM. */
  month: text('month').notNull(),
  payeMinor: integer('paye_minor').notNull(),
  uscMinor: integer('usc_minor').notNull(),
  prsiMinor: integer('prsi_minor').notNull(),
  paidOn: text('paid_on').notNull(),
  journalEntryId: text('journal_entry_id').notNull(),
  bankTransactionId: text('bank_transaction_id'),
  recordedBy: text('recorded_by').notNull(),
  ...timestamps,
}, (t) => [index('payroll_remittances_company_idx').on(t.companyId, t.month)]);

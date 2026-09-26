import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, customers, suppliers } from '@/db/schema';
import {
  createCompany, addBankAccount, ensureDefaultAccounts, ensureDefaultVatTreatments, type CreatedCompany,
} from '@/domain/config/setup';
import { createAccount, upsertCustomer } from '@/domain/config/mutations';
import { parseAmount } from '@/domain/money';
import { createRule, type RuleCondition, type RuleAction } from '@/domain/rules/engine';
import { resolveAccountId, resolveVatTreatmentId } from './reconcile';
import type {
  InitCompanyInput, AddBankInput, AddAccountInput, AddCustomerInput, ListPartiesInput,
  EnsureDefaultAccountsInput, InstallRulePackInput,
} from './schema';

/**
 * CLI induction commands (issue #153): everything needed to load a
 * non-demo company end-to-end, without a hand-written `tsx` harness.
 *
 * `db:seed` only ever loads the Acme demo, and every other CLI command
 * assumes a company, bank account and chart already exist. These wrappers
 * are the missing first step — no Next.js dependency, same as the rest of
 * `src/agent/`.
 */

export function initCompany(db: AppDatabase, input: InitCompanyInput): CreatedCompany {
  let financialYearEndDay: number | undefined;
  let financialYearEndMonth: number | undefined;
  if (input.yearEnd) {
    const [month, day] = input.yearEnd.split('-').map(Number);
    financialYearEndDay = day;
    financialYearEndMonth = month;
  }

  const seedYears = input.seedYears
    ? input.seedYears.split(',').map((y) => Number(y.trim())).filter((y) => Number.isInteger(y))
    : [new Date().getFullYear()];

  return createCompany(db, {
    legalName: input.legalName,
    tradingName: input.tradingName,
    croNumber: input.croNumber,
    vatNumber: input.vatNumber,
    vatRegistrationStatus: input.vatRegistrationStatus,
    vatAccountingBasis: input.vatAccountingBasis,
    vatPeriodFrequency: input.vatPeriodFrequency,
    financialYearEndDay,
    financialYearEndMonth,
    baseCurrency: input.baseCurrency,
    seedYears,
    entityType: input.entityType,
    tradeCommencedOn: input.tradeCommencedOn,
  });
}

export interface AddBankResult {
  bankAccountId: string;
  openingBalancePosted: boolean;
}

export function addBank(db: AppDatabase, input: AddBankInput): AddBankResult {
  const company = db.select({ baseCurrency: companies.baseCurrency }).from(companies)
    .where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);
  const currency = (input.currency ?? company.baseCurrency).toUpperCase();

  const openingBalanceMinor = input.opening !== undefined
    ? parseAmount(input.opening, currency)
    : 0;

  if (openingBalanceMinor !== 0 && !input.openingDate) {
    throw new Error('--opening was given without --opening-date. An opening balance needs a date '
      + 'to journal it against.');
  }

  const bankAccountId = addBankAccount(db, {
    companyId: input.companyId,
    bankName: input.bankName,
    accountName: input.accountName ?? input.bankName,
    iban: input.iban,
    bic: input.bic,
    currency,
    accountType: input.accountType,
    openingBalanceMinor,
    openingDate: input.openingDate ?? '1900-01-01',
    actor: 'cli',
  });

  return { bankAccountId, openingBalancePosted: openingBalanceMinor !== 0 };
}

/**
 * Report sections `profitAndLoss`/`balanceSheet` (`domain/reports/financial.ts`)
 * actually sum. An account posted to any other section is silently excluded
 * from both reports' totals rather than erroring, so a section outside this
 * set — or none given at all — is resolved here rather than left to the
 * domain layer to accept blindly.
 */
const KNOWN_REPORT_SECTIONS = new Set([
  'revenue', 'cost_of_sales', 'operating_expenses',
  'fixed_assets', 'current_assets', 'current_liabilities', 'equity',
]);

const DEFAULT_REPORT_SECTION_BY_TYPE: Record<AddAccountInput['type'], string> = {
  asset: 'current_assets',
  liability: 'current_liabilities',
  equity: 'equity',
  income: 'revenue',
  expense: 'operating_expenses',
};

export function addAccount(db: AppDatabase, input: AddAccountInput): { accountId: string } {
  const reportSection = input.reportSection ?? DEFAULT_REPORT_SECTION_BY_TYPE[input.type];
  if (!KNOWN_REPORT_SECTIONS.has(reportSection)) {
    throw new Error(
      `"${reportSection}" is not a report section the profit & loss or balance sheet reads — `
        + `an account posted there would never appear in either report's totals. Use one of: `
        + `${[...KNOWN_REPORT_SECTIONS].join(', ')}.`,
    );
  }

  const accountId = createAccount(db, {
    companyId: input.companyId,
    code: input.code,
    name: input.name,
    type: input.type,
    subtype: input.subtype,
    reportSection,
    vatApplicable: input.vatApplicable,
    actor: 'cli',
  });
  return { accountId };
}

export function addCustomer(db: AppDatabase, input: AddCustomerInput): { customerId: string } {
  const defaultAccountId = input.defaultAccount
    ? resolveAccountId(db, input.companyId, input.defaultAccount)
    : null;

  const customerId = upsertCustomer(db, {
    companyId: input.companyId,
    name: input.name,
    countryCode: input.countryCode ?? null,
    vatNumber: input.vatNumber ?? null,
    defaultAccountId,
    taxableStatus: input.taxableStatus,
    actor: 'cli',
  });
  return { customerId };
}

const matchKeyOf = (name: string): string => name.toLowerCase()
  .replace(/\b(limited|ltd|plc|inc|incorporated|llc|gmbh|bv|sarl|pbc|co)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

/** Resolve a customer by name (case/legal-suffix-insensitive) or accept an id directly. */
export function resolveCustomerId(db: AppDatabase, companyId: string, nameOrId: string): string {
  if (nameOrId.startsWith('cus_')) return nameOrId;
  const row = db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.companyId, companyId), eq(customers.matchKey, matchKeyOf(nameOrId)))).get();
  if (!row) throw new Error(`Customer "${nameOrId}" not found. Use add-customer to create it first.`);
  return row.id;
}

/** Resolve a supplier by name (case/legal-suffix-insensitive) or accept an id directly. */
export function resolveSupplierId(db: AppDatabase, companyId: string, nameOrId: string): string {
  if (nameOrId.startsWith('sup_')) return nameOrId;
  const row = db.select({ id: suppliers.id }).from(suppliers)
    .where(and(eq(suppliers.companyId, companyId), eq(suppliers.matchKey, matchKeyOf(nameOrId)))).get();
  if (!row) throw new Error(`Supplier "${nameOrId}" not found. Use create-supplier to create it first.`);
  return row.id;
}

/**
 * List suppliers/customers created via create-invoice/journal by name or id
 * alone (issue #155) — until now nothing gave that name/id pairing back.
 */
export function listSuppliersCli(db: AppDatabase, input: ListPartiesInput) {
  return db.select({
    id: suppliers.id,
    name: suppliers.name,
    countryCode: suppliers.countryCode,
    vatNumber: suppliers.vatNumber,
    active: suppliers.active,
  }).from(suppliers)
    .where(eq(suppliers.companyId, input.companyId))
    .orderBy(suppliers.name)
    .all();
}

export function listCustomersCli(db: AppDatabase, input: ListPartiesInput) {
  return db.select({
    id: customers.id,
    name: customers.name,
    countryCode: customers.countryCode,
    vatNumber: customers.vatNumber,
    active: customers.active,
  }).from(customers)
    .where(eq(customers.companyId, input.companyId))
    .orderBy(customers.name)
    .all();
}

/**
 * Add any default chart accounts introduced since a company was created
 * (issue #159) — 6180 Wages and salaries, 6190 Employer PRSI, 5030
 * Materials, 2210 Bank loans, 1020 Bank deposit/saver, for a company
 * induced before those existed. A new company gets them all from
 * `createCompany` already; this is only for one created earlier.
 */
export function ensureDefaultAccountsCli(
  db: AppDatabase, input: EnsureDefaultAccountsInput,
): { added: string[]; addedRates: string[]; addedTreatments: string[] } {
  const { added } = ensureDefaultAccounts(db, input.companyId, 'cli');
  return { added, ...ensureDefaultVatTreatments(db, input.companyId, 'cli') };
}

/**
 * Install a starter pack of Irish SME bank-narrative rules (issue #159) —
 * wages, employer PRSI, a Revenue PAYE remittance, a VAT3 payment, rent, an
 * own-account transfer to savings, director drawings. Every rule is a normal,
 * user-editable row: this is a starting point, not a fixed behaviour, and a
 * rule that turns out wrong for this company can be edited or disabled like
 * any other. A Stripe payout or a loan repayment's capital/interest split is
 * deliberately left out — those are a multi-line split (`journal
 * --transaction`, issue #158), not a single account a rule could point at.
 */
export function installRulePackCli(
  db: AppDatabase, input: InstallRulePackInput,
): Array<{ ruleId: string; name: string }> {
  const outOfScope = resolveVatTreatmentId(db, input.companyId, 'OUT_OF_SCOPE');
  const exempt = resolveVatTreatmentId(db, input.companyId, 'IE_EXEMPT');

  const wagesAccount = resolveAccountId(db, input.companyId, '6180');
  const employerPrsiAccount = resolveAccountId(db, input.companyId, '6190');
  const payePayableAccount = resolveAccountId(db, input.companyId, '2400');
  const vatPayableAccount = resolveAccountId(db, input.companyId, '2100');
  const rentAccount = resolveAccountId(db, input.companyId, input.rentAccount ?? '6200');
  const secondBankAccount = resolveAccountId(db, input.companyId, input.secondBankAccount ?? '1020');
  const directorsAccount = resolveAccountId(db, input.companyId, '2500');

  const installed: Array<{ ruleId: string; name: string }> = [];
  const install = (params: {
    name: string; description?: string;
    conditions: RuleCondition[]; actions: RuleAction[];
  }): void => {
    const ruleId = createRule(db, {
      companyId: input.companyId, autoApply: true, actor: 'cli', ...params,
    });
    installed.push({ ruleId, name: params.name });
  };

  const moneyOut: RuleCondition = { field: 'direction', operator: 'equals', value: 'out' };

  install({
    name: 'Salary payment',
    description: 'A wage/salary disbursement, matched by keyword. Add a rule for a '
      + 'specific employee name for a more precise match.',
    conditions: [{ field: 'description', operator: 'contains', value: 'SALARY' }, moneyOut],
    actions: [
      { field: 'accountId', value: wagesAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  if (input.employee) {
    install({
      name: `Salary payment — ${input.employee}`,
      conditions: [{ field: 'description', operator: 'contains', value: input.employee }, moneyOut],
      actions: [
        { field: 'accountId', value: wagesAccount },
        { field: 'vatTreatmentId', value: outOfScope },
      ],
    });
  }

  install({
    name: 'Employer PRSI',
    conditions: [{ field: 'description', operator: 'contains', value: 'EMPLOYER PRSI' }, moneyOut],
    actions: [
      { field: 'accountId', value: employerPrsiAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  install({
    name: 'Revenue PAYE remittance',
    conditions: [
      { field: 'description', operator: 'contains', value: 'REVENUE' },
      { field: 'description', operator: 'contains', value: 'PAYE' },
      moneyOut,
    ],
    actions: [
      { field: 'accountId', value: payePayableAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  install({
    name: 'VAT3 payment',
    conditions: [{ field: 'description', operator: 'contains', value: 'VAT3' }, moneyOut],
    actions: [
      { field: 'accountId', value: vatPayableAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  install({
    name: 'Rent standing order',
    description: 'Commercial rent is usually VAT-exempt — confirm against the actual '
      + 'lease if the landlord has opted to charge VAT.',
    conditions: [{ field: 'description', operator: 'contains', value: 'RENT' }, moneyOut],
    actions: [
      { field: 'accountId', value: rentAccount },
      { field: 'vatTreatmentId', value: exempt },
    ],
  });

  install({
    name: 'Transfer to savings',
    description: 'An own-account transfer, not a real expense — works for money moving '
      + 'either way between the two accounts.',
    conditions: [{ field: 'description', operator: 'contains', value: 'SAVER' }],
    actions: [
      { field: 'accountId', value: secondBankAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  install({
    name: 'Director drawings',
    conditions: [{ field: 'description', operator: 'contains', value: 'DIRECTOR' }, moneyOut],
    actions: [
      { field: 'accountId', value: directorsAccount },
      { field: 'vatTreatmentId', value: outOfScope },
    ],
  });

  return installed;
}

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, customers, suppliers } from '@/db/schema';
import {
  createCompany, addBankAccount, type CreatedCompany,
} from '@/domain/config/setup';
import { createAccount, upsertCustomer } from '@/domain/config/mutations';
import { parseAmount } from '@/domain/money';
import { resolveAccountId } from './reconcile';
import type {
  InitCompanyInput, AddBankInput, AddAccountInput, AddCustomerInput,
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

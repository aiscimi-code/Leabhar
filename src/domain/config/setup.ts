import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companies, accounts, taxRates, vatTreatments, accountingPeriods, vatPeriods,
  bankAccounts, auditEvents, glossaryTerms,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { type IsoDate, asIsoDate, nowIso, today } from '../dates';
import { DEFAULT_ACCOUNTS, type SystemAccountKey } from './chartOfAccounts';
import { DEFAULT_TAX_RATES, DEFAULT_VAT_TREATMENTS } from './vatTreatments';
import { generateVatPeriods, generateFinancialYear, type VatFrequency } from './periods';
import { GLOSSARY_TERMS } from '../help/glossary';
import { postJournalEntry } from '../accounting/journal';

export interface CreateCompanyInput {
  legalName: string;
  tradingName?: string;
  croNumber?: string;
  companyType?: string;
  dateIncorporated?: string;
  registeredOffice?: string;
  vatNumber?: string;
  vatRegistrationDate?: string;
  vatRegistrationStatus?: 'not_registered' | 'registered' | 'deregistered' | 'pending';
  taxReferenceNumber?: string;
  eoriNumber?: string;
  vatAccountingBasis?: 'invoice' | 'cash_receipts';
  vatPeriodFrequency?: VatFrequency;
  financialYearEndDay?: number;
  financialYearEndMonth?: number;
  baseCurrency?: string;
  isDemo?: boolean;
  /** Financial years and VAT periods to create up front. */
  seedYears?: number[];
}

export interface CreatedCompany {
  companyId: string;
  accountsByKey: Record<string, string>;
  accountsByCode: Record<string, string>;
  ratesByCode: Record<string, string>;
  treatmentsByCode: Record<string, string>;
}

/**
 * Create a company and install its default configuration.
 *
 * Everything installed here is a row in an editable table, not a constant in
 * code. The seed values are a starting point the user is expected to review —
 * which is why each carries its source note (README §48).
 */
export function createCompany(db: AppDatabase, input: CreateCompanyInput): CreatedCompany {
  return db.transaction((tx) => {
    const companyId = ids.company();
    const baseCurrency = (input.baseCurrency ?? 'EUR').toUpperCase();
    const yearEndDay = input.financialYearEndDay ?? 31;
    const yearEndMonth = input.financialYearEndMonth ?? 12;
    const frequency = input.vatPeriodFrequency ?? 'bi_monthly';
    const timestamp = nowIso();

    tx.insert(companies).values({
      id: companyId,
      legalName: input.legalName,
      tradingName: input.tradingName ?? null,
      croNumber: input.croNumber ?? null,
      companyType: input.companyType ?? 'Private company limited by shares (LTD)',
      dateIncorporated: input.dateIncorporated ?? null,
      registeredOffice: input.registeredOffice ?? null,
      vatNumber: input.vatNumber ?? null,
      vatRegistrationDate: input.vatRegistrationDate ?? null,
      vatRegistrationStatus: input.vatRegistrationStatus ?? 'not_registered',
      taxReferenceNumber: input.taxReferenceNumber ?? null,
      eoriNumber: input.eoriNumber ?? null,
      vatAccountingBasis: input.vatAccountingBasis ?? 'cash_receipts',
      vatPeriodFrequency: frequency,
      financialYearEndDay: yearEndDay,
      financialYearEndMonth: yearEndMonth,
      baseCurrency,
      isDemo: input.isDemo ?? false,
    }).run();

    // ---- Chart of accounts ----
    const accountsByKey: Record<string, string> = {};
    const accountsByCode: Record<string, string> = {};
    for (const [index, seed] of DEFAULT_ACCOUNTS.entries()) {
      const id = ids.account();
      tx.insert(accounts).values({
        id,
        companyId,
        code: seed.code,
        name: seed.name,
        type: seed.type,
        subtype: seed.subtype ?? null,
        vatApplicable: seed.vatApplicable ?? true,
        isSystem: seed.systemKey !== undefined,
        systemKey: seed.systemKey ?? null,
        reportSection: seed.reportSection,
        reportOrder: index,
        description: seed.description ?? null,
        effectiveFrom: input.dateIncorporated ?? '1900-01-01',
      }).run();
      accountsByCode[seed.code] = id;
      if (seed.systemKey) accountsByKey[seed.systemKey] = id;
    }

    // ---- Tax rates ----
    const ratesByCode: Record<string, string> = {};
    for (const seed of DEFAULT_TAX_RATES) {
      const id = ids.taxRate();
      tx.insert(taxRates).values({
        id,
        companyId,
        code: seed.code,
        name: seed.name,
        rateBasisPoints: seed.rateBasisPoints,
        taxType: seed.taxType,
        jurisdiction: seed.jurisdiction,
        reportingClassification: seed.reportingClassification ?? null,
        isDefault: seed.isDefault ?? false,
        notes: seed.notes ?? null,
        effectiveFrom: seed.effectiveFrom,
        sourceNote: seed.sourceNote ?? null,
        sourceDate: today(),
      }).run();
      ratesByCode[seed.code] = id;
    }

    // ---- VAT treatments ----
    const treatmentsByCode: Record<string, string> = {};
    for (const seed of DEFAULT_VAT_TREATMENTS) {
      const id = ids.vatTreatment();
      tx.insert(vatTreatments).values({
        id,
        companyId,
        code: seed.code,
        name: seed.name,
        description: seed.description,
        jurisdiction: seed.jurisdiction,
        direction: seed.direction,
        supplyKind: seed.supplyKind,
        appliesRate: seed.appliesRate,
        defaultTaxRateId: ratesByCode[seed.defaultRateCode] ?? null,
        isReverseCharge: seed.isReverseCharge ?? false,
        isRecoverable: seed.isRecoverable ?? true,
        recoverableBasisPoints: seed.recoverableBasisPoints ?? 10_000,
        salesVatBox: seed.salesVatBox ?? null,
        purchasesVatBox: seed.purchasesVatBox ?? null,
        netSalesBox: seed.netSalesBox ?? null,
        netPurchasesBox: seed.netPurchasesBox ?? null,
        requiresCounterpartyVatNumber: seed.requiresCounterpartyVatNumber ?? false,
        isDefault: seed.isDefault ?? false,
        isSystem: seed.isSystem ?? false,
        effectiveFrom: '1900-01-01',
        sourceNote: seed.sourceNote ?? null,
        sourceDate: today(),
      }).run();
      treatmentsByCode[seed.code] = id;
    }

    // Wire sensible default treatments onto expense accounts.
    const standardTreatment = treatmentsByCode['IE_STD'];
    const outOfScope = treatmentsByCode['OUT_OF_SCOPE'];
    for (const seed of DEFAULT_ACCOUNTS) {
      const accountId = accountsByCode[seed.code]!;
      const treatment = seed.vatApplicable === false ? outOfScope : standardTreatment;
      if (treatment) {
        tx.update(accounts).set({ defaultVatTreatmentId: treatment })
          .where(eq(accounts.id, accountId)).run();
      }
    }

    // ---- Periods ----
    for (const year of input.seedYears ?? []) {
      const { year: fy, months } = generateFinancialYear(yearEndDay, yearEndMonth, year);
      const fyId = ids.accountingPeriod();
      tx.insert(accountingPeriods).values({
        id: fyId, companyId, kind: 'financial_year', name: fy.name,
        startDate: fy.startDate, endDate: fy.endDate, status: 'open',
      }).run();

      for (const month of months) {
        tx.insert(accountingPeriods).values({
          id: ids.accountingPeriod(), companyId, kind: 'month', name: month.name,
          startDate: month.startDate, endDate: month.endDate, parentId: fyId, status: 'open',
        }).run();
      }

      for (const period of generateVatPeriods(year, frequency)) {
        tx.insert(vatPeriods).values({
          id: ids.vatPeriod(), companyId, name: period.name,
          startDate: period.startDate, endDate: period.endDate,
          filingDeadline: period.filingDeadline, frequency: period.frequency,
          status: 'open',
        }).run();
      }
    }

    // ---- Glossary (seeded once, globally) ----
    const existingGlossary = tx.select({ id: glossaryTerms.id }).from(glossaryTerms).limit(1).get();
    if (!existingGlossary) {
      for (const term of GLOSSARY_TERMS) {
        tx.insert(glossaryTerms).values({
          id: ids.glossary(),
          term: term.term,
          slug: term.slug,
          shortDefinition: term.shortDefinition,
          longDefinition: term.longDefinition ?? null,
          category: term.category ?? null,
          relatedTerms: term.relatedTerms ?? [],
          irishContext: term.irishContext ?? null,
        }).run();
      }
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId,
      occurredAt: timestamp,
      entityType: 'company',
      entityId: companyId,
      action: 'created',
      newValue: JSON.stringify({
        legalName: input.legalName,
        accounts: DEFAULT_ACCOUNTS.length,
        taxRates: DEFAULT_TAX_RATES.length,
        vatTreatments: DEFAULT_VAT_TREATMENTS.length,
      }),
      source: 'system',
      actor: 'setup',
      reason: 'Company created with default configuration',
    }).run();

    return { companyId, accountsByKey, accountsByCode, ratesByCode, treatmentsByCode };
  });
}

/** Resolve a system account, failing loudly rather than posting to the wrong place. */
export function systemAccountId(
  db: AppDatabase, companyId: string, key: SystemAccountKey,
): string {
  const row = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.systemKey, key)))
    .get();
  if (!row) {
    throw new Error(
      `System account "${key}" is missing for company ${companyId}. `
        + 'The chart of accounts must define it before postings can be made.',
    );
  }
  return row.id;
}

/**
 * Add a bank account and link it to its ledger control account.
 *
 * A nonzero `openingBalanceMinor` is also journaled — Dr/Cr the account's own
 * control account against retained earnings, dated at `openingDate` — not
 * merely stored on this row. Before this, the figure sat only on
 * `bank_accounts.opening_balance_minor` and never reached the ledger, so the
 * balance a supplied statement closed to was unexplained by exactly the
 * opening amount (issue #153): the books had no entry for where that money
 * came from. `sourceType: 'opening_balance'` exists in the schema for
 * precisely this posting.
 */
export function addBankAccount(
  db: AppDatabase,
  params: {
    companyId: string;
    bankName: string;
    accountName: string;
    iban?: string;
    bic?: string;
    currency?: string;
    accountType?: typeof bankAccounts.$inferInsert['accountType'];
    openingBalanceMinor?: number;
    openingDate: IsoDate | string;
    accountId?: string;
    actor?: string;
  },
): string {
  const id = ids.bankAccount();
  const accountId = params.accountId ?? systemAccountId(db, params.companyId, 'bank_control');
  const openingBalanceMinor = params.openingBalanceMinor ?? 0;
  const openingDate = asIsoDate(String(params.openingDate));

  if (openingBalanceMinor !== 0) {
    const company = db.select({ baseCurrency: companies.baseCurrency }).from(companies)
      .where(eq(companies.id, params.companyId)).get();
    if (!company) throw new Error(`Company ${params.companyId} not found.`);

    const accountCurrency = (params.currency ?? 'EUR').toUpperCase();
    if (accountCurrency !== company.baseCurrency.toUpperCase()) {
      throw new Error(
        `This account is in ${accountCurrency} but the company's base currency is `
          + `${company.baseCurrency}. Posting a foreign-currency opening balance needs a `
          + 'deliberate exchange rate, which this function does not yet take — post it as a '
          + 'manual adjustment instead.',
      );
    }

    const retainedEarnings = systemAccountId(db, params.companyId, 'retained_earnings');
    const magnitude = Math.abs(openingBalanceMinor);
    const positive = openingBalanceMinor > 0;

    // Posted before the bank_accounts row exists — same order createInvoice
    // uses (journal first, then the row referencing it): a failed posting
    // (e.g. no financial year covers openingDate yet) must not leave a bank
    // account whose stated opening balance was never journaled.
    postJournalEntry(db, {
      companyId: params.companyId,
      entryDate: openingDate,
      narrative: `Opening balance: ${params.bankName} ${params.accountName}`,
      sourceType: 'opening_balance',
      sourceId: id,
      baseCurrency: company.baseCurrency,
      createdBy: params.actor ?? 'user',
      createdVia: 'user',
      lines: positive
        ? [
          { accountId, debitMinor: magnitude, memo: 'Opening balance' },
          { accountId: retainedEarnings, creditMinor: magnitude, memo: 'Opening balance' },
        ]
        : [
          { accountId, creditMinor: magnitude, memo: 'Opening balance (overdrawn)' },
          { accountId: retainedEarnings, debitMinor: magnitude, memo: 'Opening balance (overdrawn)' },
        ],
    });
  }

  db.insert(bankAccounts).values({
    id,
    companyId: params.companyId,
    bankName: params.bankName,
    accountName: params.accountName,
    iban: params.iban ?? null,
    bic: params.bic ?? null,
    currency: (params.currency ?? 'EUR').toUpperCase(),
    accountType: params.accountType ?? 'current',
    openingBalanceMinor,
    openingDate,
    accountId,
  }).run();
  return id;
}

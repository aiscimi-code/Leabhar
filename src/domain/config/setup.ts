import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companies, accounts, taxRates, vatTreatments, accountingPeriods, vatPeriods,
  bankAccounts, loans, auditEvents, glossaryTerms, companyTradingNames, users, companyMembers,
  expenseRates,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { type IsoDate, asIsoDate, nowIso, today } from '../dates';
import {
  DEFAULT_ACCOUNTS, FARM_ACCOUNTS, FARM_ACCOUNT_OVERRIDES, farmOverrideFor, type SystemAccountKey, type ChartKind,
} from './chartOfAccounts';
import { DEFAULT_TAX_RATES, DEFAULT_VAT_TREATMENTS } from './vatTreatments';
import { DEFAULT_EXPENSE_RATES } from '../expenses/rates';
import { generateVatPeriods, generateFinancialYear, type VatFrequency } from './periods';
import { GLOSSARY_TERMS } from '../help/glossary';
import { postJournalEntry, atomically } from '../accounting/journal';
import { createAccount } from './mutations';
import { seedDefaultRetentionPolicies } from '../documents/retention';

export interface CreateCompanyInput {
  legalName: string;
  tradingName?: string;
  croNumber?: string;
  companyType?: string;
  /** Company (default), sole trader or partnership (issue #212). */
  entityType?: 'company' | 'sole_trader' | 'partnership';
  /** When the trade began (sole traders and partnerships: the income tax basis rules need it). */
  tradeCommencedOn?: string;
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
  /**
   * Which variant of the default chart to install (issue #360): the SME chart
   * (default) or the farm chart — the base chart with the trade-specific
   * slots renamed for a farm and the farm's own accounts added.
   */
  chartKind?: ChartKind;
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
const DEFAULT_LEGAL_FORM = {
  company: 'Private company limited by shares (LTD)',
  sole_trader: 'Sole trader',
  partnership: 'Partnership',
} as const;

/**
 * The chart differs by entity type only in what the owners' side of the
 * balance sheet is called and in the company-only accounts (issue #212). A
 * sole trader's or partner's income tax is theirs, not the business's, and
 * what they take out is drawings, not salary or dividends.
 */
function chartSeedFor(
  entityType: 'company' | 'sole_trader' | 'partnership', seed: (typeof DEFAULT_ACCOUNTS)[number],
): (typeof DEFAULT_ACCOUNTS)[number] | null {
  if (entityType === 'company') return seed;
  const partnership = entityType === 'partnership';
  switch (seed.code) {
    case '2200': // Corporation tax payable
    case '6160': // Directors remuneration
      return null;
    case '2500':
      return { ...seed, name: partnership ? 'Partners’ current account' : 'Owner’s current account',
        description: 'Money the business owes its owner, or the owner owes it: typically business costs paid '
          + 'personally, or cash introduced.' };
    case '3000':
      return { ...seed, name: partnership ? 'Partners’ capital' : 'Capital account',
        description: partnership ? 'Each partner has a capital and a current account of their own under this heading.' : undefined };
    case '3100':
      return { ...seed, name: 'Accumulated profits' };
    case '3200':
      return { ...seed, name: partnership ? 'Partners’ drawings' : 'Drawings' };
    default:
      return seed;
  }
}

/**
 * The full seed list a company is created with: the base chart, adjusted for
 * the entity type (issue #212), then for the sector (issue #360). A farm is
 * usually also a sole trader, and the two adjustments compose.
 */
function chartSeeds(
  entityType: 'company' | 'sole_trader' | 'partnership',
  chartKind: ChartKind,
  vatRegistered: boolean,
): (typeof DEFAULT_ACCOUNTS)[number][] {
  const seeds: (typeof DEFAULT_ACCOUNTS)[number][] = [];
  for (const base of DEFAULT_ACCOUNTS) {
    const seed = chartSeedFor(entityType, base);
    if (!seed) continue;
    const override = chartKind === 'farm' ? farmOverrideFor(seed.code, vatRegistered) : undefined;
    seeds.push(override ? { ...seed, ...override } : seed);
  }
  if (chartKind === 'farm') seeds.push(...FARM_ACCOUNTS);
  return seeds;
}

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
      companyType: input.companyType ?? DEFAULT_LEGAL_FORM[input.entityType ?? 'company'],
      entityType: input.entityType ?? 'company',
      tradeCommencedOn: input.tradeCommencedOn ?? null,
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

    // The trading name given at creation is the first row of its history
    // (issue #297), dated from the earliest date that is known for the
    // business, so the names it has traded under are complete from day one.
    if (input.tradingName) {
      tx.insert(companyTradingNames).values({
        id: ids.tradingName(),
        companyId,
        name: input.tradingName,
        effectiveFrom: input.dateIncorporated ?? input.tradeCommencedOn ?? timestamp.slice(0, 10),
        recordedBy: 'setup',
      }).run();
    }

    // ---- Chart of accounts ----
    const accountsByKey: Record<string, string> = {};
    const accountsByCode: Record<string, string> = {};
    /** vatApplicable as seeded (after entity/sector adjustment), for wiring default treatments below. */
    const vatApplicableByAccount = new Map<string, boolean>();
    for (const [index, seed] of chartSeeds(
      input.entityType ?? 'company', input.chartKind ?? 'sm',
      input.vatRegistrationStatus === 'registered',
    ).entries()) {
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
      vatApplicableByAccount.set(id, seed.vatApplicable ?? true);
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
    for (const accountId of Object.values(accountsByCode)) {
      const treatment = vatApplicableByAccount.get(accountId) === false ? outOfScope : standardTreatment;
      if (treatment) {
        tx.update(accounts).set({ defaultVatTreatmentId: treatment })
          .where(eq(accounts.id, accountId)).run();
      }
    }

    // ---- Expense rates (issue #306) ----
    // The civil service mileage and subsistence allowances, effective-dated so
    // a later revision supersedes rather than overwrites (invariant #6).
    for (const seed of DEFAULT_EXPENSE_RATES) {
      tx.insert(expenseRates).values({
        id: ids.expenseRate(),
        companyId,
        category: seed.category,
        code: seed.code,
        name: seed.name,
        unit: seed.unit,
        amountMinor: seed.amountMinor,
        perUnits: seed.perUnits,
        effectiveFrom: seed.effectiveFrom,
        sourceNote: seed.sourceNote,
        sourceUrl: seed.sourceUrl,
      }).run();
    }

    // ---- Retention defaults (issue #432) ----
    // Seeded like the chart: effective-dated from the earliest date the book
    // knows, superseded rather than overwritten when the person changes them.
    seedDefaultRetentionPolicies(tx as unknown as AppDatabase, companyId, {
      effectiveFrom: asIsoDate(input.tradeCommencedOn ?? input.dateIncorporated ?? '1900-01-01'),
    });

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
        chartKind: input.chartKind ?? 'sm',
        accounts: vatApplicableByAccount.size,
        taxRates: DEFAULT_TAX_RATES.length,
        vatTreatments: DEFAULT_VAT_TREATMENTS.length,
      }),
      source: 'system',
      actor: 'setup',
      reason: 'Company created with default configuration',
    }).run();

    // Business membership (issue #298): a new company in the book is open to
    // every active user of the book. Later users are added per company by
    // inviteUser, which is also the only path that grants narrower roles.
    for (const user of tx.select({ id: users.id }).from(users).where(eq(users.active, true)).all()) {
      tx.insert(companyMembers).values({
        id: ids.member(), companyId, userId: user.id,
      }).run();
    }

    return { companyId, accountsByKey, accountsByCode, ratesByCode, treatmentsByCode };
  });
}

/**
 * Add any of the default chart accounts an existing company does not already
 * have, by code. New companies get the full chart at creation (`createCompany`);
 * this is for a company created before a code was added to `DEFAULT_ACCOUNTS`
 * (issue #159) — never touches an account that already exists, by code or by
 * `systemKey`, so it cannot clash with one the user has since renamed or
 * recoded.
 */
export function ensureDefaultAccounts(
  db: AppDatabase, companyId: string, actor?: string,
): { added: string[] } {
  const existingCodes = new Set(
    db.select({ code: accounts.code }).from(accounts)
      .where(eq(accounts.companyId, companyId)).all().map((r) => r.code),
  );
  const existingKeys = new Set(
    db.select({ key: accounts.systemKey }).from(accounts)
      .where(eq(accounts.companyId, companyId)).all()
      .map((r) => r.key).filter((k): k is string => k !== null),
  );

  const missing = DEFAULT_ACCOUNTS.filter((seed) =>
    !existingCodes.has(seed.code) && (!seed.systemKey || !existingKeys.has(seed.systemKey)));
  if (missing.length === 0) return { added: [] };

  const timestamp = nowIso();
  const added: string[] = [];

  db.transaction((tx) => {
    const startOrder = tx.select({ code: accounts.code }).from(accounts)
      .where(eq(accounts.companyId, companyId)).all().length;
    for (const [offset, seed] of missing.entries()) {
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
        reportOrder: startOrder + offset,
        description: seed.description ?? null,
        effectiveFrom: '1900-01-01',
      }).run();
      added.push(seed.code);
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId,
      occurredAt: timestamp,
      entityType: 'account',
      entityId: companyId,
      action: 'created',
      newValue: JSON.stringify({ addedCodes: added }),
      source: 'system',
      actor: actor ?? 'system',
      reason: 'Added default chart accounts introduced since this company was created',
    }).run();
  });

  return { added };
}

/**
 * Turn an existing book's chart into the farm chart (issue #360) — for a
 * company created before `--chart farm` existed, or before this was worth
 * deciding at creation.
 *
 * Two rules keep it safe:
 *
 *  - an account is only renamed when its name is still the one the default
 *    chart seeded. One the user has already renamed is theirs and is left
 *    alone, reported in `skipped` — the same promise `ensureDefaultAccounts`
 *    makes about never touching what the user made their own.
 *  - renames that turn VAT off (`vatApplicable: false`) rewire the account's
 *    default VAT treatment to out-of-scope, so a flat-rate farmer's sales
 *    account stops preselecting a standard-rate treatment it must never use.
 */
export function installFarmChart(
  db: AppDatabase, companyId: string, actor?: string,
): { added: string[]; renamed: string[]; skipped: string[] } {
  const byCode = new Map(db.select().from(accounts)
    .where(eq(accounts.companyId, companyId)).all().map((a) => [a.code, a]));

  const standardTreatment = db.select({ id: vatTreatments.id }).from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, 'IE_STD'))).get()?.id;
  const outOfScopeTreatment = db.select({ id: vatTreatments.id }).from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, 'OUT_OF_SCOPE'))).get()?.id;
  const vatRegistered = db.select({ status: companies.vatRegistrationStatus }).from(companies)
    .where(eq(companies.id, companyId)).get()?.status === 'registered';

  const added: string[] = [];
  const renamed: string[] = [];
  const skipped: string[] = [];

  db.transaction((tx) => {
    const startOrder = byCode.size;
    for (const [offset, seed] of FARM_ACCOUNTS.entries()) {
      if (byCode.has(seed.code)) continue;
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
        reportOrder: startOrder + offset,
        description: seed.description ?? null,
        effectiveFrom: '1900-01-01',
        defaultVatTreatmentId: seed.vatApplicable === false ? outOfScopeTreatment ?? null : standardTreatment ?? null,
      }).run();
      added.push(seed.code);
    }

    const timestamp = nowIso();
    for (const code of Object.keys(FARM_ACCOUNT_OVERRIDES)) {
      const override = farmOverrideFor(code, vatRegistered)!;
      const existing = byCode.get(code);
      const baseSeed = DEFAULT_ACCOUNTS.find((s) => s.code === code);
      if (!existing || !baseSeed) continue;
      // Already the farm name: nothing to do. Still the seeded name: apply the
      // farm rename. Anything else is the user's own name — never touched.
      if (existing.name === override.name) continue;
      if (existing.name !== baseSeed.name) {
        skipped.push(code);
        continue;
      }
      tx.update(accounts).set({
        name: override.name,
        description: override.description ?? existing.description,
        vatApplicable: override.vatApplicable ?? existing.vatApplicable,
        // Only a rename that turns VAT off rewires the default treatment; any
        // other keeps the treatment the account already has.
        defaultVatTreatmentId: override.vatApplicable === false
          ? outOfScopeTreatment ?? existing.defaultVatTreatmentId
          : existing.defaultVatTreatmentId,
        updatedAt: timestamp,
      }).where(eq(accounts.id, existing.id)).run();
      renamed.push(code);

      tx.insert(auditEvents).values({
        id: ids.audit(),
        companyId,
        occurredAt: timestamp,
        entityType: 'account',
        entityId: existing.id,
        action: 'updated', field: 'name',
        previousValue: existing.name,
        newValue: override.name,
        source: 'user', actor: actor ?? 'user',
        reason: 'Farm chart installed',
      }).run();
    }

    if (added.length > 0 || renamed.length > 0) {
      tx.insert(auditEvents).values({
        id: ids.audit(),
        companyId,
        occurredAt: timestamp,
        entityType: 'company',
        entityId: companyId,
        action: 'settings_changed', field: 'chart',
        newValue: JSON.stringify({ farmChartInstalled: true, added, renamed, skipped }),
        source: 'user', actor: actor ?? 'user',
        reason: 'Farm chart installed (issue #360)',
      }).run();
    }
  });

  return { added, renamed, skipped };
}
export function ensureDefaultVatTreatments(
  db: AppDatabase, companyId: string, actor?: string,
): { addedRates: string[]; addedTreatments: string[] } {
  const rateRows = db.select({ id: taxRates.id, code: taxRates.code }).from(taxRates)
    .where(eq(taxRates.companyId, companyId)).all();
  const rateIdByCode = new Map(rateRows.map((r) => [r.code, r.id]));
  const existingTreatments = new Set(db.select({ code: vatTreatments.code }).from(vatTreatments)
    .where(eq(vatTreatments.companyId, companyId)).all().map((r) => r.code));
  const missingTreatments = DEFAULT_VAT_TREATMENTS.filter((t) => !existingTreatments.has(t.code));
  const missingRates = DEFAULT_TAX_RATES.filter((r) => !rateIdByCode.has(r.code)
    && missingTreatments.some((t) => t.defaultRateCode === r.code));
  if (missingTreatments.length === 0) return { addedRates: [], addedTreatments: [] };

  db.transaction((tx) => {
    for (const seed of missingRates) {
      const id = ids.taxRate();
      tx.insert(taxRates).values({
        id, companyId, code: seed.code, name: seed.name, rateBasisPoints: seed.rateBasisPoints,
        taxType: seed.taxType, jurisdiction: seed.jurisdiction,
        reportingClassification: seed.reportingClassification ?? null, isDefault: false,
        notes: seed.notes ?? null, effectiveFrom: seed.effectiveFrom,
        sourceNote: seed.sourceNote ?? null, sourceDate: today(),
      }).run();
      rateIdByCode.set(seed.code, id);
    }
    for (const seed of missingTreatments) {
      tx.insert(vatTreatments).values({
        id: ids.vatTreatment(), companyId, code: seed.code, name: seed.name, description: seed.description,
        jurisdiction: seed.jurisdiction, direction: seed.direction, supplyKind: seed.supplyKind,
        appliesRate: seed.appliesRate, defaultTaxRateId: rateIdByCode.get(seed.defaultRateCode) ?? null,
        isReverseCharge: seed.isReverseCharge ?? false, isRecoverable: seed.isRecoverable ?? true,
        recoverableBasisPoints: seed.recoverableBasisPoints ?? 10_000,
        salesVatBox: seed.salesVatBox ?? null, purchasesVatBox: seed.purchasesVatBox ?? null,
        netSalesBox: seed.netSalesBox ?? null, netPurchasesBox: seed.netPurchasesBox ?? null,
        requiresCounterpartyVatNumber: seed.requiresCounterpartyVatNumber ?? false,
        isDefault: false, isSystem: seed.isSystem ?? false, effectiveFrom: '1900-01-01',
        sourceNote: seed.sourceNote ?? null, sourceDate: today(),
      }).run();
    }
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId, occurredAt: nowIso(), entityType: 'vat_treatment', entityId: companyId,
      action: 'created',
      newValue: JSON.stringify({ addedRates: missingRates.map((r) => r.code), addedTreatments: missingTreatments.map((t) => t.code) }),
      source: 'system', actor: actor ?? 'system',
      reason: 'Added default VAT treatments introduced since this company was created',
    }).run();
  });
  return { addedRates: missingRates.map((r) => r.code), addedTreatments: missingTreatments.map((t) => t.code) };
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
/**
 * The ledger account a new bank account posts to (issues #376, #377).
 *
 * Each bank account gets a ledger account of its own, so its balance is its
 * own line on the balance sheet and its reconciliation compares its statement
 * with its own movements only. The seeded account for the type is used while
 * no bank account has claimed it (1000 for the first bank account, 1010 for
 * the first cash account, 1020 for the first deposit account); after that a
 * new account is created in the same range. Money owed is a liability: a
 * credit card gets a current liability, a loan the loan's own liability
 * account from the register, or a new non-current one.
 */
function bankLedgerAccountFor(
  db: AppDatabase,
  params: {
    companyId: string; bankName: string; accountName: string;
    accountType?: typeof bankAccounts.$inferInsert['accountType']; loanId?: string; actor?: string;
  },
): string {
  const type = params.accountType ?? 'current';
  const label = `${params.bankName} ${params.accountName}`.trim();

  if (type === 'loan' && params.loanId) {
    const loan = db.select().from(loans)
      .where(and(eq(loans.id, params.loanId), eq(loans.companyId, params.companyId))).get();
    if (!loan) throw new Error(`Loan ${params.loanId} not found for company ${params.companyId}.`);
    return loan.accountId;
  }

  const companyAccounts = db.select().from(accounts)
    .where(eq(accounts.companyId, params.companyId)).all();
  const usedCodes = new Set(companyAccounts.map((a) => a.code));
  const claimed = new Set(
    db.select({ accountId: bankAccounts.accountId }).from(bankAccounts)
      .where(eq(bankAccounts.companyId, params.companyId)).all()
      .map((b) => b.accountId).filter((a): a is string => a !== null),
  );

  const range: Record<string, {
    seeded: string; first: number; last: number;
    type: 'asset' | 'liability'; subtype: string; reportSection: string; name: string;
    description: string;
  }> = {
    bank: {
      seeded: '1000', first: 1001, last: 1009, type: 'asset', subtype: 'current_asset',
      reportSection: 'current_assets', name: `Bank — ${label}`,
      description: `The balance of the ${label} account, as the books see it.`,
    },
    cash: {
      seeded: '1010', first: 1011, last: 1019, type: 'asset', subtype: 'current_asset',
      reportSection: 'current_assets', name: `Cash — ${label}`,
      description: `Cash held in ${label}. It has no bank statement: each movement is recorded by hand.`,
    },
    deposit: {
      seeded: '1020', first: 1021, last: 1029, type: 'asset', subtype: 'current_asset',
      reportSection: 'current_assets', name: `Deposit — ${label}`,
      description: `The balance of the ${label} deposit or savings account.`,
    },
    credit_card: {
      seeded: '', first: 2150, last: 2159, type: 'liability', subtype: 'current_liability',
      reportSection: 'current_liabilities', name: `Credit card — ${label}`,
      description: `What is owed on the ${label} card. Card spending increases it; a payment to `
        + 'the card reduces it.',
    },
    loan: {
      seeded: '', first: 2211, last: 2219, type: 'liability', subtype: 'non_current_liability',
      reportSection: 'long_term_liabilities', name: `Loan — ${label}`,
      description: `The outstanding balance of the ${label} loan. Repayments are a capital/interest `
        + 'split: the capital part reduces this account and the interest part is a cost (6710).',
    },
  };
  const kind = type === 'cash' ? 'cash'
    : type === 'deposit' || type === 'savings' ? 'deposit'
      : type === 'credit_card' ? 'credit_card'
        : type === 'loan' ? 'loan'
          : 'bank';
  const spec = range[kind]!;

  const seeded = spec.seeded ? companyAccounts.find((a) => a.code === spec.seeded) : undefined;
  if (seeded && !claimed.has(seeded.id)) return seeded.id;

  for (let n = spec.first; n <= spec.last; n += 1) {
    const code = String(n);
    if (usedCodes.has(code)) continue;
    return createAccount(db, {
      companyId: params.companyId,
      code,
      name: spec.name,
      type: spec.type,
      subtype: spec.subtype,
      reportSection: spec.reportSection,
      vatApplicable: false,
      description: spec.description,
      actor: params.actor ?? 'user',
    });
  }
  throw new Error(
    `There is no free account code between ${spec.first} and ${spec.last} for another `
      + `${kind.replace('_', ' ')} account. Create a ledger account for it and pass its id.`,
  );
}

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
    /** Post to this ledger account instead of the one the account type implies. */
    accountId?: string;
    /** For a `loan` account: the loan in the register whose liability it posts to (#358). */
    loanId?: string;
    actor?: string;
  },
): string {
  return atomically(db, () => addBankAccountSteps(db, params));
}

function addBankAccountSteps(
  db: AppDatabase,
  params: Parameters<typeof addBankAccount>[1],
): string {
  const id = ids.bankAccount();
  const accountId = params.accountId ?? bankLedgerAccountFor(db, params);
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

/**
 * Register a loan and link it to the liability account that carries its
 * balance (issue #358) — the loan-side mirror of `addBankAccount`.
 *
 * With no `accountId` a dedicated account is created (code 2211, 2212, ...
 * — the first free code after 2210, which the default chart seeds as the
 * generic Bank loans account), so each loan's balance is visible on its own
 * line instead of folding every borrowing into one.
 *
 * A nonzero `openingPrincipalMinor` is also journaled — Dr the bank account
 * the drawdown landed in, Cr this loan's account — for exactly the reason
 * `addBankAccount` journals an opening balance (issue #153): a loan that
 * existed before the first imported statement otherwise leaves the books
 * with no entry for where the money came from. Pass 0 when the drawdown
 * appears on an imported statement line: it is then posted by classifying
 * (or split-journaling) that line, and journaling it here as well would
 * count the drawdown twice.
 */
export function addLoan(
  db: AppDatabase,
  params: {
    companyId: string;
    lenderName: string;
    loanName?: string;
    kind?: typeof loans.$inferInsert['kind'];
    currency?: string;
    /** An existing liability account (e.g. 2210); omitted = create one. */
    accountId?: string;
    /** Where the drawdown landed; omitted = the bank control account. */
    bankAccountId?: string;
    openingPrincipalMinor?: number;
    openingDate: IsoDate | string;
    maturityDate?: IsoDate | string;
    notes?: string;
    actor?: string;
  },
): string {
  const id = ids.loan();
  const currency = (params.currency ?? 'EUR').toUpperCase();
  const openingPrincipalMinor = params.openingPrincipalMinor ?? 0;
  const openingDate = asIsoDate(String(params.openingDate));
  const loanName = params.loanName ?? params.lenderName;

  let accountId = params.accountId;
  if (accountId) {
    const existing = db.select().from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, params.companyId))).get();
    if (!existing) {
      throw new Error(`Account ${accountId} not found for company ${params.companyId}.`);
    }
    if (existing.type !== 'liability') {
      throw new Error(
        `Account ${existing.code} "${existing.name}" is a ${existing.type}, not a liability. `
          + 'A loan\'s outstanding balance is money owed, so it is posted to a liability '
          + 'account — interest, which is a cost, goes to an expense account instead.',
      );
    }
  } else {
    // The first free code after the seeded 2210 Bank loans.
    const usedCodes = new Set(
      db.select({ code: accounts.code }).from(accounts)
        .where(eq(accounts.companyId, params.companyId)).all().map((r) => r.code),
    );
    let code = '2210';
    for (let n = 1; usedCodes.has(code); n += 1) code = `221${n}`;
    accountId = createAccount(db, {
      companyId: params.companyId,
      code,
      name: `Loan — ${params.lenderName}`,
      type: 'liability',
      subtype: 'non_current_liability',
      reportSection: 'long_term_liabilities',
      vatApplicable: false,
      description: `The outstanding balance of the ${loanName.toLowerCase()} from `
        + `${params.lenderName}. Repayments are a capital/interest split: the capital part `
        + 'reduces this account and the interest part is a cost (6710).',
      actor: params.actor ?? 'user',
    });
  }

  if (openingPrincipalMinor !== 0) {
    const company = db.select({ baseCurrency: companies.baseCurrency }).from(companies)
      .where(eq(companies.id, params.companyId)).get();
    if (!company) throw new Error(`Company ${params.companyId} not found.`);

    if (currency !== company.baseCurrency.toUpperCase()) {
      throw new Error(
        `This loan is in ${currency} but the company's base currency is `
          + `${company.baseCurrency}. Posting a foreign-currency drawdown needs a `
          + 'deliberate exchange rate, which this function does not yet take — post it as a '
          + 'manual adjustment instead.',
      );
    }

    const bankLedgerAccount = params.bankAccountId
      ? db.select({ accountId: bankAccounts.accountId }).from(bankAccounts)
        .where(and(eq(bankAccounts.id, params.bankAccountId), eq(bankAccounts.companyId, params.companyId)))
        .get()?.accountId
      : systemAccountId(db, params.companyId, 'bank_control');

    // Posted before the loans row exists, in the same order `addBankAccount`
    // uses: a failed posting (e.g. no open accounting period covers the
    // drawdown date) must not leave a registered loan whose stated opening
    // principal was never journaled.
    postJournalEntry(db, {
      companyId: params.companyId,
      entryDate: openingDate,
      narrative: `Loan drawdown: ${params.lenderName} ${loanName}`,
      sourceType: 'opening_balance',
      sourceId: id,
      baseCurrency: company.baseCurrency,
      createdBy: params.actor ?? 'user',
      createdVia: 'user',
      lines: [
        { accountId: bankLedgerAccount!, debitMinor: openingPrincipalMinor, memo: 'Loan drawdown' },
        { accountId, creditMinor: openingPrincipalMinor, memo: 'Loan drawdown' },
      ],
    });
  }

  db.insert(loans).values({
    id,
    companyId: params.companyId,
    lenderName: params.lenderName,
    loanName,
    kind: params.kind ?? 'term_loan',
    currency,
    accountId,
    principalMinor: openingPrincipalMinor,
    drawdownDate: openingDate,
    maturityDate: params.maturityDate ? asIsoDate(String(params.maturityDate)) : null,
    notes: params.notes ?? null,
  }).run();

  db.insert(auditEvents).values({
    id: ids.audit(),
    companyId: params.companyId,
    occurredAt: nowIso(),
    entityType: 'loan',
    entityId: id,
    action: 'created',
    newValue: JSON.stringify({
      lenderName: params.lenderName, loanName, accountId,
      openingPrincipalMinor, drawdownDate: openingDate,
    }),
    source: 'user',
    actor: params.actor ?? 'user',
    reason: params.notes ?? null,
  }).run();

  return id;
}

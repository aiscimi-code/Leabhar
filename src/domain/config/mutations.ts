import { and, eq, sql, desc, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companies, accounts, taxRates, vatTreatments, vatPeriods, accountingPeriods,
  bankAccounts, auditEvents, vatEntries, journalLines, invoiceLines,
  bankTransactions, suppliers, customers, taxDeadlines,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, addDays, type IsoDate } from '../dates';
import { generateVatPeriods, generateFinancialYear, validatePeriodSequence,
  type VatFrequency } from './periods';
import { AccountingError } from '../accounting/errors';

export class ConfigurationError extends AccountingError {}

/**
 * Editing configuration (README §6, §46).
 *
 * Two rules govern everything here, and both exist to stop a change today
 * rewriting what happened last year:
 *
 *  - Rates and treatments are SUPERSEDED, never overwritten. Changing a rate
 *    closes the old row's effective window and opens a new one, so a
 *    transaction resolves the rate that applied on its own date.
 *  - Anything referenced by a historical record can be DEACTIVATED but never
 *    deleted. Deleting an account that a posted journal line points at would
 *    leave the books referring to something that no longer exists.
 *
 * Every change is audited with its before and after values.
 */

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

export type CompanyUpdate = Partial<{
  legalName: string;
  tradingName: string | null;
  croNumber: string | null;
  companyType: string | null;
  dateIncorporated: string | null;
  registeredOffice: string | null;
  principalBusinessAddress: string | null;
  recordsAddress: string | null;
  taxReferenceNumber: string | null;
  vatNumber: string | null;
  vatRegistrationDate: string | null;
  vatRegistrationStatus: 'not_registered' | 'registered' | 'deregistered' | 'pending';
  eoriNumber: string | null;
  corporationTaxRegistered: boolean;
  vatAccountingBasis: 'invoice' | 'cash_receipts';
  vatPeriodFrequency: VatFrequency | 'custom';
  financialYearEndDay: number;
  financialYearEndMonth: number;
  baseCurrency: string;
  notes: string | null;
}>;

export function updateCompany(
  db: AppDatabase,
  params: { companyId: string; changes: CompanyUpdate; actor?: string; reason?: string },
): { changed: string[]; warnings: string[] } {
  const company = db.select().from(companies)
    .where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ConfigurationError(`Company ${params.companyId} not found.`);

  const warnings: string[] = [];
  const changed: string[] = [];
  const timestamp = nowIso();

  // Changing the VAT basis after transactions exist does NOT restate them.
  // Their VAT entries were created with tax points resolved under the old
  // basis, and silently moving them between periods would alter returns that
  // may already have been filed.
  if (params.changes.vatAccountingBasis
      && params.changes.vatAccountingBasis !== company.vatAccountingBasis) {
    const existing = db.select({ id: vatEntries.id }).from(vatEntries)
      .where(eq(vatEntries.companyId, params.companyId)).limit(1).get();
    if (existing) {
      warnings.push(
        'You have changed the VAT accounting basis, and VAT entries already exist. Those '
          + 'entries keep the tax points they were created with — nothing is restated, '
          + 'because moving them between periods could alter a return you have already filed. '
          + 'The new basis applies to transactions from here on. Confirm the change of basis '
          + 'with Revenue and your accountant.',
      );
    }
  }

  if (params.changes.baseCurrency && params.changes.baseCurrency !== company.baseCurrency) {
    const existing = db.select({ id: journalLines.id }).from(journalLines)
      .where(eq(journalLines.companyId, params.companyId)).limit(1).get();
    if (existing) {
      throw new ConfigurationError(
        'The base currency cannot be changed once entries have been posted. Every amount in '
          + 'the books is recorded in the current base currency, and changing it would make '
          + 'every historical figure mean something different.',
      );
    }
  }

  if ((params.changes.financialYearEndDay !== undefined
       && params.changes.financialYearEndDay !== company.financialYearEndDay)
      || (params.changes.financialYearEndMonth !== undefined
          && params.changes.financialYearEndMonth !== company.financialYearEndMonth)) {
    const existing = db.select({ id: accountingPeriods.id }).from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.companyId, params.companyId),
        eq(accountingPeriods.kind, 'financial_year'),
      )).limit(1).get();
    if (existing) {
      warnings.push(
        'Changing the year end does not move the financial years you have already created. '
          + 'Create the new periods yourself so you can see exactly which dates each one '
          + 'covers — a shortened or extended period is a decision, not a side effect.',
      );
    }
  }

  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.changes)) {
    if (value === undefined) continue;
    const current = (company as unknown as Record<string, unknown>)[key];
    if (current === value) continue;
    update[key] = value;
    changed.push(key);
  }

  if (changed.length === 0) return { changed, warnings };

  db.transaction((tx) => {
    tx.update(companies).set({ ...update, updatedAt: timestamp })
      .where(eq(companies.id, params.companyId)).run();

    for (const key of changed) {
      tx.insert(auditEvents).values({
        id: ids.audit(),
        companyId: params.companyId,
        occurredAt: timestamp,
        entityType: 'company',
        entityId: params.companyId,
        action: 'settings_changed',
        field: key,
        previousValue: String((company as unknown as Record<string, unknown>)[key] ?? ''),
        newValue: String(update[key] ?? ''),
        source: 'user',
        actor: params.actor ?? 'user',
        reason: params.reason ?? null,
      }).run();
    }
  });

  return { changed, warnings };
}

// ---------------------------------------------------------------------------
// Tax rates
// ---------------------------------------------------------------------------

/**
 * Change a tax rate.
 *
 * Creates a new effective-dated row and closes the old one the day before,
 * rather than editing in place. A transaction dated before the change keeps
 * resolving the old rate, which is README §6's requirement that changing a rate
 * today must not alter historical transactions.
 */
export function supersedeTaxRate(
  db: AppDatabase,
  params: {
    companyId: string;
    taxRateId: string;
    newRateBasisPoints: number;
    effectiveFrom: IsoDate;
    sourceNote?: string;
    actor?: string;
  },
): { newRateId: string; closedRateId: string } {
  const existing = db.select().from(taxRates)
    .where(and(eq(taxRates.id, params.taxRateId), eq(taxRates.companyId, params.companyId)))
    .get();
  if (!existing) throw new ConfigurationError(`Tax rate ${params.taxRateId} not found.`);

  if (params.effectiveFrom <= existing.effectiveFrom) {
    throw new ConfigurationError(
      `A new rate must start after the one it replaces, which runs from `
        + `${existing.effectiveFrom}. Add a separate historical rate if you need to record an `
        + 'earlier period.',
    );
  }

  const newRateId = ids.taxRate();
  const timestamp = nowIso();

  db.transaction((tx) => {
    tx.update(taxRates)
      .set({ effectiveTo: addDays(params.effectiveFrom, -1), updatedAt: timestamp })
      .where(eq(taxRates.id, existing.id)).run();

    tx.insert(taxRates).values({
      id: newRateId,
      companyId: params.companyId,
      code: existing.code,
      name: existing.name,
      rateBasisPoints: params.newRateBasisPoints,
      taxType: existing.taxType,
      jurisdiction: existing.jurisdiction,
      reportingClassification: existing.reportingClassification,
      isDefault: existing.isDefault,
      notes: existing.notes,
      effectiveFrom: params.effectiveFrom,
      sourceNote: params.sourceNote ?? existing.sourceNote,
      sourceDate: timestamp.slice(0, 10),
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'tax_rate',
      entityId: newRateId,
      action: 'created',
      field: 'rateBasisPoints',
      previousValue: String(existing.rateBasisPoints),
      newValue: String(params.newRateBasisPoints),
      source: 'user',
      actor: params.actor ?? 'user',
      reason: `Supersedes ${existing.code} from ${params.effectiveFrom}; the previous rate `
        + `still applies to transactions up to ${addDays(params.effectiveFrom, -1)}`,
    }).run();
  });

  return { newRateId, closedRateId: existing.id };
}

export function createTaxRate(
  db: AppDatabase,
  params: {
    companyId: string; code: string; name: string; rateBasisPoints: number;
    taxType?: 'vat' | 'corporation_tax' | 'income_tax' | 'prsi' | 'usc' | 'other';
    jurisdiction?: string; effectiveFrom: IsoDate; notes?: string;
    sourceNote?: string; actor?: string;
  },
): string {
  if (params.rateBasisPoints < 0) {
    throw new ConfigurationError('A tax rate cannot be negative.');
  }

  const id = ids.taxRate();
  db.transaction((tx) => {
    tx.insert(taxRates).values({
      id,
      companyId: params.companyId,
      code: params.code,
      name: params.name,
      rateBasisPoints: params.rateBasisPoints,
      taxType: params.taxType ?? 'vat',
      jurisdiction: params.jurisdiction ?? 'IE',
      effectiveFrom: params.effectiveFrom,
      notes: params.notes ?? null,
      sourceNote: params.sourceNote ?? null,
      sourceDate: nowIso().slice(0, 10),
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'tax_rate', entityId: id, action: 'created',
      newValue: JSON.stringify({ code: params.code, rate: params.rateBasisPoints }),
      source: 'user', actor: params.actor ?? 'user',
    }).run();
  });
  return id;
}

/**
 * Deactivate a tax rate.
 *
 * Never deletes. README §6 is explicit: a rate referenced by historical
 * accounting records must never be deleted, and deactivating it stops it being
 * chosen for anything new while leaving history resolvable.
 */
export function deactivateTaxRate(
  db: AppDatabase,
  params: { companyId: string; taxRateId: string; actor?: string; reason?: string },
): { deactivated: true; referencedBy: number } {
  const rate = db.select().from(taxRates)
    .where(and(eq(taxRates.id, params.taxRateId), eq(taxRates.companyId, params.companyId)))
    .get();
  if (!rate) throw new ConfigurationError(`Tax rate ${params.taxRateId} not found.`);

  const referencedBy = db.select({ count: sql<number>`COUNT(*)` }).from(vatEntries)
    .where(eq(vatEntries.taxRateId, params.taxRateId)).get()?.count ?? 0;

  db.transaction((tx) => {
    tx.update(taxRates).set({ active: false, updatedAt: nowIso() })
      .where(eq(taxRates.id, params.taxRateId)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'tax_rate', entityId: params.taxRateId,
      action: 'updated', field: 'active',
      previousValue: 'true', newValue: 'false',
      source: 'user', actor: params.actor ?? 'user',
      reason: params.reason
        ?? `Deactivated. ${referencedBy} historical VAT entries still reference it and are `
          + 'unaffected.',
    }).run();
  });

  return { deactivated: true, referencedBy };
}

// ---------------------------------------------------------------------------
// VAT treatments
// ---------------------------------------------------------------------------

export type TreatmentUpdate = Partial<{
  name: string;
  description: string | null;
  defaultTaxRateId: string | null;
  isRecoverable: boolean;
  recoverableBasisPoints: number;
  salesVatBox: string | null;
  purchasesVatBox: string | null;
  netSalesBox: string | null;
  netPurchasesBox: string | null;
  requiresCounterpartyVatNumber: boolean;
  notes: string | null;
  sourceNote: string | null;
  active: boolean;
}>;

/**
 * Edit a VAT treatment.
 *
 * Cosmetic fields are edited in place. Changes that alter what a treatment
 * MEANS — its box mapping, its recoverability — are refused once VAT entries
 * exist that used it, because the entries snapshotted the old mapping and the
 * configuration would then disagree with the history it produced.
 */
export function updateVatTreatment(
  db: AppDatabase,
  params: {
    companyId: string; treatmentId: string; changes: TreatmentUpdate;
    actor?: string; reason?: string;
  },
): { changed: string[]; warnings: string[] } {
  const treatment = db.select().from(vatTreatments)
    .where(and(
      eq(vatTreatments.id, params.treatmentId),
      eq(vatTreatments.companyId, params.companyId),
    )).get();
  if (!treatment) throw new ConfigurationError(`VAT treatment ${params.treatmentId} not found.`);

  const usageCount = db.select({ count: sql<number>`COUNT(*)` }).from(vatEntries)
    .where(eq(vatEntries.vatTreatmentId, params.treatmentId)).get()?.count ?? 0;

  const behaviourFields = [
    'salesVatBox', 'purchasesVatBox', 'netSalesBox', 'netPurchasesBox',
    'isRecoverable', 'recoverableBasisPoints',
  ] as const;

  const behaviourChanges = behaviourFields.filter((field) =>
    params.changes[field] !== undefined
    && params.changes[field] !== (treatment as unknown as Record<string, unknown>)[field]);

  if (behaviourChanges.length > 0 && usageCount > 0) {
    throw new ConfigurationError(
      `"${treatment.name}" has been used on ${usageCount} VAT ${usageCount === 1 ? 'entry' : 'entries'}, `
        + `so its ${behaviourChanges.join(', ')} cannot be changed. Those entries recorded the `
        + 'mapping that applied when they were created, and editing it here would leave the '
        + 'configuration disagreeing with the history it produced. Create a new treatment '
        + 'instead and use it from now on.',
      { treatmentId: treatment.id, usageCount, behaviourChanges },
    );
  }

  const warnings: string[] = [];
  const changed: string[] = [];
  const update: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params.changes)) {
    if (value === undefined) continue;
    const current = (treatment as unknown as Record<string, unknown>)[key];
    if (current === value) continue;
    update[key] = value;
    changed.push(key);
  }

  if (params.changes.active === false && usageCount > 0) {
    warnings.push(
      `${usageCount} historical VAT ${usageCount === 1 ? 'entry uses' : 'entries use'} this `
        + 'treatment. They are unaffected — deactivating it only stops it being chosen '
        + 'for anything new.',
    );
  }

  if (changed.length === 0) return { changed, warnings };

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(vatTreatments).set({ ...update, updatedAt: timestamp })
      .where(eq(vatTreatments.id, params.treatmentId)).run();

    for (const key of changed) {
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'vat_treatment', entityId: params.treatmentId,
        action: 'updated', field: key,
        previousValue: String((treatment as unknown as Record<string, unknown>)[key] ?? ''),
        newValue: String(update[key] ?? ''),
        source: 'user', actor: params.actor ?? 'user', reason: params.reason ?? null,
      }).run();
    }
  });

  return { changed, warnings };
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

export function createAccount(
  db: AppDatabase,
  params: {
    companyId: string; code: string; name: string;
    type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
    subtype?: string; reportSection: string; description?: string;
    vatApplicable?: boolean; defaultVatTreatmentId?: string | null;
    actor?: string;
  },
): string {
  const clash = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, params.companyId), eq(accounts.code, params.code)))
    .get();
  if (clash) {
    throw new ConfigurationError(
      `Account code ${params.code} is already in use. Codes must be unique so a figure can `
        + 'always be traced to one account.',
    );
  }

  const id = ids.account();
  db.transaction((tx) => {
    tx.insert(accounts).values({
      id,
      companyId: params.companyId,
      code: params.code,
      name: params.name,
      type: params.type,
      subtype: params.subtype ?? null,
      reportSection: params.reportSection,
      description: params.description ?? null,
      vatApplicable: params.vatApplicable ?? true,
      defaultVatTreatmentId: params.defaultVatTreatmentId ?? null,
      isSystem: false,
      effectiveFrom: '1900-01-01',
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'account', entityId: id, action: 'created',
      newValue: JSON.stringify({ code: params.code, name: params.name, type: params.type }),
      source: 'user', actor: params.actor ?? 'user',
    }).run();
  });
  return id;
}

export function updateAccount(
  db: AppDatabase,
  params: {
    companyId: string; accountId: string;
    changes: Partial<{
      name: string; description: string | null; vatApplicable: boolean;
      defaultVatTreatmentId: string | null; reportSection: string; active: boolean;
    }>;
    actor?: string;
  },
): { changed: string[]; warnings: string[] } {
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId)))
    .get();
  if (!account) throw new ConfigurationError(`Account ${params.accountId} not found.`);

  const usageCount = db.select({ count: sql<number>`COUNT(*)` }).from(journalLines)
    .where(eq(journalLines.accountId, params.accountId)).get()?.count ?? 0;

  const warnings: string[] = [];

  if (params.changes.active === false) {
    if (account.isSystem) {
      throw new ConfigurationError(
        `"${account.name}" is a system account: the posting engine addresses it by name, so `
          + 'it cannot be deactivated. You can rename it and change its description.',
      );
    }
    if (usageCount > 0) {
      warnings.push(
        `${usageCount} journal ${usageCount === 1 ? 'line' : 'lines'} already post to this `
          + 'account. Its history and balance stay exactly as they are; deactivating only '
          + 'stops new postings.',
      );
    }
  }

  const changed: string[] = [];
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.changes)) {
    if (value === undefined) continue;
    const current = (account as unknown as Record<string, unknown>)[key];
    if (current === value) continue;
    update[key] = value;
    changed.push(key);
  }

  if (changed.length === 0) return { changed, warnings };

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(accounts).set({ ...update, updatedAt: timestamp })
      .where(eq(accounts.id, params.accountId)).run();

    for (const key of changed) {
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'account', entityId: params.accountId,
        action: 'updated', field: key,
        previousValue: String((account as unknown as Record<string, unknown>)[key] ?? ''),
        newValue: String(update[key] ?? ''),
        source: 'user', actor: params.actor ?? 'user',
      }).run();
    }
  });

  return { changed, warnings };
}

/** Accounts can never be deleted once used. This says so, rather than failing obscurely. */
export function deleteAccount(
  db: AppDatabase, params: { companyId: string; accountId: string; actor?: string },
): never {
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId)))
    .get();
  const usageCount = db.select({ count: sql<number>`COUNT(*)` }).from(journalLines)
    .where(eq(journalLines.accountId, params.accountId)).get()?.count ?? 0;

  throw new ConfigurationError(
    `Accounts are never deleted. "${account?.name ?? params.accountId}" is referenced by `
      + `${usageCount} journal ${usageCount === 1 ? 'line' : 'lines'}, and removing it would `
      + 'leave those entries pointing at nothing. Deactivate it instead: the history stays '
      + 'intact and nothing new can be posted to it.',
  );
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export function generateVatPeriodsForYear(
  db: AppDatabase,
  params: {
    companyId: string; year: number; frequency: VatFrequency;
    filingDeadlineDays?: number; actor?: string;
  },
): { created: number; skipped: number; issues: string[] } {
  const generated = generateVatPeriods(params.year, params.frequency, {
    filingDeadlineDays: params.filingDeadlineDays,
  });

  const existing = db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, params.companyId)).all();

  let created = 0;
  let skipped = 0;

  db.transaction((tx) => {
    for (const period of generated) {
      // An overlapping period already exists: leave it alone. Historical
      // periods must remain unchanged when future configuration is edited.
      const overlaps = existing.some((e) =>
        period.startDate <= e.endDate && period.endDate >= e.startDate);
      if (overlaps) { skipped += 1; continue; }

      const id = ids.vatPeriod();
      tx.insert(vatPeriods).values({
        id,
        companyId: params.companyId,
        name: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        filingDeadline: period.filingDeadline,
        frequency: period.frequency,
        status: 'open',
      }).run();

      tx.insert(taxDeadlines).values({
        id: ids.audit(),
        companyId: params.companyId,
        title: `VAT3 return — ${period.name}`,
        kind: 'vat_return',
        dueDate: period.filingDeadline,
        periodStart: period.startDate,
        periodEnd: period.endDate,
        vatPeriodId: id,
        status: 'upcoming',
        sourceNote: 'Generated from your VAT period configuration. Filing dates differ '
          + 'depending on how you file — confirm your own.',
      }).run();

      created += 1;
    }

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'vat_period', entityId: String(params.year),
      action: 'created',
      newValue: JSON.stringify({ year: params.year, frequency: params.frequency, created, skipped }),
      source: 'user', actor: params.actor ?? 'user',
    }).run();
  });

  const all = db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, params.companyId)).all();
  const issues = validatePeriodSequence(all).map((issue) => issue.message);

  return { created, skipped, issues };
}

export function generateFinancialYearPeriod(
  db: AppDatabase,
  params: {
    companyId: string; endYear: number;
    yearEndDay?: number; yearEndMonth?: number; actor?: string;
  },
): { created: boolean; name: string; startDate: string; endDate: string; issues: string[] } {
  const company = db.select().from(companies)
    .where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ConfigurationError(`Company ${params.companyId} not found.`);

  const { year, months } = generateFinancialYear(
    params.yearEndDay ?? company.financialYearEndDay,
    params.yearEndMonth ?? company.financialYearEndMonth,
    params.endYear,
  );

  const existing = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, params.companyId),
      eq(accountingPeriods.kind, 'financial_year'),
    )).all();

  const overlaps = existing.find((e) =>
    year.startDate <= e.endDate && year.endDate >= e.startDate);
  if (overlaps) {
    throw new ConfigurationError(
      `A financial year already covers those dates: "${overlaps.name}" runs from `
        + `${overlaps.startDate} to ${overlaps.endDate}. Periods must not overlap, or a `
        + 'transaction could belong to two sets of accounts at once.',
    );
  }

  db.transaction((tx) => {
    const fyId = ids.accountingPeriod();
    tx.insert(accountingPeriods).values({
      id: fyId, companyId: params.companyId, kind: 'financial_year',
      name: year.name, startDate: year.startDate, endDate: year.endDate, status: 'open',
    }).run();

    for (const month of months) {
      tx.insert(accountingPeriods).values({
        id: ids.accountingPeriod(), companyId: params.companyId, kind: 'month',
        name: month.name, startDate: month.startDate, endDate: month.endDate,
        parentId: fyId, status: 'open',
      }).run();
    }

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'accounting_period', entityId: fyId, action: 'created',
      newValue: JSON.stringify({ name: year.name, start: year.startDate, end: year.endDate }),
      source: 'user', actor: params.actor ?? 'user',
    }).run();
  });

  const all = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, params.companyId),
      eq(accountingPeriods.kind, 'financial_year'),
    )).all();

  return {
    created: true,
    name: year.name,
    startDate: year.startDate,
    endDate: year.endDate,
    issues: validatePeriodSequence(all).map((issue) => issue.message),
  };
}

export function updateVatPeriod(
  db: AppDatabase,
  params: {
    companyId: string; vatPeriodId: string;
    changes: Partial<{ name: string; startDate: string; endDate: string;
                       filingDeadline: string | null }>;
    actor?: string;
  },
): { changed: string[] } {
  const period = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.id, params.vatPeriodId),
      eq(vatPeriods.companyId, params.companyId),
    )).get();
  if (!period) throw new ConfigurationError(`VAT period ${params.vatPeriodId} not found.`);

  if (period.status === 'submitted' || period.status === 'locked') {
    throw new ConfigurationError(
      `"${period.name}" is ${period.status}, so its dates cannot be changed. Moving the dates `
        + 'of a filed period would change which transactions it contained after the fact.',
    );
  }

  // Changing dates can only ever be checked against the other periods.
  if (params.changes.startDate || params.changes.endDate) {
    const others = db.select().from(vatPeriods)
      .where(and(
        eq(vatPeriods.companyId, params.companyId),
        ne(vatPeriods.id, params.vatPeriodId),
      )).all();
    const start = params.changes.startDate ?? period.startDate;
    const end = params.changes.endDate ?? period.endDate;
    if (end < start) {
      throw new ConfigurationError('A period cannot end before it starts.');
    }
    const clash = others.find((other) => start <= other.endDate && end >= other.startDate);
    if (clash) {
      throw new ConfigurationError(
        `Those dates overlap "${clash.name}" (${clash.startDate} to ${clash.endDate}). A `
          + 'transaction cannot belong to two VAT periods at once.',
      );
    }
  }

  const changed: string[] = [];
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.changes)) {
    if (value === undefined) continue;
    if ((period as unknown as Record<string, unknown>)[key] === value) continue;
    update[key] = value;
    changed.push(key);
  }
  if (changed.length === 0) return { changed };

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(vatPeriods).set({ ...update, updatedAt: timestamp })
      .where(eq(vatPeriods.id, params.vatPeriodId)).run();
    for (const key of changed) {
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'vat_period', entityId: params.vatPeriodId,
        action: 'updated', field: key,
        previousValue: String((period as unknown as Record<string, unknown>)[key] ?? ''),
        newValue: String(update[key] ?? ''),
        source: 'user', actor: params.actor ?? 'user',
      }).run();
    }
  });

  return { changed };
}

// ---------------------------------------------------------------------------
// Bank accounts and parties
// ---------------------------------------------------------------------------

export function updateBankAccount(
  db: AppDatabase,
  params: {
    companyId: string; bankAccountId: string;
    changes: Partial<{
      bankName: string; accountName: string; iban: string | null; bic: string | null;
      openingBalanceMinor: number; openingDate: string; closingDate: string | null;
      active: boolean; notes: string | null;
    }>;
    actor?: string;
  },
): { changed: string[]; warnings: string[] } {
  const account = db.select().from(bankAccounts)
    .where(and(
      eq(bankAccounts.id, params.bankAccountId),
      eq(bankAccounts.companyId, params.companyId),
    )).get();
  if (!account) throw new ConfigurationError(`Bank account ${params.bankAccountId} not found.`);

  const warnings: string[] = [];

  if (params.changes.openingBalanceMinor !== undefined
      && params.changes.openingBalanceMinor !== account.openingBalanceMinor) {
    const imported = db.select({ id: bankTransactions.id }).from(bankTransactions)
      .where(eq(bankTransactions.bankAccountId, params.bankAccountId)).limit(1).get();
    if (imported) {
      warnings.push(
        'Changing the opening balance after transactions have been imported will change '
          + 'every reconciliation for this account. Check the reconciliation afterwards.',
      );
    }
  }

  const changed: string[] = [];
  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.changes)) {
    if (value === undefined) continue;
    if ((account as unknown as Record<string, unknown>)[key] === value) continue;
    update[key] = value;
    changed.push(key);
  }
  if (changed.length === 0) return { changed, warnings };

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(bankAccounts).set({ ...update, updatedAt: timestamp })
      .where(eq(bankAccounts.id, params.bankAccountId)).run();
    for (const key of changed) {
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
        entityType: 'bank_account', entityId: params.bankAccountId,
        action: 'updated', field: key,
        previousValue: String((account as unknown as Record<string, unknown>)[key] ?? ''),
        newValue: String(update[key] ?? ''),
        source: 'user', actor: params.actor ?? 'user',
      }).run();
    }
  });

  return { changed, warnings };
}

export function upsertSupplier(
  db: AppDatabase,
  params: {
    companyId: string; supplierId?: string; name: string;
    countryCode?: string | null; vatNumber?: string | null;
    defaultAccountId?: string | null; defaultVatTreatmentId?: string | null;
    aliases?: string[]; notes?: string | null; actor?: string;
  },
): string {
  const matchKey = params.name.toLowerCase()
    .replace(/\b(limited|ltd|plc|inc|incorporated|llc|gmbh|bv|sarl|pbc|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

  if (params.supplierId) {
    db.update(suppliers).set({
      name: params.name, matchKey,
      countryCode: params.countryCode ?? null,
      vatNumber: params.vatNumber ?? null,
      defaultAccountId: params.defaultAccountId ?? null,
      defaultVatTreatmentId: params.defaultVatTreatmentId ?? null,
      aliases: params.aliases ?? [],
      notes: params.notes ?? null,
      updatedAt: nowIso(),
    }).where(and(
      eq(suppliers.id, params.supplierId),
      eq(suppliers.companyId, params.companyId),
    )).run();
    return params.supplierId;
  }

  const id = ids.supplier();
  db.insert(suppliers).values({
    id, companyId: params.companyId, name: params.name, matchKey,
    countryCode: params.countryCode ?? null,
    vatNumber: params.vatNumber ?? null,
    defaultAccountId: params.defaultAccountId ?? null,
    defaultVatTreatmentId: params.defaultVatTreatmentId ?? null,
    aliases: params.aliases ?? [],
    notes: params.notes ?? null,
  }).run();
  return id;
}

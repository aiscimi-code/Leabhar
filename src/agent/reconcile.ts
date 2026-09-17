import { eq, and } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankAccounts, accounts, vatTreatments, bankTransactions, auditEvents, companies } from '@/db/schema';
import { importStatement, type ImportSummary } from '@/domain/banking/import';
import {
  reconcileBankAccount,
  completeReconciliation,
  reconciliationHistory,
  type ReconciliationResult,
} from '@/domain/banking/reconciliation';
import { classifyTransaction, type ClassifyResult } from '@/domain/banking/classify';
import { createRule } from '@/domain/rules/engine';
import { asIsoDate } from '@/domain/dates';
import { multiplyRational } from '@/domain/money';
import { nowIso } from '@/domain/dates';
import { ids } from '@/lib/ids';
import type {
  ImportInput, ReconcileInput, RunPipelineInput, AutoClassifyInput,
} from './schema';
import { autoClassifyFromRules, type AutoClassifyResult } from './classify';

export interface BankAccountSummary {
  id: string;
  bankName: string;
  accountName: string;
  currency: string;
  active: boolean;
}

export function listBankAccounts(
  db: AppDatabase, companyId: string,
): BankAccountSummary[] {
  return db.select({
    id: bankAccounts.id,
    bankName: bankAccounts.bankName,
    accountName: bankAccounts.accountName,
    currency: bankAccounts.currency,
    active: bankAccounts.active,
  }).from(bankAccounts)
    .where(eq(bankAccounts.companyId, companyId))
    .orderBy(bankAccounts.createdAt)
    .all();
}

export function listReconciliations(
  db: AppDatabase, companyId: string,
) {
  return reconciliationHistory(db, companyId);
}

export async function importStatementFile(
  db: AppDatabase, input: ImportInput,
): Promise<ImportSummary> {
  const fileFormat = input.file.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
  const content = await readContent(input.file);
  return importStatement(db, {
    companyId: input.companyId,
    bankAccountId: input.accountId,
    filename: input.file.split('/').pop() ?? input.file,
    content,
    fileFormat,
    importedBy: 'cli',
  });
}

async function readContent(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

export function reconcile(
  db: AppDatabase, input: ReconcileInput,
): ReconciliationResult {
  return reconcileBankAccount(db, {
    companyId: input.companyId,
    bankAccountId: input.bankAccountId,
    periodStart: asIsoDate(input.from),
    periodEnd: asIsoDate(input.to),
    statementClosingBalanceMinor: input.statementClosingBalance,
  });
}

export function signOff(
  db: AppDatabase, input: ReconcileInput,
): { reconciliationId: string; result: ReconciliationResult } {
  return completeReconciliation(db, {
    companyId: input.companyId,
    bankAccountId: input.bankAccountId,
    periodStart: asIsoDate(input.from),
    periodEnd: asIsoDate(input.to),
    statementClosingBalanceMinor: input.statementClosingBalance,
    actor: 'cli',
    acceptDifference: input.acceptDifference
      ? { reason: input.acceptDifference }
      : undefined,
  });
}

export interface RunPipelineResult {
  import: ImportSummary | undefined;
  classify: AutoClassifyResult;
  reconcile: ReconciliationResult;
  signOff?: { reconciliationId: string; result: ReconciliationResult };
}

export async function runPipeline(
  db: AppDatabase, input: RunPipelineInput,
): Promise<RunPipelineResult> {
  // --file is optional: without it the pipeline operates on already-imported
  // transactions (auto-classify → reconcile), so an agent can re-run over data
  // it has already imported without a new statement.
  const importSummary = input.file
    ? await importStatementFile(db, {
      companyId: input.companyId,
      accountId: input.bankAccountId,
      file: input.file,
    })
    : undefined;

  const classifyResult = autoClassifyFromRules(db, {
    companyId: input.companyId,
    bankAccountId: input.bankAccountId,
  });

  const reconcileResult = reconcileBankAccount(db, {
    companyId: input.companyId,
    bankAccountId: input.bankAccountId,
    periodStart: asIsoDate(input.from),
    periodEnd: asIsoDate(input.to),
    statementClosingBalanceMinor: input.statementClosingBalance,
  });

  let signOffResult: RunPipelineResult['signOff'];
  if (input.signOff) {
    signOffResult = completeReconciliation(db, {
      companyId: input.companyId,
      bankAccountId: input.bankAccountId,
      periodStart: asIsoDate(input.from),
      periodEnd: asIsoDate(input.to),
      statementClosingBalanceMinor: input.statementClosingBalance,
      actor: 'cli',
      acceptDifference: input.acceptDifference
        ? { reason: input.acceptDifference }
        : undefined,
    });
  }

  return {
    import: importSummary,
    classify: classifyResult,
    reconcile: reconcileResult,
    signOff: signOffResult,
  };
}

export type { AutoClassifyInput };
export { autoClassifyFromRules } from './classify';

// ---- Discovery: chart of accounts, VAT treatments ----

export interface ChartAccountSummary {
  id: string;
  code: string;
  name: string;
  type: string;
  systemKey: string | null;
  vatApplicable: boolean;
}

export function listChartOfAccounts(
  db: AppDatabase, companyId: string,
): ChartAccountSummary[] {
  return db.select({
    id: accounts.id,
    code: accounts.code,
    name: accounts.name,
    type: accounts.type,
    systemKey: accounts.systemKey,
    vatApplicable: accounts.vatApplicable,
  }).from(accounts)
    .where(eq(accounts.companyId, companyId))
    .orderBy(accounts.code).all();
}

export interface VatTreatmentSummary {
  id: string;
  code: string;
  name: string;
  jurisdiction: string;
}

export function listVatTreatments(
  db: AppDatabase, companyId: string,
): VatTreatmentSummary[] {
  return db.select({
    id: vatTreatments.id,
    code: vatTreatments.code,
    name: vatTreatments.name,
    jurisdiction: vatTreatments.jurisdiction,
  }).from(vatTreatments)
    .where(eq(vatTreatments.companyId, companyId))
    .orderBy(vatTreatments.jurisdiction, vatTreatments.code).all();
}

// ---- Resolution: accept an account code or ID, a treatment code or ID ----

export function resolveAccountId(
  db: AppDatabase, companyId: string, codeOrId: string,
): string {
  // An ID starts with the account prefix; resolve directly.
  if (codeOrId.startsWith('acc_')) {
    return codeOrId;
  }
  const row = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, codeOrId)))
    .get();
  if (!row) throw new Error(`Account "${codeOrId}" not found. Use list-chart to see account codes.`);
  return row.id;
}

export function resolveVatTreatmentId(
  db: AppDatabase, companyId: string, codeOrId: string,
): string {
  if (codeOrId.startsWith('vt_')) {
    return codeOrId;
  }
  const row = db.select({ id: vatTreatments.id }).from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, codeOrId)))
    .get();
  if (!row) throw new Error(`VAT treatment "${codeOrId}" not found. Use list-vat-treatments to see treatment codes.`);
  return row.id;
}

// ---- Manual classification ----

export function classifyTransactionManual(
  db: AppDatabase, input: {
    companyId: string;
    bankTransactionId: string;
    accountId: string;
    vatTreatmentId: string;
    supplierId?: string | null;
    fxRate?: { numerator: number; denominator: number };
    notes?: string | null;
  },
): ClassifyResult {
  return classifyTransaction(db, {
    companyId: input.companyId,
    bankTransactionId: input.bankTransactionId,
    accountId: input.accountId,
    vatTreatmentId: input.vatTreatmentId,
    supplierId: input.supplierId ?? null,
    fxRate: input.fxRate
      ? { numerator: input.fxRate.numerator, denominator: input.fxRate.denominator, source: 'user_supplied' }
      : undefined,
    source: 'user',
    provenanceStatus: 'manually_entered',
    actor: 'cli',
    notes: input.notes,
  });
}

// ---- Rule creation ----

export function createRuleManual(
  db: AppDatabase, input: {
    companyId: string;
    name: string;
    conditions: Array<{ field: string; operator: string; value: string | number | Array<string | number> | null }>;
    actions: Array<{ field: string; value: string | null }>;
    autoApply?: boolean;
    priority?: number;
  },
): string {
  return createRule(db, {
    companyId: input.companyId,
    name: input.name,
    conditions: input.conditions as Parameters<typeof createRule>[1]['conditions'],
    actions: input.actions as Parameters<typeof createRule>[1]['actions'],
    autoApply: input.autoApply ?? false,
    priority: input.priority,
    actor: 'cli',
  });
}

// ---- Set FX on an already-imported transaction ----

export interface SetFxResult {
  bankTransactionId: string;
  baseAmountMinor: number;
  fxRateNumerator: number;
  fxRateDenominator: number;
  fxRateSource: string;
}

/**
 * Attach a settled base-currency amount and exchange rate to an already-imported
 * foreign-currency transaction.
 *
 * The imported evidence (date, amount, description) is never touched — only the
 * derived FX fields change (schema: "Derived / user-owned. Freely updatable").
 * After this, reconcile can fold the foreign line into a base-currency
 * difference, and auto-classify can post it using the bank's rate.
 *
 * The rate is stored as an exact rational (numerator/denominator) so the
 * conversion is reproducible and auditable, never a float. The source is
 * `user_supplied` so it is distinguishable from a rate the bank's statement
 * itself carried.
 */
export function setTransactionFx(
  db: AppDatabase, input: {
    companyId: string;
    bankTransactionId: string;
    /** The settled base-currency amount, if the statement or a rate service provides it. */
    baseAmountMinor?: number;
    /** The exchange rate as a rational. Required if baseAmountMinor is not given. */
    fxRateNumerator?: number;
    fxRateDenominator?: number;
    /** Provenance for the rate. Defaults to 'bank_statement' so classifyTransaction picks it up. */
    fxRateSource?: string;
  },
): SetFxResult {
  const tx = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, input.bankTransactionId),
      eq(bankTransactions.companyId, input.companyId),
    )).get();
  if (!tx) throw new Error(`Bank transaction ${input.bankTransactionId} not found.`);

  const company = db.select().from(companies)
    .where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);
  const baseCurrency = company.baseCurrency;

  if (tx.currency === baseCurrency) {
    throw new Error(
      `Transaction ${tx.id} is already in the base currency (${baseCurrency}); no FX rate is needed.`,
    );
  }

  let numerator: number;
  let denominator: number;
  let baseAmountMinor: number;

  if (input.baseAmountMinor !== undefined && input.fxRateNumerator !== undefined && input.fxRateDenominator !== undefined) {
    numerator = input.fxRateNumerator;
    denominator = input.fxRateDenominator;
    baseAmountMinor = input.baseAmountMinor;
  } else if (input.baseAmountMinor !== undefined) {
    // Derive the rate from the settled amount and the foreign amount.
    if (tx.amountMinor === 0) throw new Error('Cannot derive an exchange rate from a zero-amount transaction.');
    numerator = Math.abs(input.baseAmountMinor);
    denominator = Math.abs(tx.amountMinor);
    baseAmountMinor = input.baseAmountMinor;
  } else if (input.fxRateNumerator !== undefined && input.fxRateDenominator !== undefined) {
    numerator = input.fxRateNumerator;
    denominator = input.fxRateDenominator;
    baseAmountMinor = multiplyRational(tx.amountMinor, numerator, denominator);
  } else {
    throw new Error('Provide --base-amount or --fx-rate (or both).');
  }

  const timestamp = nowIso();
  const source = input.fxRateSource ?? 'bank_statement';

  db.transaction((tx2) => {
    tx2.update(bankTransactions).set({
      baseAmountMinor,
      baseCurrency,
      fxRateNumerator: numerator,
      fxRateDenominator: denominator,
      fxRateSource: source,
      updatedAt: timestamp,
    }).where(eq(bankTransactions.id, tx.id)).run();

    tx2.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'bank_transaction',
      entityId: tx.id,
      action: 'updated',
      field: 'fx_rate',
      previousValue: JSON.stringify({
        baseAmountMinor: tx.baseAmountMinor,
        fxRateNumerator: tx.fxRateNumerator,
        fxRateDenominator: tx.fxRateDenominator,
        fxRateSource: tx.fxRateSource,
      }),
      newValue: JSON.stringify({ baseAmountMinor, fxRateNumerator: numerator, fxRateDenominator: denominator, fxRateSource: source }),
      source: 'user',
      actor: 'cli',
      reason: 'FX rate set via CLI',
    }).run();
  });

  return { bankTransactionId: tx.id, baseAmountMinor, fxRateNumerator: numerator, fxRateDenominator: denominator, fxRateSource: source };
}

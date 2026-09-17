import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankAccounts } from '@/db/schema';
import { importStatement, type ImportSummary } from '@/domain/banking/import';
import {
  reconcileBankAccount,
  completeReconciliation,
  reconciliationHistory,
  type ReconciliationResult,
} from '@/domain/banking/reconciliation';
import { asIsoDate } from '@/domain/dates';
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
  import: ImportSummary;
  classify: AutoClassifyResult;
  reconcile: ReconciliationResult;
  signOff?: { reconciliationId: string; result: ReconciliationResult };
}

export async function runPipeline(
  db: AppDatabase, input: RunPipelineInput,
): Promise<RunPipelineResult> {
  const importSummary = await importStatementFile(db, {
    companyId: input.companyId,
    accountId: input.bankAccountId,
    file: input.file,
  });

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

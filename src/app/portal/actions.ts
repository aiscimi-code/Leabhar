'use server';

import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { createPortalDatabase, serializePortalDatabase, closePortalDatabase } from '@/db/portal';
import { encryptVault, decryptVault, VaultDecryptionError } from '@/lib/portal/crypto';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { importStatement } from '@/domain/banking/import';
import { proposeColumnMapping, readCsvHeaders } from '@/domain/banking/statementParser';
import { asIsoDate } from '@/domain/dates';
import { parseAmount } from '@/domain/money';
import { companies, bankAccounts, bankTransactions } from '@/db/schema';

/**
 * Server actions for the portal (issue #166).
 *
 * Every action here follows the same shape: open an ephemeral in-memory
 * database (empty, or reopened from a vault the caller decrypted), run
 * ordinary domain functions against it — the same ones the CLI and the
 * local desktop app use — then serialize, encrypt, and hand the result
 * back. `db/portal.ts`'s database is never the shared `getDb()` the rest of
 * this app uses, and nothing here writes to disk or a persistent store: the
 * `finally` block closing the in-memory database is the entire cleanup,
 * because there is nothing else to clean up.
 */

export type PortalResult =
  | { ok: true; vaultBase64: string; summary: PortalSummary }
  | { ok: false; error: string };

export interface PortalSummary {
  legalName: string;
  bankAccountName: string;
  transactionCount: number;
  recentTransactions: Array<{
    date: string; description: string; amountMinor: number; currency: string; status: string;
  }>;
  importMessage: string | null;
}

function fail(error: unknown): PortalResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const text = (formData: FormData, key: string): string => String(formData.get(key) ?? '').trim();

function readSummary(
  db: AppDatabase,
  companyId: string,
  importMessage: string | null,
): PortalSummary {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
  const bankAccount = db.select().from(bankAccounts)
    .where(eq(bankAccounts.companyId, companyId)).get();

  const all = bankAccount
    ? db.select().from(bankTransactions)
        .where(eq(bankTransactions.bankAccountId, bankAccount.id))
        .orderBy(bankTransactions.transactionDate).all()
    : [];

  return {
    legalName: company.legalName,
    bankAccountName: bankAccount ? `${bankAccount.bankName} — ${bankAccount.accountName}` : 'None yet',
    transactionCount: all.length,
    recentTransactions: all.slice(-20).reverse().map((t) => ({
      date: t.transactionDate, description: t.description,
      amountMinor: t.amountMinor, currency: t.currency, status: t.status,
    })),
    importMessage,
  };
}

/**
 * Start a brand new vault: a company and its first bank account, nothing
 * more. `create-invoice`, VAT settings, extra accounts and so on all exist
 * already in the domain layer and the CLI — this is deliberately the
 * smallest useful starting point, not a reimplementation of induction.
 */
export async function createVaultAction(formData: FormData): Promise<PortalResult> {
  const password = String(formData.get('password') ?? '');
  const legalName = text(formData, 'legalName');
  const bankName = text(formData, 'bankName') || 'Current Account';
  const baseCurrency = (text(formData, 'baseCurrency') || 'EUR').toUpperCase();
  const opening = text(formData, 'opening');
  const openingDate = text(formData, 'openingDate');

  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (!legalName) return { ok: false, error: 'A company name is required.' };
  if (opening && !openingDate) {
    return { ok: false, error: 'An opening balance needs an opening date to journal it against.' };
  }

  const db = createPortalDatabase();
  try {
    const company = createCompany(db, {
      legalName, baseCurrency, seedYears: [new Date().getFullYear()],
    });
    addBankAccount(db, {
      companyId: company.companyId,
      bankName, accountName: bankName, currency: baseCurrency,
      openingBalanceMinor: opening ? parseAmount(opening, baseCurrency) : 0,
      openingDate: openingDate ? asIsoDate(openingDate) : '1900-01-01',
      actor: 'portal',
    });

    const summary = readSummary(db, company.companyId, null);
    const vault = encryptVault(serializePortalDatabase(db), password);
    return { ok: true, vaultBase64: vault.toString('base64'), summary };
  } catch (e) {
    return fail(e);
  } finally {
    closePortalDatabase(db);
  }
}

/**
 * Unlock a previously downloaded vault, optionally importing one bank
 * statement into its (first, and for now only) bank account, and hand back
 * the updated, still-encrypted vault. Nothing decrypted here is written
 * anywhere but this response.
 */
export async function importIntoVaultAction(formData: FormData): Promise<PortalResult> {
  const password = String(formData.get('password') ?? '');
  const vaultFile = formData.get('vault');
  const statementFile = formData.get('statement');

  if (!(vaultFile instanceof File) || vaultFile.size === 0) {
    return { ok: false, error: 'Choose the vault file you downloaded last time.' };
  }
  if (!password) return { ok: false, error: 'Enter the vault password.' };

  let bytes: Buffer;
  try {
    bytes = decryptVault(Buffer.from(await vaultFile.arrayBuffer()), password);
  } catch (e) {
    if (e instanceof VaultDecryptionError) return { ok: false, error: e.message };
    return fail(e);
  }

  const db = createPortalDatabase(bytes);
  try {
    const company = db.select().from(companies).get();
    if (!company) return { ok: false, error: 'This vault has no company in it yet.' };

    let importMessage: string | null = null;

    if (statementFile instanceof File && statementFile.size > 0) {
      const bankAccount = db.select().from(bankAccounts)
        .where(eq(bankAccounts.companyId, company.id)).get();
      if (!bankAccount) {
        return { ok: false, error: 'This vault has no bank account to import a statement into.' };
      }

      // CSV only for now — XLSX and invoice PDFs/images are a later phase
      // (see the "Not yet built" note in docs/PORTAL.md).
      const content = await statementFile.text();
      const { mapping } = proposeColumnMapping(readCsvHeaders(content));

      const result = await importStatement(db, {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        filename: statementFile.name,
        content,
        fileFormat: 'csv',
        columnMap: mapping,
        importedBy: 'portal',
      });

      importMessage = `Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}`
        + (result.duplicates > 0 ? `, ${result.duplicates} already present` : '')
        + (result.failed > 0 ? `, ${result.failed} row${result.failed === 1 ? '' : 's'} failed` : '')
        + '.';
    }

    const summary = readSummary(db, company.id, importMessage);
    const vault = encryptVault(serializePortalDatabase(db), password);
    return { ok: true, vaultBase64: vault.toString('base64'), summary };
  } catch (e) {
    return fail(e);
  } finally {
    closePortalDatabase(db);
  }
}

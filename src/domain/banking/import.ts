import { and, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, statementImports, bankAccounts, accountingPeriods,
  auditEvents, importProfiles, companies,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate } from '../dates';
import { fileHash, assignOccurrenceIndices } from './fingerprint';
import {
  parseCsv, buildResult, readCsvHeaders, proposeColumnMapping, headerSignature,
  type ParseOptions, type ParseResult, type ParsedTransaction, type ColumnMapping,
} from './statementParser';

export interface ImportSummary {
  importId: string;
  rowsRead: number;
  imported: number;
  duplicates: number;
  failed: number;
  errors: Array<{ rowNumber: number; message: string }>;
  warnings: string[];
  /** Populated when the file itself has been imported before. */
  duplicateOfImportId?: string;
  statementStartDate: string | null;
  statementEndDate: string | null;
}

export interface ImportStatementInput {
  companyId: string;
  bankAccountId: string;
  filename: string;
  content: Buffer | string;
  fileFormat: 'csv' | 'xlsx';
  columnMap?: ColumnMapping;
  importProfileId?: string;
  parseOverrides?: Partial<ParseOptions>;
  importedBy?: string;
  requestId?: string;
  /** Re-import a file whose hash has been seen before. Requires intent. */
  allowReimport?: boolean;
}

/**
 * Import a bank statement (README §13, §14).
 *
 * Two independent duplicate defences, because they catch different mistakes:
 *
 *  - The file hash catches "I imported the same download twice", and short-
 *    circuits before any row is examined.
 *  - The per-transaction fingerprint catches overlapping statements, which is
 *    the common case when a user downloads January–March and then February–April.
 *
 * Neither ever discards a transaction silently: duplicates are counted and
 * reported, and README §13's promise — "No duplicate transactions imported" —
 * is stated to the user as a fact about what happened.
 */
export async function importStatement(
  db: AppDatabase,
  input: ImportStatementInput,
): Promise<ImportSummary> {
  const account = db.select().from(bankAccounts)
    .where(and(
      eq(bankAccounts.id, input.bankAccountId),
      eq(bankAccounts.companyId, input.companyId),
    )).get();
  if (!account) throw new Error(`Bank account ${input.bankAccountId} not found.`);

  const company = db.select().from(companies)
    .where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);
  const baseCurrency = company.baseCurrency;

  const hash = fileHash(input.content);

  // ---- Defence 1: the same file ----
  const priorImport = db.select().from(statementImports)
    .where(and(
      eq(statementImports.companyId, input.companyId),
      eq(statementImports.bankAccountId, input.bankAccountId),
      eq(statementImports.fileHash, hash),
      eq(statementImports.status, 'completed'),
    )).get();

  if (priorImport && !input.allowReimport) {
    return {
      importId: priorImport.id,
      rowsRead: priorImport.rowsRead,
      imported: 0,
      duplicates: priorImport.rowsImported,
      failed: 0,
      errors: [],
      warnings: [
        `This exact file was already imported on ${priorImport.createdAt} as `
          + `"${priorImport.filename}". No duplicate transactions imported.`,
      ],
      duplicateOfImportId: priorImport.id,
      statementStartDate: priorImport.statementStartDate,
      statementEndDate: priorImport.statementEndDate,
    };
  }

  // ---- Resolve the parse options ----
  const profile = input.importProfileId
    ? db.select().from(importProfiles).where(eq(importProfiles.id, input.importProfileId)).get()
    : undefined;

  const text = typeof input.content === 'string' ? input.content : input.content.toString('utf8');
  const headers = input.fileFormat === 'csv'
    ? readCsvHeaders(text, profile?.skipRows ?? 0, profile?.delimiter)
    : await readXlsxHeaders(input.content as Buffer);

  const columnMap = input.columnMap
    ?? (profile?.columnMap as ColumnMapping | undefined)
    ?? proposeColumnMapping(headers).mapping;

  const parseOptions: ParseOptions = {
    bankAccountId: input.bankAccountId,
    columnMap,
    defaultCurrency: profile?.defaultCurrency ?? account.currency,
    dateFormat: profile?.dateFormat ?? 'day_first',
    decimalSeparator: profile?.decimalSeparator,
    amountStyle: profile?.amountStyle ?? 'signed',
    invertAmountSign: profile?.invertAmountSign ?? false,
    skipRows: profile?.skipRows ?? 0,
    delimiter: profile?.delimiter,
    ...input.parseOverrides,
  };

  const parsed: ParseResult = input.fileFormat === 'csv'
    ? parseCsv(text, parseOptions)
    : await parseXlsx(input.content as Buffer, parseOptions);

  const dates = parsed.transactions.map((t) => t.transactionDate).sort();
  const statementStartDate = dates[0] ?? null;
  const statementEndDate = dates[dates.length - 1] ?? null;

  const importId = ids.statementImport();
  const timestamp = nowIso();

  // ---- Defence 2: per-transaction fingerprints ----
  const withOccurrences = assignOccurrenceIndices(parsed.transactions);

  const existing = new Set<string>();
  if (withOccurrences.length > 0) {
    const fingerprints = [...new Set(withOccurrences.map((t) => t.fingerprint))];
    for (let i = 0; i < fingerprints.length; i += 400) {
      const rows = db.select({
        fingerprint: bankTransactions.fingerprint,
        occurrenceIndex: bankTransactions.occurrenceIndex,
      }).from(bankTransactions)
        .where(and(
          eq(bankTransactions.bankAccountId, input.bankAccountId),
          inArray(bankTransactions.fingerprint, fingerprints.slice(i, i + 400)),
        )).all();
      for (const row of rows) existing.add(`${row.fingerprint}#${row.occurrenceIndex}`);
    }
  }

  const periods = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, input.companyId),
      eq(accountingPeriods.kind, 'financial_year'),
    )).all();

  let imported = 0;
  let duplicates = 0;

  db.transaction((tx) => {
    tx.insert(statementImports).values({
      id: importId,
      companyId: input.companyId,
      bankAccountId: input.bankAccountId,
      filename: input.filename,
      fileHash: hash,
      fileFormat: input.fileFormat,
      importProfileId: input.importProfileId ?? null,
      statementStartDate,
      statementEndDate,
      rowsRead: parsed.rowsRead,
      status: 'pending',
      errors: parsed.errors.map((e) => `Row ${e.rowNumber}: ${e.message}`),
      importedBy: input.importedBy ?? 'user',
    }).run();

    for (const transaction of withOccurrences) {
      const key = `${transaction.fingerprint}#${transaction.occurrenceIndex}`;
      if (existing.has(key)) {
        duplicates += 1;
        continue;
      }
      existing.add(key);

      const period = periods.find(
        (p) => transaction.transactionDate >= p.startDate && transaction.transactionDate <= p.endDate,
      );

      // When the statement reports both the foreign amount and the settled
      // base-currency amount, derive the bank's actual exchange rate from the
      // two figures. This is the rate that matters for the books — not today's
      // ECB rate — because it is what the bank actually charged.
      const hasStatementRate = transaction.baseAmountMinor !== null
        && transaction.currency !== baseCurrency;

      tx.insert(bankTransactions).values({
        id: ids.bankTransaction(),
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        statementImportId: importId,
        transactionDate: transaction.transactionDate,
        valueDate: transaction.valueDate,
        description: transaction.description,
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        baseAmountMinor: hasStatementRate ? transaction.baseAmountMinor : null,
        baseCurrency: hasStatementRate ? baseCurrency : null,
        fxRateNumerator: hasStatementRate ? Math.abs(transaction.baseAmountMinor!) : null,
        fxRateDenominator: hasStatementRate ? Math.abs(transaction.amountMinor) : null,
        fxRateSource: hasStatementRate ? 'bank_statement' : null,
        balanceAfterMinor: transaction.balanceAfterMinor,
        bankReference: transaction.bankReference,
        bankTransactionId: transaction.bankTransactionId,
        counterpartyName: transaction.counterpartyName,
        counterpartyIban: transaction.counterpartyIban,
        transactionType: transaction.transactionType,
        notes: transaction.notes,
        rawData: transaction.rawData,
        fingerprint: transaction.fingerprint,
        occurrenceIndex: transaction.occurrenceIndex,
        accountingPeriodId: period?.id ?? null,
        status: 'unclassified',
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
      imported += 1;
    }

    const status = parsed.errors.length > 0 ? 'completed_with_errors' : 'completed';
    tx.update(statementImports).set({
      rowsImported: imported,
      rowsDuplicate: duplicates,
      rowsFailed: parsed.errors.length,
      status,
    }).where(eq(statementImports.id, importId)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'statement_import',
      entityId: importId,
      action: 'import_completed',
      newValue: JSON.stringify({
        filename: input.filename, rowsRead: parsed.rowsRead,
        imported, duplicates, failed: parsed.errors.length,
      }),
      source: 'import',
      actor: input.importedBy ?? 'user',
      requestId: input.requestId ?? null,
    }).run();

    if (input.importProfileId) {
      tx.update(importProfiles)
        .set({ timesUsed: (profile?.timesUsed ?? 0) + 1, lastUsedAt: timestamp })
        .where(eq(importProfiles.id, input.importProfileId)).run();
    }
  });

  const warnings = [...parsed.warnings];
  if (duplicates > 0) {
    warnings.push(
      `${duplicates} transaction${duplicates === 1 ? '' : 's'} already present and skipped. `
        + 'No duplicate transactions imported.',
    );
  }

  return {
    importId,
    rowsRead: parsed.rowsRead,
    imported,
    duplicates,
    failed: parsed.errors.length,
    errors: parsed.errors.map((e) => ({ rowNumber: e.rowNumber, message: e.message })),
    warnings,
    statementStartDate,
    statementEndDate,
  };
}

/** Read an XLSX into rows of strings, then reuse the CSV pipeline. */
export async function parseXlsx(content: Buffer, options: ParseOptions): Promise<ParseResult> {
  const { headers, rows } = await xlsxToRows(content, options.skipRows ?? 0);
  return buildResult(rows, headers, options);
}

export async function readXlsxHeaders(content: Buffer, skipRows = 0): Promise<string[]> {
  return (await xlsxToRows(content, skipRows)).headers;
}

async function xlsxToRows(
  content: Buffer, skipRows: number,
): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const allRows: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cellToString(cell));
    });
    allRows.push(values);
  });

  const body = allRows.slice(skipRows);
  const headers = (body[0] ?? []).map((h) => h.trim());
  const rows = body.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => { record[header] = values[index] ?? ''; });
    return record;
  });

  return { headers, rows };
}

function cellToString(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel dates arrive as Date objects; emit ISO so the date parser is exact.
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return String(value.result);
    if ('text' in value && value.text !== undefined) return String(value.text);
    if ('richText' in value) {
      return (value.richText as Array<{ text: string }>).map((r) => r.text).join('');
    }
    return '';
  }
  return String(value);
}

/** Remember a column mapping so the user maps a bank's format only once. */
export function saveImportProfile(
  db: AppDatabase,
  params: {
    companyId: string;
    name: string;
    bankAccountId?: string;
    headers: string[];
    columnMap: ColumnMapping;
    fileFormat?: 'csv' | 'xlsx';
    dateFormat?: 'day_first' | 'month_first' | 'iso';
    decimalSeparator?: '.' | ',';
    amountStyle?: 'signed' | 'debit_credit_columns' | 'amount_with_indicator';
    invertAmountSign?: boolean;
    skipRows?: number;
    delimiter?: string;
    defaultCurrency?: string;
  },
): string {
  const id = ids.importProfile();
  db.insert(importProfiles).values({
    id,
    companyId: params.companyId,
    name: params.name,
    bankAccountId: params.bankAccountId ?? null,
    fileFormat: params.fileFormat ?? 'csv',
    headerSignature: headerSignature(params.headers),
    delimiter: params.delimiter ?? ',',
    skipRows: params.skipRows ?? 0,
    columnMap: params.columnMap,
    dateFormat: params.dateFormat ?? 'day_first',
    decimalSeparator: params.decimalSeparator ?? '.',
    amountStyle: params.amountStyle ?? 'signed',
    invertAmountSign: params.invertAmountSign ?? false,
    defaultCurrency: params.defaultCurrency ?? 'EUR',
  }).run();
  return id;
}

/** Find a saved profile matching a file's headers. */
export function findMatchingProfile(
  db: AppDatabase, companyId: string, headers: string[],
): typeof importProfiles.$inferSelect | undefined {
  const signature = headerSignature(headers);
  return db.select().from(importProfiles)
    .where(and(
      eq(importProfiles.companyId, companyId),
      eq(importProfiles.headerSignature, signature),
    )).get();
}

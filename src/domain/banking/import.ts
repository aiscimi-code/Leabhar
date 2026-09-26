import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, statementImports, bankAccounts, accountingPeriods,
  auditEvents, importProfiles, companies, documents, documentMatches, payments,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate } from '../dates';
import { fileHash, assignOccurrenceIndices, transactionFingerprint } from './fingerprint';
import {
  parseCsv, buildResult, readCsvHeaders, proposeColumnMapping, headerSignature,
  type ParseOptions, type ParseResult, type ParsedTransaction, type ColumnMapping,
} from './statementParser';
import { parseOfx, parseCamt053, type StructuredStatement } from './structuredStatements';

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
  /** CSV and XLSX are mapped by column; OFX and CAMT.053 are read as the bank wrote them (#378). */
  fileFormat: 'csv' | 'xlsx' | 'ofx' | 'camt053';
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

  let parsed: ParseResult;
  let structured: StructuredStatement | null = null;
  if (input.fileFormat === 'ofx' || input.fileFormat === 'camt053') {
    // Structured formats name their own fields: there is no column mapping
    // to guess, and the bank's balances come with the file.
    const options = { bankAccountId: input.bankAccountId, defaultCurrency: account.currency };
    structured = input.fileFormat === 'ofx' ? parseOfx(text, options) : parseCamt053(text, options);
    parsed = structured;
  } else {
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

    parsed = input.fileFormat === 'csv'
      ? parseCsv(text, parseOptions)
      : await parseXlsx(input.content as Buffer, parseOptions);
  }

  const dates = parsed.transactions.map((t) => t.transactionDate).sort();
  const statementStartDate = dates[0] ?? null;
  // A structured statement says when its closing balance is struck; that,
  // not the last line's date, is where the statement ends.
  const statementEndDate = structured?.closingBalanceDate ?? dates[dates.length - 1] ?? null;

  const importId = ids.statementImport();
  const timestamp = nowIso();

  // ---- Defence 2: per-transaction fingerprints ----
  const withOccurrences = skipRolledBackIndices(
    db, input.bankAccountId, assignOccurrenceIndices(parsed.transactions),
  );

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
          // A line whose import was undone does not stop its correction (#379).
          ne(bankTransactions.status, 'rolled_back'),
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
      openingBalanceMinor: structured?.openingBalanceMinor ?? null,
      closingBalanceMinor: structured?.closingBalanceMinor ?? null,
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

/**
 * Occurrence numbers held by lines whose import was undone stay taken — the
 * rows remain as evidence (issue #379) — so the k-th occurrence of a
 * fingerprint in a file takes the k-th number not held by a rolled-back line.
 * Stable for as long as the rolled-back lines are, so importing the corrected
 * file twice still finds the second run's lines already present.
 */
function skipRolledBackIndices<T extends { fingerprint: string; occurrenceIndex: number }>(
  db: AppDatabase, bankAccountId: string, rows: T[],
): T[] {
  if (rows.length === 0) return rows;
  const held = new Map<string, Set<number>>();
  const fingerprints = [...new Set(rows.map((r) => r.fingerprint))];
  for (let i = 0; i < fingerprints.length; i += 400) {
    for (const row of db.select({
      fingerprint: bankTransactions.fingerprint, occurrenceIndex: bankTransactions.occurrenceIndex,
    }).from(bankTransactions).where(and(
      eq(bankTransactions.bankAccountId, bankAccountId),
      eq(bankTransactions.status, 'rolled_back'),
      inArray(bankTransactions.fingerprint, fingerprints.slice(i, i + 400)),
    )).all()) {
      const set = held.get(row.fingerprint) ?? new Set<number>();
      set.add(row.occurrenceIndex);
      held.set(row.fingerprint, set);
    }
  }
  if (held.size === 0) return rows;
  return rows.map((row) => {
    const taken = held.get(row.fingerprint);
    if (!taken) return row;
    let free = -1;
    let index = -1;
    while (free < row.occurrenceIndex) {
      index += 1;
      if (!taken.has(index)) free += 1;
    }
    return { ...row, occurrenceIndex: index };
  });
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

/**
 * Record a movement on an account that has no statement to import — petty
 * cash, most often (issue #377) — or one line the bank's file left out.
 *
 * It goes through the same bank-transaction evidence path as an imported line,
 * so it is classified, matched and reconciled the same way, and it traces back
 * to a `manual` statement import naming who recorded it and when. The person
 * recording it is the evidence: the line is `manually_entered`, never
 * `imported`. Two identical entries on the same day are both kept, with their
 * own occurrence index, exactly as two identical charges on a statement are.
 */
export function recordManualTransaction(
  db: AppDatabase,
  input: {
    companyId: string;
    bankAccountId: string;
    transactionDate: string;
    description: string;
    /** Signed, in the account's currency: negative is money out. */
    amountMinor: number;
    reference?: string | null;
    counterpartyName?: string | null;
    recordedBy: string;
    requestId?: string;
  },
): { importId: string; transactionId: string } {
  const recordedBy = input.recordedBy.trim();
  if (!recordedBy) throw new Error('Say who is recording this: a manual entry rests on a person.');
  const description = input.description.trim();
  if (!description) throw new Error('Describe the movement: what was bought, sold or moved.');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new Error('The amount must be a whole number of cents, and not zero.');
  }
  const transactionDate = asIsoDate(input.transactionDate);

  const account = db.select().from(bankAccounts)
    .where(and(
      eq(bankAccounts.id, input.bankAccountId),
      eq(bankAccounts.companyId, input.companyId),
    )).get();
  if (!account) throw new Error(`Bank account ${input.bankAccountId} not found.`);

  const fingerprint = transactionFingerprint({
    bankAccountId: account.id,
    transactionDate,
    amountMinor: input.amountMinor,
    currency: account.currency,
    description,
    bankReference: input.reference ?? null,
  });
  const occurrenceIndex = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(
      eq(bankTransactions.bankAccountId, account.id),
      eq(bankTransactions.fingerprint, fingerprint),
    )).all().length;

  const period = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, input.companyId),
      eq(accountingPeriods.kind, 'financial_year'),
    )).all()
    .find((p) => transactionDate >= p.startDate && transactionDate <= p.endDate);

  const importId = ids.statementImport();
  const transactionId = ids.bankTransaction();
  const timestamp = nowIso();

  db.transaction((tx) => {
    tx.insert(statementImports).values({
      id: importId,
      companyId: input.companyId,
      bankAccountId: account.id,
      filename: 'Manual entry',
      fileHash: fileHash(`manual|${importId}`),
      fileFormat: 'manual',
      statementStartDate: transactionDate,
      statementEndDate: transactionDate,
      rowsRead: 1,
      rowsImported: 1,
      status: 'completed',
      importedBy: recordedBy,
    }).run();

    tx.insert(bankTransactions).values({
      id: transactionId,
      companyId: input.companyId,
      bankAccountId: account.id,
      statementImportId: importId,
      transactionDate,
      description,
      amountMinor: input.amountMinor,
      currency: account.currency,
      bankReference: input.reference ?? null,
      counterpartyName: input.counterpartyName ?? null,
      transactionType: 'manual',
      rawData: {},
      fingerprint,
      occurrenceIndex,
      accountingPeriodId: period?.id ?? null,
      status: 'unclassified',
      source: 'user',
      provenanceStatus: 'manually_entered',
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'bank_transaction',
      entityId: transactionId,
      action: 'created',
      newValue: JSON.stringify({ transactionDate, description, amountMinor: input.amountMinor }),
      source: 'user',
      actor: recordedBy,
      requestId: input.requestId ?? null,
    }).run();
  });

  return { importId, transactionId };
}

export class ImportRollbackError extends Error {}

export interface RollbackResult {
  importId: string;
  linesRolledBack: number;
  /** Match suggestions for the lines that nobody had acted on, now superseded. */
  suggestionsSuperseded: number;
}

/**
 * Undo a statement import that went wrong — the wrong account, the wrong
 * column mapping, the wrong file (issue #379).
 *
 * Refused while anything in the books rests on one of its lines: a line that
 * has been classified, matched, posted or reconciled, paid against an
 * invoice, or linked to a document. Undo those first; this never unwinds
 * postings on the way. Otherwise the import is marked `reversed` and each of
 * its lines `rolled_back`: the rows stay, as evidence of what was imported
 * and taken back out, but are left out of everything else, and their
 * fingerprints no longer stop the corrected file from being imported.
 */
export function rollbackStatementImport(
  db: AppDatabase,
  params: { companyId: string; importId: string; reason: string; actor: string; requestId?: string },
): RollbackResult {
  const reason = params.reason.trim();
  if (!reason) throw new ImportRollbackError('Say why this import is being undone.');
  const actor = params.actor.trim();
  if (!actor) throw new ImportRollbackError('Say who is undoing this import.');

  const run = db.select().from(statementImports)
    .where(and(eq(statementImports.id, params.importId), eq(statementImports.companyId, params.companyId)))
    .get();
  if (!run) throw new ImportRollbackError(`Import ${params.importId} not found.`);
  if (run.status === 'reversed') throw new ImportRollbackError('This import has already been undone.');

  const lines = db.select().from(bankTransactions)
    .where(eq(bankTransactions.statementImportId, run.id)).all();
  const lineIds = lines.map((l) => l.id);

  const blocked: string[] = [];
  const settled = new Set(['classified', 'matched', 'posted', 'reconciled']);
  for (const line of lines) {
    const what = [
      settled.has(line.status) ? `is ${line.status}` : null,
      line.journalEntryId ? 'has a journal entry' : null,
      line.reconciliationId ? 'is in a signed-off reconciliation' : null,
    ].filter(Boolean);
    if (what.length > 0) blocked.push(`${line.transactionDate} ${line.description} (${what.join(', ')})`);
  }
  for (let i = 0; i < lineIds.length; i += 400) {
    const chunk = lineIds.slice(i, i + 400);
    for (const payment of db.select().from(payments).where(inArray(payments.bankTransactionId, chunk)).all()) {
      blocked.push(`a payment recorded against line ${payment.bankTransactionId}`);
    }
    for (const doc of db.select().from(documents).where(inArray(documents.matchedTransactionId, chunk)).all()) {
      blocked.push(`document "${doc.originalFilename ?? doc.id}" linked to line ${doc.matchedTransactionId}`);
    }
    for (const match of db.select().from(documentMatches).where(and(
      inArray(documentMatches.bankTransactionId, chunk),
      inArray(documentMatches.decision, ['accepted', 'auto_accepted']),
    )).all()) {
      blocked.push(`an accepted document match on line ${match.bankTransactionId}`);
    }
  }
  if (blocked.length > 0) {
    const shown = blocked.slice(0, 10).join('; ');
    throw new ImportRollbackError(
      `The books already rest on ${blocked.length} item${blocked.length === 1 ? '' : 's'} from this import: `
        + `${shown}${blocked.length > 10 ? '; …' : ''}. Undo those first (reverse the posting, unmatch `
        + 'the document), then undo the import. Nothing has been changed.',
    );
  }

  const timestamp = nowIso();
  let suggestionsSuperseded = 0;
  db.transaction((tx) => {
    for (let i = 0; i < lineIds.length; i += 400) {
      const chunk = lineIds.slice(i, i + 400);
      tx.update(bankTransactions).set({ status: 'rolled_back', updatedAt: timestamp })
        .where(inArray(bankTransactions.id, chunk)).run();
      suggestionsSuperseded += tx.update(documentMatches).set({
        decision: 'superseded', decidedAt: timestamp, decidedBy: actor,
        decisionReason: `The statement import was undone: ${reason}`, updatedAt: timestamp,
      }).where(and(inArray(documentMatches.bankTransactionId, chunk), eq(documentMatches.decision, 'pending')))
        .run().changes;
    }
    tx.update(statementImports).set({ status: 'reversed', updatedAt: timestamp })
      .where(eq(statementImports.id, run.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'statement_import',
      entityId: run.id,
      action: 'import_reversed',
      previousValue: JSON.stringify({ status: run.status }),
      newValue: JSON.stringify({ status: 'reversed', linesRolledBack: lines.length }),
      reason,
      source: 'user',
      actor,
      requestId: params.requestId ?? null,
    }).run();
  });

  return { importId: run.id, linesRolledBack: lines.length, suggestionsSuperseded };
}

/** Every statement import for a company, newest first, with its account (the import history). */
export function listStatementImports(db: AppDatabase, companyId: string) {
  return db.select({
    id: statementImports.id,
    createdAt: statementImports.createdAt,
    filename: statementImports.filename,
    fileFormat: statementImports.fileFormat,
    status: statementImports.status,
    statementStartDate: statementImports.statementStartDate,
    statementEndDate: statementImports.statementEndDate,
    rowsRead: statementImports.rowsRead,
    rowsImported: statementImports.rowsImported,
    rowsDuplicate: statementImports.rowsDuplicate,
    rowsFailed: statementImports.rowsFailed,
    importedBy: statementImports.importedBy,
    bankAccountId: statementImports.bankAccountId,
    bankName: bankAccounts.bankName,
    accountName: bankAccounts.accountName,
  }).from(statementImports)
    .innerJoin(bankAccounts, eq(bankAccounts.id, statementImports.bankAccountId))
    .where(eq(statementImports.companyId, companyId))
    .orderBy(desc(statementImports.createdAt)).all();
}

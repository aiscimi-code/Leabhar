import Papa from 'papaparse';
import { parseAmount, MoneyError, isAmbiguousAmount } from '../money';
import { parseDateFlexible, DateError, type IsoDate } from '../dates';
import { transactionFingerprint, normaliseDescription } from './fingerprint';

/**
 * Bank statement parsing (README §13).
 *
 * Deliberately no live banking API. The user maps columns once per bank and the
 * mapping is remembered; unfamiliar formats are guessed at and the guess is
 * shown for confirmation rather than applied silently.
 */

export type DomainField =
  | 'transaction_date' | 'value_date' | 'description' | 'amount'
  | 'debit' | 'credit' | 'currency' | 'bank_reference' | 'bank_transaction_id'
  | 'balance' | 'counterparty_name' | 'counterparty_iban' | 'transaction_type'
  | 'base_amount' | 'ignore';

export interface ColumnMapping {
  [sourceColumn: string]: DomainField;
}

export interface ParseOptions {
  bankAccountId: string;
  columnMap: ColumnMapping;
  defaultCurrency: string;
  dateFormat?: 'day_first' | 'month_first' | 'iso';
  decimalSeparator?: '.' | ',';
  amountStyle?: 'signed' | 'debit_credit_columns' | 'amount_with_indicator';
  /** Some banks report money out as a positive number. */
  invertAmountSign?: boolean;
  skipRows?: number;
  delimiter?: string;
}

export interface ParsedTransaction {
  rowNumber: number;
  transactionDate: IsoDate;
  valueDate: IsoDate | null;
  description: string;
  amountMinor: number;
  currency: string;
  /** The settled (base-currency) amount, when the statement reports both. */
  baseAmountMinor: number | null;
  balanceAfterMinor: number | null;
  bankReference: string | null;
  bankTransactionId: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  transactionType: string | null;
  fingerprint: string;
  rawData: Record<string, string>;
}

export interface RowError {
  rowNumber: number;
  message: string;
  raw: Record<string, string>;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  errors: RowError[];
  warnings: string[];
  headers: string[];
  rowsRead: number;
}

/**
 * Column name patterns, ordered most to least specific. Used only to *propose*
 * a mapping: README §13 requires the user be able to map columns, so a guess is
 * always shown for confirmation rather than applied.
 */
const COLUMN_PATTERNS: Array<{ field: DomainField; patterns: RegExp[] }> = [
  { field: 'bank_transaction_id', patterns: [/^transaction\s*id$/i, /^tx\s*id$/i, /^unique\s*id$/i, /^bank\s*id$/i] },
  { field: 'value_date', patterns: [/value\s*date/i, /^settle(ment)?\s*date$/i] },
  { field: 'transaction_date', patterns: [/^(transaction|posting|booking|completed)\s*date$/i, /^date$/i, /date/i] },
  { field: 'debit', patterns: [/^debit(\s*amount)?$/i, /^money\s*out$/i, /^paid\s*out$/i, /^withdrawal(s)?$/i, /^out$/i] },
  { field: 'credit', patterns: [/^credit(\s*amount)?$/i, /^money\s*in$/i, /^paid\s*in$/i, /^deposit(s)?$/i, /^in$/i] },
  { field: 'amount', patterns: [/^amount$/i, /^transaction\s*amount$/i, /^value$/i, /amount/i] },
  { field: 'base_amount', patterns: [/^settle(d)?\s*amount$/i, /^charged\s*amount$/i, /^euro?\s*amount$/i, /^base\s*amount$/i, /^settle(d)?\s*value$/i] },
  { field: 'balance', patterns: [/^(running\s*)?balance$/i, /balance/i] },
  { field: 'currency', patterns: [/^currency$/i, /^ccy$/i, /currency/i] },
  { field: 'bank_reference', patterns: [/^reference$/i, /^ref$/i, /reference/i] },
  { field: 'counterparty_iban', patterns: [/iban/i] },
  { field: 'counterparty_name', patterns: [/^(counterparty|payee|merchant|beneficiary)(\s*name)?$/i] },
  { field: 'transaction_type', patterns: [/^(transaction\s*)?type$/i, /^category$/i] },
  { field: 'description', patterns: [/^description$/i, /^details$/i, /^narrative$/i, /^memo$/i, /description|details|narrative/i] },
];

/**
 * Propose a column mapping for an unfamiliar statement.
 * Returns the guess plus a confidence per column so the UI can highlight the
 * ones worth checking.
 */
export function proposeColumnMapping(headers: string[]): {
  mapping: ColumnMapping;
  confidence: Record<string, number>;
  unmapped: string[];
} {
  const mapping: ColumnMapping = {};
  const confidence: Record<string, number> = {};
  const taken = new Set<DomainField>();

  for (const { field, patterns } of COLUMN_PATTERNS) {
    if (taken.has(field)) continue;
    for (const [patternIndex, pattern] of patterns.entries()) {
      const header = headers.find((h) => !(h in mapping) && pattern.test(h.trim()));
      if (header) {
        mapping[header] = field;
        // An exact match on the first pattern is a strong signal; a loose
        // substring match on the last is a weak one.
        confidence[header] = Math.max(50, 100 - patternIndex * 20);
        taken.add(field);
        break;
      }
    }
  }

  const unmapped = headers.filter((h) => !(h in mapping));
  return { mapping, confidence, unmapped };
}

/** A stable signature for a file's headers, so a known format is recognised. */
export function headerSignature(headers: string[]): string {
  return headers.map((h) => normaliseDescription(h)).join('|');
}

export function parseCsv(content: string, options: ParseOptions): ParseResult {
  const skip = options.skipRows ?? 0;
  const body = skip > 0 ? content.split(/\r?\n/).slice(skip).join('\n') : content;

  const parsed = Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: options.delimiter ?? '',
    transformHeader: (h) => h.trim(),
  });

  const headers = parsed.meta.fields ?? [];
  return buildResult(parsed.data, headers, options);
}

/** Shared by CSV and XLSX once both are reduced to rows of strings. */
export function buildResult(
  rows: Array<Record<string, string>>,
  headers: string[],
  options: ParseOptions,
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];
  const warnings: string[] = [];

  const reverse = invertMapping(options.columnMap);
  const dayFirst = (options.dateFormat ?? 'day_first') !== 'month_first';
  const amountStyle = options.amountStyle ?? 'signed';

  if (!reverse.transaction_date) {
    warnings.push('No column is mapped to the transaction date. Every row will fail.');
  }
  if (amountStyle === 'signed' && !reverse.amount) {
    warnings.push('No column is mapped to the amount. Every row will fail.');
  }
  if (amountStyle === 'debit_credit_columns' && !reverse.debit && !reverse.credit) {
    warnings.push('No debit or credit column is mapped. Every row will fail.');
  }

  let ambiguousAmounts = 0;

  for (const [index, raw] of rows.entries()) {
    const rowNumber = index + 1;
    try {
      const currency = (pick(raw, reverse.currency) || options.defaultCurrency).toUpperCase();

      const dateText = pick(raw, reverse.transaction_date);
      if (!dateText) throw new Error('No transaction date in this row.');
      const transactionDate = parseDateFlexible(dateText, dayFirst);

      const valueDateText = pick(raw, reverse.value_date);
      const valueDate = valueDateText ? parseDateFlexible(valueDateText, dayFirst) : null;

      const description = pick(raw, reverse.description)
        || pick(raw, reverse.counterparty_name)
        || pick(raw, reverse.transaction_type)
        || '(no description)';

      let amountMinor: number;
      if (amountStyle === 'debit_credit_columns') {
        const debitText = pick(raw, reverse.debit);
        const creditText = pick(raw, reverse.credit);
        const debit = debitText ? parseAmount(debitText, currency, { decimalSeparator: options.decimalSeparator }) : 0;
        const credit = creditText ? parseAmount(creditText, currency, { decimalSeparator: options.decimalSeparator }) : 0;
        if (debit !== 0 && credit !== 0) {
          throw new Error(
            `Row has both a debit (${debitText}) and a credit (${creditText}). `
              + 'Only one can apply to a single statement line.',
          );
        }
        if (debit === 0 && credit === 0) throw new Error('Row has neither a debit nor a credit amount.');
        // Debit column means money out of the account.
        amountMinor = debit !== 0 ? -Math.abs(debit) : Math.abs(credit);
      } else {
        const amountText = pick(raw, reverse.amount);
        if (!amountText) throw new Error('No amount in this row.');
        if (isAmbiguousAmount(amountText, currency)) ambiguousAmounts += 1;
        amountMinor = parseAmount(amountText, currency, {
          decimalSeparator: options.decimalSeparator,
        });
      }

      if (options.invertAmountSign) amountMinor = -amountMinor;

      // The settled (base-currency) amount, when a multi-currency statement
      // reports both the foreign amount and what the bank actually charged in
      // the account's currency. Optional — most statements do not carry one.
      const baseAmountText = pick(raw, reverse.base_amount);
      const baseAmountMinor = baseAmountText
        ? parseAmount(baseAmountText, currency, { decimalSeparator: options.decimalSeparator })
        : null;

      const balanceText = pick(raw, reverse.balance);
      const balanceAfterMinor = balanceText
        ? parseAmount(balanceText, currency, { decimalSeparator: options.decimalSeparator })
        : null;

      const bankReference = pick(raw, reverse.bank_reference) || null;
      const bankTransactionId = pick(raw, reverse.bank_transaction_id) || null;

      transactions.push({
        rowNumber,
        transactionDate,
        valueDate,
        description,
        amountMinor,
        currency,
        baseAmountMinor,
        balanceAfterMinor,
        bankReference,
        bankTransactionId,
        counterpartyName: pick(raw, reverse.counterparty_name) || null,
        counterpartyIban: pick(raw, reverse.counterparty_iban) || null,
        transactionType: pick(raw, reverse.transaction_type) || null,
        fingerprint: transactionFingerprint({
          bankAccountId: options.bankAccountId,
          transactionDate,
          amountMinor,
          currency,
          description,
          bankReference,
          bankTransactionId,
        }),
        rawData: raw,
      });
    } catch (error) {
      errors.push({
        rowNumber,
        message: error instanceof MoneyError || error instanceof DateError
          ? error.message
          : (error as Error).message,
        raw,
      });
    }
  }

  if (ambiguousAmounts > 0) {
    warnings.push(
      `${ambiguousAmounts} amount${ambiguousAmounts === 1 ? '' : 's'} could be read either as `
        + 'a decimal point or as a thousands separator (for example "1.005"). They have been '
        + 'read as thousands separators. Set the decimal separator explicitly in the import '
        + 'profile if that is wrong.',
    );
  }

  return { transactions, errors, warnings, headers, rowsRead: rows.length };
}

function invertMapping(map: ColumnMapping): Partial<Record<DomainField, string>> {
  const reverse: Partial<Record<DomainField, string>> = {};
  for (const [column, field] of Object.entries(map)) {
    if (field !== 'ignore' && !reverse[field]) reverse[field] = column;
  }
  return reverse;
}

function pick(row: Record<string, string>, column: string | undefined): string {
  if (!column) return '';
  const value = row[column];
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Read the header row of a CSV without parsing the whole file. */
export function readCsvHeaders(content: string, skipRows = 0, delimiter?: string): string[] {
  const body = skipRows > 0 ? content.split(/\r?\n/).slice(skipRows).join('\n') : content;
  const parsed = Papa.parse<string[]>(body, {
    preview: 1, delimiter: delimiter ?? '', skipEmptyLines: true,
  });
  return (parsed.data[0] ?? []).map((h) => String(h).trim());
}

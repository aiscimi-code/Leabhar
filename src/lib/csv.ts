import { formatAmount } from '@/domain/money';

/**
 * CSV writing and the export column type, free of Next.js so the CLI can use
 * them too (issue #387). `exports.ts` re-exports these for the routes.
 */

export interface ExportColumn<T> {
  header: string;
  width?: number;
  /** Return a string for text, a number for an amount, null for blank. */
  value: (row: T) => string | number | null;
  /** Amount columns are right-aligned and formatted to the currency's places. */
  money?: boolean;
}

export function amountFor(minor: number | null | undefined, currency = 'EUR'): number | null {
  if (minor === null || minor === undefined) return null;
  return Number(formatAmount(minor, currency));
}

/** RFC 4180 CSV. Quotes everything that could otherwise be misread. */
export function toCsv<T>(rows: T[], columns: Array<ExportColumn<T>>): string {
  const escape = (value: string | number | null): string => {
    if (value === null) return '';
    const text = String(value);
    // A leading =, +, - or @ is interpreted as a formula by spreadsheet
    // applications. Prefixing with a quote stops an exported description
    // becoming executable when the file is opened.
    // Only text is neutralised: an amount column writes a number, and a
    // negative amount must stay a number rather than become the text '-12.30.
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const lines = [columns.map((column) => escape(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(column.value(row))).join(','));
  }
  // A BOM so Excel opens UTF-8 correctly on Windows.
  return `﻿${lines.join('\r\n')}\r\n`;
}

import ExcelJS from 'exceljs';
import { NextResponse } from 'next/server';
import { formatAmount } from '@/domain/money';

/**
 * Export helpers (README §38).
 *
 * Excel is an export format, not the accounting system. Two rules follow, and
 * both are deliberate:
 *
 *  - No cell contains a formula. Every figure is written as a value taken from
 *    the domain layer, so a spreadsheet can never disagree with the books by
 *    recalculating something differently.
 *  - Amounts are written as numbers, not strings, so they sort and total
 *    correctly in the user's own spreadsheet — but they are converted from
 *    minor units at the boundary, never held as floats anywhere else.
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
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const lines = [columns.map((column) => escape(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(column.value(row))).join(','));
  }
  // A BOM so Excel opens UTF-8 correctly on Windows.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvResponse(filename: string, body: string): Response {
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

export interface SheetSpec<T> {
  name: string;
  /** Rows above the header, for titles and context. */
  preamble?: Array<Array<string | number | null>>;
  columns: Array<ExportColumn<T>>;
  rows: T[];
  /** Appended below the table, for totals and caveats. */
  footer?: Array<Array<string | number | null>>;
}

export function addSheet<T>(workbook: ExcelJS.Workbook, spec: SheetSpec<T>): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(spec.name.slice(0, 31));

  for (const line of spec.preamble ?? []) {
    const row = sheet.addRow(line);
    if (line[0] && typeof line[0] === 'string') row.font = { bold: true };
  }
  if (spec.preamble && spec.preamble.length > 0) sheet.addRow([]);

  const headerRow = sheet.addRow(spec.columns.map((c) => c.header));
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: 'thin' } };

  spec.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width ?? 18;
  });

  for (const item of spec.rows) {
    const values = spec.columns.map((column) => column.value(item));
    const row = sheet.addRow(values);
    spec.columns.forEach((column, index) => {
      if (column.money) {
        const cell = row.getCell(index + 1);
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  for (const line of spec.footer ?? []) {
    const row = sheet.addRow(line);
    row.font = { bold: true };
    row.alignment = { wrapText: true, vertical: 'top' };
  }

  return sheet;
}

export function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Leabhar';
  workbook.created = new Date();
  return workbook;
}

export async function xlsxResponse(
  workbook: ExcelJS.Workbook, filename: string,
): Promise<Response> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** A cover sheet saying what this is and what it is not. */
export function addCoverSheet(workbook: ExcelJS.Workbook, params: {
  title: string;
  companyName: string;
  period: string;
  currency: string;
  extra?: Array<[string, string]>;
  caveat?: string;
}): void {
  const sheet = workbook.addWorksheet('Cover');
  sheet.columns = [{ width: 30 }, { width: 70 }];

  sheet.addRow([params.title, '']).font = { bold: true, size: 14 };
  sheet.addRow([]);
  sheet.addRow(['Company', params.companyName]);
  sheet.addRow(['Period', params.period]);
  sheet.addRow(['Currency', params.currency]);
  sheet.addRow(['Exported', new Date().toISOString()]);
  for (const [label, value] of params.extra ?? []) sheet.addRow([label, value]);

  sheet.addRow([]);
  const caveatRow = sheet.addRow([
    'Important',
    params.caveat
      ?? 'Exported from the accounting records in this application. Figures are values, not '
        + 'formulas, so this file cannot recalculate to something different from the books. '
        + 'It is a bookkeeping export, and nothing in it asserts compliance with any filing '
        + 'requirement.',
  ]);
  caveatRow.alignment = { wrapText: true, vertical: 'top' };
  caveatRow.height = 60;
}

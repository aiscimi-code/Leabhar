import { reportsData, requireCompany } from '@/lib/queries';
import { asIsoDate } from '@/domain/dates';
import type { Explained } from '@/domain/reports/explain';
import {
  newWorkbook, addSheet, addCoverSheet, xlsxResponse, toCsv, csvResponse,
  amountFor, type ExportColumn,
} from '@/lib/exports';

export const dynamic = 'force-dynamic';

interface FlatLine { label: string; amountMinor: number; depth: number; isTotal: boolean }

/**
 * Profit and loss, balance sheet and trial balance exports (README §38).
 *
 * Section subtotals and their components are both written, indented, so the
 * exported file reads the same way the screen does. No cell is a formula: a
 * spreadsheet that recalculates could disagree with the books.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const which = url.searchParams.get('which') ?? 'all';
  const format = url.searchParams.get('format') ?? 'xlsx';
  const company = requireCompany();
  const currency = company.baseCurrency;

  const from = asIsoDate(url.searchParams.get('from') ?? `${new Date().getFullYear()}-01-01`);
  const to = asIsoDate(url.searchParams.get('to') ?? `${new Date().getFullYear()}-12-31`);
  const data = reportsData(from, to, from);

  const flatten = (figure: Explained, depth = 0, isTotal = false): FlatLine[] => [
    { label: `${'  '.repeat(depth)}${figure.label}`, amountMinor: figure.valueMinor, depth, isTotal },
    ...figure.components
      .filter((c) => c.components.length === 0)
      .map((c) => ({
        label: `${'  '.repeat(depth + 1)}${c.label}`,
        amountMinor: c.valueMinor, depth: depth + 1, isTotal: false,
      })),
  ];

  const profitAndLossLines: FlatLine[] = [
    ...flatten(data.profitAndLoss.revenue),
    ...flatten(data.profitAndLoss.costOfSales),
    { label: 'Gross profit', amountMinor: data.profitAndLoss.grossProfit.valueMinor, depth: 0, isTotal: true },
    ...flatten(data.profitAndLoss.operatingExpenses),
    { label: 'Operating profit', amountMinor: data.profitAndLoss.operatingProfit.valueMinor, depth: 0, isTotal: true },
    ...flatten(data.profitAndLoss.otherIncome),
    { label: 'Net profit', amountMinor: data.profitAndLoss.netProfit.valueMinor, depth: 0, isTotal: true },
  ];

  const balanceSheetLines: FlatLine[] = [
    ...flatten(data.balanceSheet.fixedAssets),
    ...flatten(data.balanceSheet.currentAssets),
    { label: 'Total assets', amountMinor: data.balanceSheet.totalAssets.valueMinor, depth: 0, isTotal: true },
    ...flatten(data.balanceSheet.currentLiabilities),
    { label: 'Net assets', amountMinor: data.balanceSheet.netAssets.valueMinor, depth: 0, isTotal: true },
    { label: 'Share capital', amountMinor: data.balanceSheet.shareCapital.valueMinor, depth: 0, isTotal: false },
    { label: 'Retained earnings', amountMinor: data.balanceSheet.retainedEarnings.valueMinor, depth: 0, isTotal: false },
    { label: 'Profit for the period', amountMinor: data.balanceSheet.profitForPeriod.valueMinor, depth: 0, isTotal: false },
    { label: 'Total equity', amountMinor: data.balanceSheet.totalEquity.valueMinor, depth: 0, isTotal: true },
  ];

  const reportColumns: Array<ExportColumn<FlatLine>> = [
    { header: 'Line', width: 48, value: (r) => r.label },
    { header: `Amount (${currency})`, width: 18, money: true,
      value: (r) => amountFor(r.amountMinor, currency) },
  ];

  type TrialRow = (typeof data.trialBalance.rows)[number];
  const trialColumns: Array<ExportColumn<TrialRow>> = [
    { header: 'Code', width: 10, value: (r) => r.code },
    { header: 'Account', width: 40, value: (r) => r.name },
    { header: 'Type', width: 14, value: (r) => r.type },
    { header: 'Lines', width: 10, value: (r) => r.lineCount },
    { header: `Debit (${currency})`, width: 16, money: true,
      value: (r) => (r.netDebitMinor > 0 ? amountFor(r.netDebitMinor, currency) : null) },
    { header: `Credit (${currency})`, width: 16, money: true,
      value: (r) => (r.netDebitMinor < 0 ? amountFor(-r.netDebitMinor, currency) : null) },
  ];

  if (format === 'csv') {
    if (which === 'trial-balance') {
      return csvResponse('trial-balance.csv', toCsv(data.trialBalance.rows, trialColumns));
    }
    const lines = which === 'balance-sheet' ? balanceSheetLines : profitAndLossLines;
    return csvResponse(`${which === 'balance-sheet' ? 'balance-sheet' : 'profit-and-loss'}.csv`,
      toCsv(lines, reportColumns));
  }

  const workbook = newWorkbook();
  addCoverSheet(workbook, {
    title: 'Financial statements',
    companyName: company.legalName,
    period: `${from} to ${to}`,
    currency,
    extra: [
      ['Balance sheet balances', data.balanceSheet.balances ? 'Yes' : 'NO — investigate'],
      ['Trial balance balances', data.trialBalance.balanced ? 'Yes' : 'NO — investigate'],
    ],
  });

  if (which === 'all' || which === 'profit-and-loss') {
    addSheet(workbook, {
      name: 'Profit and loss',
      preamble: [[`Profit and loss account`], [`${from} to ${to}`]],
      columns: reportColumns,
      rows: profitAndLossLines,
      footer: [[], ['This is accounting profit. Taxable profit is a different figure — see '
        + 'the year-end pack for the bridge between them.']],
    });
  }

  if (which === 'all' || which === 'balance-sheet') {
    addSheet(workbook, {
      name: 'Balance sheet',
      preamble: [['Balance sheet'], [`As at ${to}`]],
      columns: reportColumns,
      rows: balanceSheetLines,
      footer: data.balanceSheet.balances
        ? [[], ['Net assets equal total equity.']]
        : [[], ['THE BALANCE SHEET DOES NOT BALANCE. Difference: '
            + `${amountFor(data.balanceSheet.differenceMinor, currency)}. `
            + 'This is a defect in the underlying entries — do not rely on these figures.']],
    });
  }

  if (which === 'all' || which === 'trial-balance') {
    addSheet(workbook, {
      name: 'Trial balance',
      preamble: [['Trial balance'], [`As at ${to}`]],
      columns: trialColumns,
      rows: data.trialBalance.rows,
      footer: [[], [
        data.trialBalance.balanced ? 'Debits equal credits.' : 'DEBITS DO NOT EQUAL CREDITS.',
        '', '',
        amountFor(data.trialBalance.rows.reduce((s, r) => s + Math.max(r.netDebitMinor, 0), 0), currency),
        amountFor(data.trialBalance.rows.reduce((s, r) => s + Math.max(-r.netDebitMinor, 0), 0), currency),
      ]],
    });
  }

  return xlsxResponse(workbook, `financial-statements-${to}.xlsx`);
}

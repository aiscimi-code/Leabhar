import { reportsData, reportsAnalysis, requireCompany } from '@/lib/queries';
import { requireApiActor } from '@/lib/apiAuth';
import { mappedTrialBalance } from '@/domain/config/accountMappings';
import { asIsoDate } from '@/domain/dates';
import {
  profitAndLossBlock, balanceSheetBlock, cashFlowBlock, trialBalanceBlock, comparativeBlock, type StatementBlock, type StatementLine,
} from '@/lib/statementLines';
import { renderStatementsPdf } from '@/lib/statementsPdf';
import {
  newWorkbook, addSheet, addCoverSheet, xlsxResponse, toCsv, csvResponse,
  amountFor, type ExportColumn,
} from '@/lib/exports';
import { getDb } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * Profit and loss, balance sheet, cash flow and trial balance exports
 * (README §38), with comparatives, income and expense analysis and the stock
 * valuation (issue #553), as XLSX, CSV or PDF.
 *
 * Section subtotals and their components are both written, indented, so the
 * exported file reads the same way the screen does. No cell is a formula: a
 * spreadsheet that recalculates could disagree with the books.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = await requireApiActor('reports.export');
  if (refused) return refused;

  const url = new URL(request.url);
  const which = url.searchParams.get('which') ?? 'all';
  const format = url.searchParams.get('format') ?? 'xlsx';
  const company = requireCompany();
  const currency = company.baseCurrency;

  const from = asIsoDate(url.searchParams.get('from') ?? `${new Date().getFullYear()}-01-01`);
  const to = asIsoDate(url.searchParams.get('to') ?? `${new Date().getFullYear()}-12-31`);
  const data = reportsData(from, to, from);

  const analysis = reportsAnalysis(from, to);
  const blocks = {
    'profit-and-loss': profitAndLossBlock(data.profitAndLoss),
    'balance-sheet': balanceSheetBlock(data.balanceSheet),
    'cash-flow': cashFlowBlock(analysis.cashFlow),
    'trial-balance': trialBalanceBlock(data.trialBalance, currency),
    'comparative-profit-and-loss': comparativeBlock('Profit and loss, with comparatives', analysis.comparatives.profitAndLoss,
      `${from} to ${to}`, `${analysis.comparatives.prior.from} to ${analysis.comparatives.prior.to}`, currency),
    'comparative-balance-sheet': comparativeBlock('Balance sheet, with comparatives', analysis.comparatives.balanceSheet,
      `at ${to}`, `at ${analysis.comparatives.prior.to}`, currency),
  } as const;
  type BlockKey = keyof typeof blocks;
  const blockColumns = (block: StatementBlock): Array<ExportColumn<StatementLine>> => [
    { header: 'Line', width: 52, value: (r) => `${'  '.repeat(r.depth)}${r.label}` },
    ...block.columns.map((header, i): ExportColumn<StatementLine> => ({ header, width: 18, money: true, value: (r) => amountFor(r.values[i], currency) })),
  ];
  const addBlockSheet = (workbook: ReturnType<typeof newWorkbook>, name: string, block: StatementBlock) => addSheet(workbook, {
    name, preamble: [[block.title], [block.subtitle]], columns: blockColumns(block), rows: block.lines,
    footer: [[], ...block.notes.map((n) => [n])],
  });

  // PDF (issue #553): the statements and the trial balance, from the same blocks.
  if (format === 'pdf') {
    const keys: BlockKey[] = which === 'all' ? ['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance']
      : which === 'comparatives' ? ['comparative-profit-and-loss', 'comparative-balance-sheet']
      : which in blocks ? [which as BlockKey] : [];
    if (keys.length === 0) return new Response(`No PDF for ${which}.`, { status: 400 });
    const bytes = await renderStatementsPdf({
      companyName: company.legalName, period: `${from} to ${to}`, currency, generatedOn: new Date().toISOString().slice(0, 10),
      blocks: keys.map((k) => blocks[k]),
    });
    return new Response(Buffer.from(bytes), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${which === 'all' ? 'financial-statements' : which}-${to}.pdf"` },
    });
  }

  type MonthRow = (typeof analysis.byMonth.income)[number];
  const monthColumns: Array<ExportColumn<MonthRow>> = [
    { header: 'Code', width: 10, value: (r) => r.code },
    { header: 'Account', width: 36, value: (r) => r.name },
    ...analysis.byMonth.months.map((m, i): ExportColumn<MonthRow> => ({ header: m, width: 13, money: true, value: (r) => amountFor(r.byMonthMinor[i], currency) })),
    { header: 'Total', width: 15, money: true, value: (r) => amountFor(r.totalMinor, currency) },
  ];
  type PartyRow = (typeof analysis.byCustomer.rows)[number];
  const partyColumns: Array<ExportColumn<PartyRow>> = [
    { header: 'Name', width: 40, value: (r) => r.name },
    { header: 'Invoices', width: 10, value: (r) => r.invoiceCount },
    { header: 'Credit notes', width: 12, value: (r) => r.creditNoteCount },
    { header: `Net (${currency})`, width: 16, money: true, value: (r) => amountFor(r.netMinor, currency) },
    { header: `VAT (${currency})`, width: 16, money: true, value: (r) => amountFor(r.vatMinor, currency) },
    { header: `Gross (${currency})`, width: 16, money: true, value: (r) => amountFor(r.grossMinor, currency) },
  ];
  type StockRow = (typeof analysis.inventory.lines)[number];
  const stockColumns: Array<ExportColumn<StockRow>> = [
    { header: 'Item', width: 12, value: (r) => r.code },
    { header: 'Name', width: 36, value: (r) => r.name },
    { header: 'Location', width: 12, value: (r) => r.locationCode },
    { header: 'Quantity', width: 12, value: (r) => r.quantityMilli / 1000 },
    { header: 'Unit', width: 8, value: (r) => r.unit },
    { header: 'Method', width: 16, value: (r) => r.method },
    { header: `Value (${currency})`, width: 16, money: true, value: (r) => amountFor(r.valueMinor, currency) },
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

  // The trial balance restated in an external chart's codes (issue #362).
  if (which === 'mapped-trial-balance') {
    const chartName = url.searchParams.get('chart') ?? '';
    const tb = mappedTrialBalance(getDb(), { companyId: company.id, chartName, asOf: to });
    const columns: Array<ExportColumn<(typeof tb.rows)[number]>> = [
      { header: 'External code', width: 14, value: (r) => r.externalCode ?? '' },
      { header: 'External name', width: 40, value: (r) => r.externalName ?? r.name },
      { header: 'Leabhar code', width: 12, value: (r) => r.code },
      { header: 'Leabhar account', width: 40, value: (r) => r.name },
      { header: 'Type', width: 12, value: (r) => r.type },
      { header: `Debit (${currency})`, width: 16, money: true,
        value: (r) => (r.debitMinor > r.creditMinor ? amountFor(r.debitMinor - r.creditMinor, currency) : null) },
      { header: `Credit (${currency})`, width: 16, money: true,
        value: (r) => (r.creditMinor > r.debitMinor ? amountFor(r.creditMinor - r.debitMinor, currency) : null) },
    ];

    if (format === 'csv') {
      return csvResponse(`mapped-trial-balance-${chartName || 'chart'}.csv`, toCsv(tb.rows, columns));
    }

    const workbook = newWorkbook();
    addCoverSheet(workbook, {
      title: 'Mapped trial balance',
      companyName: company.legalName,
      period: `As at ${to}`,
      currency,
      extra: [
        ['External chart', chartName],
        ['Balances', tb.totalDebitMinor === tb.totalCreditMinor ? 'Debits equal credits' : 'DOES NOT BALANCE — investigate'],
        ...tb.unmapped.length > 0
          ? [[`Accounts with balances but no mapping (${tb.unmapped.length})`,
              tb.unmapped.map((u) => `${u.code} ${u.name}`).join(', ')] as [string, string]]
          : [],
      ],
    });
    addSheet(workbook, {
      name: 'Mapped trial balance',
      preamble: [['Mapped trial balance'], [`External chart: ${chartName}`], [`As at ${to}`]],
      columns,
      rows: tb.rows,
      footer: [[], [
        tb.totalDebitMinor === tb.totalCreditMinor ? 'Debits equal credits.' : 'DEBITS DO NOT EQUAL CREDITS.',
        '', '',
        amountFor(tb.totalDebitMinor, currency),
        amountFor(tb.totalCreditMinor, currency),
      ]],
    });
    return xlsxResponse(workbook, `mapped-trial-balance-${to}.xlsx`);
  }

  if (format === 'csv') {
    if (which === 'trial-balance') {
      return csvResponse('trial-balance.csv', toCsv(data.trialBalance.rows, trialColumns));
    }
    if (which === 'income-expense') return csvResponse('income-and-expense-by-month.csv', toCsv([...analysis.byMonth.income, ...analysis.byMonth.expenses], monthColumns));
    if (which === 'by-customer') return csvResponse('income-by-customer.csv', toCsv(analysis.byCustomer.rows, partyColumns));
    if (which === 'by-supplier') return csvResponse('expense-by-supplier.csv', toCsv(analysis.bySupplier.rows, partyColumns));
    if (which === 'inventory') return csvResponse('inventory.csv', toCsv(analysis.inventory.lines, stockColumns));
    const key: BlockKey = which === 'balance-sheet' || which === 'cash-flow' ? which
      : which === 'comparatives' ? 'comparative-profit-and-loss' : 'profit-and-loss';
    return csvResponse(`${key}.csv`, toCsv(blocks[key].lines, blockColumns(blocks[key])));
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
      ['Cash flow reconciles to bank and cash', analysis.cashFlow.reconciles ? 'Yes' : 'NO — investigate'],
    ],
  });

  const all = which === 'all';
  if (all || which === 'profit-and-loss') addBlockSheet(workbook, 'Profit and loss', blocks['profit-and-loss']);
  if (all || which === 'balance-sheet') addBlockSheet(workbook, 'Balance sheet', blocks['balance-sheet']);
  if (all || which === 'cash-flow') addBlockSheet(workbook, 'Cash flow', blocks['cash-flow']);
  if (all || which === 'comparatives') {
    addBlockSheet(workbook, 'P&L comparative', blocks['comparative-profit-and-loss']);
    addBlockSheet(workbook, 'Balance sheet comparative', blocks['comparative-balance-sheet']);
  }
  if (all || which === 'income-expense') {
    addSheet(workbook, { name: 'Income by month', preamble: [['Income by account by month'], [`${from} to ${to}`]], columns: monthColumns, rows: analysis.byMonth.income,
      footer: [[], ['Total income', '', ...analysis.byMonth.incomeByMonthMinor.map((m) => amountFor(m, currency)), amountFor(analysis.byMonth.totalIncomeMinor, currency)]] });
    addSheet(workbook, { name: 'Expenses by month', preamble: [['Expenses by account by month'], [`${from} to ${to}`]], columns: monthColumns, rows: analysis.byMonth.expenses,
      footer: [[], ['Total expenses', '', ...analysis.byMonth.expensesByMonthMinor.map((m) => amountFor(m, currency)), amountFor(analysis.byMonth.totalExpensesMinor, currency)],
        ['Net', '', ...analysis.byMonth.netByMonthMinor.map((m) => amountFor(m, currency)), amountFor(analysis.byMonth.netMinor, currency)]] });
  }
  if (all || which === 'by-customer') {
    addSheet(workbook, { name: 'Income by customer', preamble: [['Income by customer'], [`${from} to ${to}`]], columns: partyColumns, rows: analysis.byCustomer.rows,
      footer: [[], ['Total', analysis.byCustomer.total.invoiceCount, analysis.byCustomer.total.creditNoteCount, amountFor(analysis.byCustomer.total.netMinor, currency), amountFor(analysis.byCustomer.total.vatMinor, currency), amountFor(analysis.byCustomer.total.grossMinor, currency)], [analysis.byCustomer.method]] });
  }
  if (all || which === 'by-supplier') {
    addSheet(workbook, { name: 'Expense by supplier', preamble: [['Expense by supplier'], [`${from} to ${to}`]], columns: partyColumns, rows: analysis.bySupplier.rows,
      footer: [[], ['Total', analysis.bySupplier.total.invoiceCount, analysis.bySupplier.total.creditNoteCount, amountFor(analysis.bySupplier.total.netMinor, currency), amountFor(analysis.bySupplier.total.vatMinor, currency), amountFor(analysis.bySupplier.total.grossMinor, currency)], [analysis.bySupplier.method]] });
  }
  if ((all && analysis.inventory.lines.length > 0) || which === 'inventory') {
    addSheet(workbook, { name: 'Inventory', preamble: [['Stock valuation'], [`At ${to}`]], columns: stockColumns, rows: analysis.inventory.lines,
      footer: [[], ['Total', '', '', '', '', '', amountFor(analysis.inventory.totalMinor, currency)], [analysis.inventory.note]] });
  }
  if (all || which === 'trial-balance') {
    addSheet(workbook, {
      name: 'Trial balance',
      preamble: [['Trial balance'], [`As at ${to}`]],
      columns: trialColumns,
      rows: data.trialBalance.rows,
      footer: [[], [
        data.trialBalance.balanced ? 'Net debits equal net credits.' : 'NET DEBITS DO NOT EQUAL NET CREDITS.',
        '', '',
        amountFor(data.trialBalance.netTotalDebitMinor, currency),
        amountFor(data.trialBalance.netTotalCreditMinor, currency),
      ], [
        `Gross movement: ${amountFor(data.trialBalance.totalDebitMinor, currency)} debited, `
          + `${amountFor(data.trialBalance.totalCreditMinor, currency)} credited.`,
      ]],
    });
  }

  return xlsxResponse(workbook, `financial-statements-${to}.xlsx`);
}

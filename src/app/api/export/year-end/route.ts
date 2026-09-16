import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { yearEndPack } from '@/domain/reports/yearEnd';
import { asIsoDate } from '@/domain/dates';
import { trialBalance } from '@/domain/accounting/ledger';
import { formatAmount } from '@/domain/money';

export const dynamic = 'force-dynamic';

/**
 * Year-end pack as XLSX (README §34, §38).
 *
 * Excel is an export format, not the accounting system. Nothing here computes
 * anything: every figure is taken from the domain layer and written out, and no
 * cell contains a formula that could disagree with the books.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const company = requireCompany();
  const from = asIsoDate(url.searchParams.get('from') ?? `${new Date().getFullYear()}-01-01`);
  const to = asIsoDate(url.searchParams.get('to') ?? `${new Date().getFullYear()}-12-31`);

  const pack = yearEndPack(getDb(), { companyId: company.id, from, to });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Leabhar';
  workbook.created = new Date();

  const amount = (minor: number): number => Number(formatAmount(minor, pack.currency));

  // ---- Cover ----
  const cover = workbook.addWorksheet('Cover');
  cover.columns = [{ width: 34 }, { width: 52 }];
  cover.addRows([
    ['Year-end pack', ''],
    ['Company', pack.companyName],
    ['Period', `${from} to ${to}`],
    ['Currency', pack.currency],
    ['Generated', new Date().toISOString()],
    ['', ''],
    ['Important', 'This pack is prepared from the accounting records in this application. '
      + 'It is a preparation and bookkeeping output, not a statutory set of financial '
      + 'statements, and nothing in it asserts compliance with any filing requirement.'],
    ['Outstanding issues', String(pack.issues.length)],
  ]);
  cover.getRow(1).font = { bold: true, size: 14 };

  // ---- P&L ----
  const pl = workbook.addWorksheet('Profit and loss');
  pl.columns = [{ width: 40 }, { width: 18 }];
  pl.addRow(['Profit and loss account', '']).font = { bold: true, size: 12 };
  pl.addRow([`${from} to ${to}`, '']);
  pl.addRow([]);
  for (const section of [pack.profitAndLoss.revenue, pack.profitAndLoss.costOfSales]) {
    pl.addRow([section.label, amount(section.valueMinor)]).font = { bold: true };
    for (const component of section.components) {
      pl.addRow([`  ${component.label}`, amount(component.valueMinor)]);
    }
  }
  pl.addRow(['Gross profit', amount(pack.profitAndLoss.grossProfit.valueMinor)]).font = { bold: true };
  pl.addRow([pack.profitAndLoss.operatingExpenses.label,
             amount(pack.profitAndLoss.operatingExpenses.valueMinor)]).font = { bold: true };
  for (const component of pack.profitAndLoss.operatingExpenses.components) {
    pl.addRow([`  ${component.label}`, amount(component.valueMinor)]);
  }
  pl.addRow(['Net profit', amount(pack.profitAndLoss.netProfit.valueMinor)]).font = { bold: true };

  // ---- Balance sheet ----
  const bs = workbook.addWorksheet('Balance sheet');
  bs.columns = [{ width: 40 }, { width: 18 }];
  bs.addRow(['Balance sheet', '']).font = { bold: true, size: 12 };
  bs.addRow([`As at ${to}`, '']);
  bs.addRow([]);
  for (const section of [pack.balanceSheet.fixedAssets, pack.balanceSheet.currentAssets,
                         pack.balanceSheet.currentLiabilities]) {
    bs.addRow([section.label, amount(section.valueMinor)]).font = { bold: true };
    for (const component of section.components) {
      bs.addRow([`  ${component.label}`, amount(component.valueMinor)]);
    }
  }
  bs.addRow(['Net assets', amount(pack.balanceSheet.netAssets.valueMinor)]).font = { bold: true };
  bs.addRow([]);
  bs.addRow(['Share capital', amount(pack.balanceSheet.shareCapital.valueMinor)]);
  bs.addRow(['Retained earnings', amount(pack.balanceSheet.retainedEarnings.valueMinor)]);
  bs.addRow(['Profit for the period', amount(pack.balanceSheet.profitForPeriod.valueMinor)]);
  bs.addRow(['Total equity', amount(pack.balanceSheet.totalEquity.valueMinor)]).font = { bold: true };
  bs.addRow([]);
  bs.addRow(['Balances', pack.balanceSheet.balances ? 'Yes' : 'NO — investigate']);

  // ---- Trial balance ----
  const tb = workbook.addWorksheet('Trial balance');
  tb.columns = [
    { header: 'Code', width: 10 }, { header: 'Account', width: 40 },
    { header: 'Type', width: 14 }, { header: 'Debit', width: 16 }, { header: 'Credit', width: 16 },
  ];
  tb.getRow(1).font = { bold: true };
  const balances = trialBalance(getDb(), {
    companyId: company.id, asOf: to, baseCurrency: pack.currency,
  });
  for (const row of balances.rows) {
    tb.addRow([
      row.code, row.name, row.type,
      row.netDebitMinor > 0 ? amount(row.netDebitMinor) : '',
      row.netDebitMinor < 0 ? amount(-row.netDebitMinor) : '',
    ]);
  }
  const totalsRow = tb.addRow([
    '', 'Totals', '',
    amount(balances.rows.reduce((s, r) => s + Math.max(r.netDebitMinor, 0), 0)),
    amount(balances.rows.reduce((s, r) => s + Math.max(-r.netDebitMinor, 0), 0)),
  ]);
  totalsRow.font = { bold: true };
  if (!balances.balanced) {
    tb.addRow(['', 'DOES NOT BALANCE — investigate before relying on these figures', '', '', '']);
  }

  // ---- Tax computation ----
  const tax = workbook.addWorksheet('Tax computation');
  tax.columns = [{ width: 56 }, { width: 18 }];
  tax.addRow(['Corporation tax worksheet', '']).font = { bold: true, size: 12 };
  tax.addRow([]);
  tax.addRow(['Accounting profit', amount(pack.taxComputation.accountingProfitMinor)]).font = { bold: true };
  for (const adjustment of pack.taxComputation.adjustments) {
    tax.addRow([`  ${adjustment.label}`, amount(adjustment.amountMinor)]);
    tax.addRow([`    ${adjustment.explanation}`, '']);
  }
  tax.addRow(['Tax-adjusted profit', amount(pack.taxComputation.taxAdjustedProfitMinor)])
    .font = { bold: true };
  tax.addRow([]);
  const disclaimerRow = tax.addRow([pack.taxComputation.disclaimer, '']);
  disclaimerRow.alignment = { wrapText: true, vertical: 'top' };
  disclaimerRow.height = 90;

  // ---- Fixed assets ----
  const assets = workbook.addWorksheet('Fixed assets');
  assets.columns = [
    { header: 'Asset', width: 34 }, { header: 'Purchased', width: 14 },
    { header: 'Supplier', width: 28 }, { header: 'Cost', width: 14 },
    { header: 'Accumulated depreciation', width: 24 }, { header: 'Net book value', width: 16 },
    { header: 'Capital allowance rate', width: 20 }, { header: 'Years', width: 10 },
  ];
  assets.getRow(1).font = { bold: true };
  for (const asset of pack.fixedAssets) {
    assets.addRow([
      asset.name, asset.purchaseDate, asset.supplierName ?? '',
      amount(asset.costMinor), amount(asset.accumulatedDepreciationMinor),
      amount(asset.netBookValueMinor),
      `${asset.capitalAllowanceRateBasisPoints / 100}%`, asset.capitalAllowanceYears,
    ]);
  }

  // ---- VAT ----
  const vat = workbook.addWorksheet('VAT summary');
  vat.columns = [
    { header: 'Period', width: 20 }, { header: 'T1 VAT on sales', width: 18 },
    { header: 'T2 VAT on purchases', width: 20 }, { header: 'Net', width: 16 },
    { header: 'Status', width: 14 },
  ];
  vat.getRow(1).font = { bold: true };
  for (const period of pack.vatPeriods) {
    vat.addRow([
      period.name, amount(period.t1Minor), amount(period.t2Minor),
      amount(period.netMinor), period.status,
    ]);
  }

  // ---- Document index ----
  const docs = workbook.addWorksheet('Document index');
  docs.columns = [
    { header: 'File', width: 40 }, { header: 'Supplier', width: 28 },
    { header: 'Date', width: 14 }, { header: 'Total', width: 14 },
    { header: 'Matched', width: 10 }, { header: 'SHA-256', width: 68 },
  ];
  docs.getRow(1).font = { bold: true };
  for (const document of pack.documents) {
    docs.addRow([
      document.filename, document.supplierName ?? '', document.documentDate ?? '',
      document.grossMinor === null ? '' : amount(document.grossMinor),
      document.matched ? 'Yes' : 'No', document.sha256,
    ]);
  }

  // ---- Outstanding issues ----
  const issues = workbook.addWorksheet('Outstanding issues');
  issues.columns = [
    { header: 'Severity', width: 12 }, { header: 'Issue', width: 46 },
    { header: 'Detail', width: 80 },
  ];
  issues.getRow(1).font = { bold: true };
  for (const issue of pack.issues) {
    const row = issues.addRow([issue.severity, issue.title, issue.detail]);
    row.alignment = { wrapText: true, vertical: 'top' };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="year-end-${from}-to-${to}.xlsx"`,
    },
  });
}

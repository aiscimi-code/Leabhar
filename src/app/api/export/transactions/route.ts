import { ledgerRows, requireCompany } from '@/lib/queries';
import {
  newWorkbook, addSheet, addCoverSheet, xlsxResponse, toCsv, csvResponse,
  amountFor, type ExportColumn,
} from '@/lib/exports';

export const dynamic = 'force-dynamic';

type Row = ReturnType<typeof ledgerRows>[number];

/** Transaction ledger export (README §38). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const company = requireCompany();
  const currency = company.baseCurrency;

  const rows = ledgerRows({
    status: url.searchParams.get('status') ?? undefined,
    bankAccountId: url.searchParams.get('bankAccountId') ?? undefined,
    accountId: url.searchParams.get('accountId') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    limit: 100_000,
  });

  const columns: Array<ExportColumn<Row>> = [
    { header: 'Date', width: 12, value: (r) => r.transaction.transactionDate },
    { header: 'Description', width: 40, value: (r) => r.transaction.description },
    { header: 'Counterparty', width: 26,
      value: (r) => r.supplierName ?? r.customerName ?? r.transaction.counterpartyName ?? '' },
    { header: 'Reference', width: 20, value: (r) => r.transaction.bankReference ?? '' },
    { header: 'Amount', width: 14, money: true,
      value: (r) => amountFor(r.transaction.amountMinor, r.transaction.currency) },
    { header: 'Currency', width: 10, value: (r) => r.transaction.currency },
    { header: `Amount (${currency})`, width: 14, money: true,
      value: (r) => amountFor(r.transaction.baseAmountMinor ?? r.transaction.amountMinor, currency) },
    { header: 'Account code', width: 14, value: (r) => r.accountCode ?? '' },
    { header: 'Account', width: 30, value: (r) => r.accountName ?? '' },
    { header: 'VAT treatment', width: 30, value: (r) => r.treatmentName ?? '' },
    { header: `VAT (${currency})`, width: 14, money: true,
      value: (r) => amountFor(r.vatMinor ?? null, currency) },
    { header: 'Status', width: 14, value: (r) => r.transaction.status },
    { header: 'Set by', width: 18, value: (r) => r.transaction.provenanceStatus },
    { header: 'Document', width: 30, value: (r) => r.documentName ?? '' },
  ];

  if ((url.searchParams.get('format') ?? 'csv') === 'csv') {
    return csvResponse('transactions.csv', toCsv(rows, columns));
  }

  const workbook = newWorkbook();
  addCoverSheet(workbook, {
    title: 'Transaction ledger',
    companyName: company.legalName,
    period: `${url.searchParams.get('from') ?? 'all'} to ${url.searchParams.get('to') ?? 'all'}`,
    currency,
    extra: [['Transactions', String(rows.length)]],
  });
  addSheet(workbook, { name: 'Transactions', columns, rows });
  return xlsxResponse(workbook, 'transactions.xlsx');
}

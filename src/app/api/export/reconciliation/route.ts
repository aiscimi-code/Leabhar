import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { getDb } from '@/db';
import { asIsoDate } from '@/domain/dates';
import { parseAmount } from '@/domain/money';
import { reconciliationStatement, type StatementRow } from '@/domain/banking/reconciliationStatement';
import {
  newWorkbook, addSheet, addCoverSheet, xlsxResponse, toCsv, csvResponse,
  amountFor, type ExportColumn,
} from '@/lib/exports';

export const dynamic = 'force-dynamic';

/**
 * The bank reconciliation statement for one account and period (issue #387),
 * as CSV or XLSX. Values only, never formulas: every figure is the one the
 * reconciliation screen shows, from `reconciliationStatement`.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireActor('reports.export');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const url = new URL(request.url);
  const company = requireCompany();
  const currency = company.baseCurrency;
  const bankAccountId = url.searchParams.get('account');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!bankAccountId || !from || !to) {
    return new Response('account, from and to are required.', { status: 400 });
  }
  const statementBalance = url.searchParams.get('statementBalance');

  let statement;
  try {
    statement = reconciliationStatement(getDb(), {
      companyId: company.id, bankAccountId, periodStart: asIsoDate(from), periodEnd: asIsoDate(to),
      statementClosingBalanceMinor: statementBalance ? parseAmount(statementBalance, currency) : undefined,
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
  }
  const { result } = statement;

  const columns: Array<ExportColumn<StatementRow>> = [
    { header: 'Section', width: 44, value: (r) => r.section },
    { header: 'Date', width: 12, value: (r) => r.date },
    { header: 'Description', width: 44, value: (r) => r.description },
    { header: `Amount (${currency})`, width: 16, money: true, value: (r) => amountFor(r.amountMinor, currency) },
    { header: 'Explanation', width: 70, value: (r) => r.explanation },
  ];
  const slug = `reconciliation-${result.periodEnd}`;

  if (url.searchParams.get('format') === 'csv') {
    return csvResponse(`${slug}.csv`, toCsv(statement.rows, columns));
  }

  const workbook = newWorkbook();
  addCoverSheet(workbook, {
    title: 'Bank reconciliation statement',
    companyName: company.legalName,
    period: `${result.periodStart} to ${result.periodEnd}`,
    currency,
    extra: [
      ['Bank account', result.bankAccountName],
      ['Result', result.reconciled ? 'Reconciled' : 'NOT RECONCILED — see the unexplained difference'],
      ['Signed off', statement.signOff?.completedAt
        ? `${statement.signOff.completedAt}${statement.signOff.completedBy ? ` by ${statement.signOff.completedBy}` : ''}`
        : 'No'],
      ...result.warnings.map((w) => ['Warning', w] as [string, string]),
    ],
  });
  addSheet(workbook, {
    name: 'Reconciliation',
    preamble: [['Bank reconciliation statement'], [result.bankAccountName],
      [`${result.periodStart} to ${result.periodEnd}`]],
    columns,
    rows: statement.rows,
  });
  return xlsxResponse(workbook, `${slug}.xlsx`);
}
